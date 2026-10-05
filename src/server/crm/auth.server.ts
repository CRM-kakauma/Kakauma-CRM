import { crmConfig, crmRpc, keyHeaders } from "./supabase.server.ts";

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

/** Current session from cookies, refreshing an expired access token transparently. */
export async function getSession(request: Request): Promise<Session | null> {
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
