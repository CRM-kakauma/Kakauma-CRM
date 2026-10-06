import { crmConfig, crmRpc, demoMode, env, keyHeaders } from "./supabase.server.ts";

/**
 * CRM login with Supabase Auth (e-mail + password) kept in httpOnly cookies.
 * The browser never holds tokens or keys; every API call is checked here:
 * valid session + an active row in crm.app_users with a role.
 */

export type Role = "admin" | "operator" | "viewer";
export interface Session {
  userId: string;
  email: string;
  role: Role;
  /** Set-Cookie headers to send back (token refresh). */
  setCookies: string[];
}

const AT = "crm_at";
const RT = "crm_rt";

function cookie(name: string, value: string, maxAge: number, secure: boolean) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function readCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (request: Request) => new URL(request.url).protocol === "https:";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string };
}

async function token(
  grant: "password" | "refresh_token",
  body: Record<string, string>,
): Promise<TokenResponse | null> {
  const { url, anonKey } = crmConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { ...keyHeaders(anonKey), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok ? ((await res.json()) as TokenResponse) : null;
}

async function userFromToken(accessToken: string): Promise<{ id: string; email: string } | null> {
  const { url, anonKey } = crmConfig();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as { id?: string; email?: string };
  return u.id && u.email ? { id: u.id, email: u.email } : null;
}

async function roleOf(userId: string, email: string): Promise<Role | null> {
  const { data, error } = await crmRpc("crm_user_role", { p_user_id: userId, p_email: email });
  if (error) throw new Error(error.message);
  return (data as Role | null) ?? null;
}

function sessionCookies(t: TokenResponse, secure: boolean) {
  return [
    cookie(AT, t.access_token, t.expires_in, secure),
    cookie(RT, t.refresh_token, 60 * 60 * 24 * 30, secure),
  ];
}

export function clearCookies(request: Request) {
  return [cookie(AT, "", 0, isHttps(request)), cookie(RT, "", 0, isHttps(request))];
}

export async function login(
  request: Request,
  email: string,
  password: string,
): Promise<
  { ok: true; session: Session } | { ok: false; error: "invalid_credentials" | "no_access" }
> {
  const t = await token("password", { email, password });
  if (!t) return { ok: false, error: "invalid_credentials" };
  const role = await roleOf(t.user.id, t.user.email);
  if (!role) return { ok: false, error: "no_access" };
  return {
    ok: true,
    session: {
      userId: t.user.id,
      email: t.user.email,
      role,
      setCookies: sessionCookies(t, isHttps(request)),
    },
  };
}

/**
 * Invite / password-recovery link from a Supabase Auth e-mail: the link carries
 * a short-lived access token. Sets the new password with it, then logs in.
 */
export async function setPasswordWithToken(
  request: Request,
  accessToken: string,
  password: string,
): Promise<
  | { ok: true; session: Session }
  | {
      ok: false;
      error: "invalid_link" | "weak_password" | "no_access";
      message?: string | undefined;
    }
> {
  const { url, anonKey } = crmConfig();
  const res = await fetch(`${url}/auth/v1/user`, {
    method: "PUT",
    headers: {
      ...keyHeaders(anonKey),
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      msg?: string;
      message?: string;
      error_code?: string;
    };
    const message = body.msg ?? body.message;
    if (res.status === 401 || res.status === 403)
      return { ok: false, error: "invalid_link", message };
    return { ok: false, error: "weak_password", message };
  }
  const user = (await res.json()) as { email?: string };
  if (!user.email) return { ok: false, error: "invalid_link" };
  const r = await login(request, user.email, password);
  if (!r.ok) return { ok: false, error: r.error === "no_access" ? "no_access" : "invalid_link" };
  return r;
}

/** Current session from cookies, refreshing an expired access token transparently. */
/**
 * Local development runs without login unless CRM_REQUIRE_LOGIN=true.
 * Production builds always require login (import.meta.env.DEV is false there).
 */
export function loginDisabled(): boolean {
  // Demo mode has no auth server, so it never asks for a login.
  return import.meta.env.DEV && (env("CRM_REQUIRE_LOGIN") !== "true" || demoMode());
}

const LOCAL_SESSION: Session = {
  userId: "00000000-0000-0000-0000-000000000000",
  email: "local (sem login)",
  role: "admin",
  setCookies: [],
};

export async function getSession(request: Request): Promise<Session | null> {
  if (loginDisabled()) return LOCAL_SESSION;
  const c = readCookies(request);
  let setCookies: string[] = [];
  let user = c[AT] ? await userFromToken(c[AT]) : null;
  if (!user && c[RT]) {
    const t = await token("refresh_token", { refresh_token: c[RT] });
    if (t) {
      user = t.user;
      setCookies = sessionCookies(t, isHttps(request));
    }
  }
  if (!user) return null;
  const role = await roleOf(user.id, user.email);
  return role ? { userId: user.id, email: user.email, role, setCookies } : null;
}

export async function logout(request: Request) {
  const at = readCookies(request)[AT];
  if (at) {
    const { url, anonKey } = crmConfig();
    await fetch(`${url}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: anonKey, authorization: `Bearer ${at}` },
    }).catch(() => undefined);
  }
  return clearCookies(request);
}

/** JSON response with optional Set-Cookie headers. */
export function json(body: unknown, status = 200, setCookies: string[] = []) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Creates (or updates the password of) a Supabase Auth user and grants a CRM role. Admin only. */
export async function createCrmUser(email: string, password: string, role: Role) {
  const { url, serviceKey } = crmConfig();
  const headers = { ...keyHeaders(serviceKey), "content-type": "application/json" };
  let userId: string | null = null;
  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.ok) {
    userId = ((await created.json()) as { id: string }).id;
  } else {
    // Already exists: find it and update the password.
    for (let page = 1; page < 50 && !userId; page++) {
      const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=100`, { headers });
      if (!r.ok) throw new Error(`Supabase Auth: HTTP ${r.status}`);
      const { users } = (await r.json()) as { users: { id: string; email?: string }[] };
      userId = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? null;
      if (users.length < 100) break;
    }
    if (!userId) throw new Error(`Supabase Auth recusou o usuário: HTTP ${created.status}`);
    const upd = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    if (!upd.ok) throw new Error(`Supabase Auth: HTTP ${upd.status}`);
  }
  const { error } = await crmRpc("crm_grant_access", {
    p_user_id: userId,
    p_email: email,
    p_role: role,
  });
  if (error) throw new Error(error.message);
}
