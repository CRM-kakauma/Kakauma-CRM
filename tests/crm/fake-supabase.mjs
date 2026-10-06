#!/usr/bin/env node
// TEST TOOL ONLY — a tiny stand-in for the Supabase HTTP API so the real app
// can be exercised end-to-end against a local Postgres:
//   POST /auth/v1/token?grant_type=password|refresh_token, GET|PUT /auth/v1/user, POST /auth/v1/logout
//   GET  /__invite_token             → token like the one in an invite e-mail link (tests only)
//   POST /rest/v1/rpc/<fn>          → select * from public.<fn>(named args) (service key only)
//   GET  /rest/v1/events            → legacy analytics events from FAKE_LEGACY_FILE (for the import)
//
// env: DATABASE_URL, PORT (54321), FAKE_EMAIL, FAKE_PASSWORD, FAKE_USER_ID,
//      FAKE_ANON_KEY, FAKE_SERVICE_KEY, FAKE_LEGACY_FILE (optional JSON array of payloads)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const {
  DATABASE_URL,
  PORT = "54321",
  FAKE_EMAIL = "admin@kakauma.test",
  FAKE_PASSWORD = "senha-de-teste-123",
  FAKE_USER_ID = "00000000-0000-4000-8000-000000000001",
  FAKE_ANON_KEY = "anon-test-key",
  FAKE_SERVICE_KEY = "service-test-key",
  FAKE_LEGACY_FILE,
} = process.env;

const sql = postgres(DATABASE_URL, { max: 5, onnotice: () => {} });
const tokens = new Map(); // access token → user
const refresh = new Map();
const user = { id: FAKE_USER_ID, email: FAKE_EMAIL, aud: "authenticated", role: "authenticated" };
let password = FAKE_PASSWORD; // changes with PUT /auth/v1/user (invite / recovery)
const legacy = FAKE_LEGACY_FILE ? JSON.parse(readFileSync(FAKE_LEGACY_FILE, "utf8")) : [];

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const issue = () => {
  const at = `at-${randomUUID()}`;
  const rt = `rt-${randomUUID()}`;
  tokens.set(at, user);
  refresh.set(rt, user);
  return { access_token: at, refresh_token: rt, token_type: "bearer", expires_in: 3600, user };
};
const readBody = (req) =>
  new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b ? JSON.parse(b) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const apikey = req.headers["apikey"];
  try {
    if (url.pathname === "/auth/v1/token" && req.method === "POST") {
      if (apikey !== FAKE_ANON_KEY) return send(res, 401, { message: "bad apikey" });
      const body = await readBody(req);
      if (url.searchParams.get("grant_type") === "password") {
        if (body.email?.toLowerCase() !== FAKE_EMAIL || body.password !== password) {
          return send(res, 400, {
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          });
        }
        return send(res, 200, issue());
      }
      if (
        url.searchParams.get("grant_type") === "refresh_token" &&
        refresh.has(body.refresh_token)
      ) {
        refresh.delete(body.refresh_token);
        return send(res, 200, issue());
      }
      return send(res, 400, { error: "invalid_grant" });
    }
    if (url.pathname === "/auth/v1/user") {
      const t = (req.headers["authorization"] ?? "").replace(/^Bearer /, "");
      const u = tokens.get(t);
      if (!u) return send(res, 401, { message: "invalid JWT" });
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (typeof body.password === "string" && body.password.length < 6)
          return send(res, 422, { msg: "Password should be at least 6 characters." });
        if (typeof body.password === "string") password = body.password;
      }
      return send(res, 200, u);
    }
    // test helper: the access token an invite / recovery e-mail link would carry
    if (url.pathname === "/__invite_token") return send(res, 200, { access_token: issue().access_token });
    if (url.pathname === "/auth/v1/logout") {
      tokens.delete((req.headers["authorization"] ?? "").replace(/^Bearer /, ""));
      return send(res, 204);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/") && req.method === "POST") {
      if (apikey !== FAKE_SERVICE_KEY)
        return send(res, 401, { message: "permission denied (service key required)" });
      const fn = url.pathname.slice("/rest/v1/rpc/".length);
      if (!/^crm_[a-z0-9_]+$/.test(fn)) return send(res, 404, { message: "unknown function" });
      const args = await readBody(req);
      const keys = Object.keys(args);
      const values = keys.map((k) => args[k]);
      const params = keys.map((k, i) => {
        const v = args[k];
        if (Array.isArray(v) && k === "p_redacted") return `${k} => $${i + 1}::text[]`;
        if (v !== null && typeof v === "object") return `${k} => $${i + 1}::jsonb`;
        return `${k} => $${i + 1}`;
      });
      try {
        const rows = await sql.unsafe(`select * from public.${fn}(${params.join(", ")})`, values);
        const first = rows[0];
        // PostgREST returns scalars bare and set-returning functions as arrays.
        if (rows.length === 1 && first && Object.keys(first).length === 1 && fn in first)
          return send(res, 200, first[fn]);
        return send(res, 200, rows);
      } catch (e) {
        return send(res, 400, { message: e.message });
      }
    }
    if (url.pathname === "/rest/v1/events" && req.method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return send(
        res,
        200,
        legacy
          .slice(offset, offset + limit)
          .map((p) => ({ metadata: { provider: "b4you", raw_payload: p } })),
      );
    }
    send(res, 404, { message: `not found: ${req.method} ${url.pathname}` });
  } catch (e) {
    send(res, 500, { message: e.message });
  }
}).listen(Number(PORT), "127.0.0.1", () => console.log(`fake supabase on :${PORT}`));
