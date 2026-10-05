#!/usr/bin/env node
// Creates (or updates) a CRM user in Supabase Auth and gives it a role.
//
//   npm run crm:create-admin -- voce@kakauma.com.br "uma-senha-forte" [admin|operator|viewer]
//
// Needs CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in .env.
const [email, password, role = "admin"] = process.argv.slice(2);
const url = process.env.CRM_SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.CRM_SUPABASE_SERVICE_ROLE_KEY;
if (!email || !password) {
  console.error('uso: npm run crm:create-admin -- email "senha" [admin|operator|viewer]');
  process.exit(1);
}
if (!url || !key) {
  console.error("CRM_SUPABASE_URL / CRM_SUPABASE_SERVICE_ROLE_KEY não definidos no .env");
  process.exit(1);
}
if (password.length < 10) {
  console.error("use uma senha com pelo menos 10 caracteres");
  process.exit(1);
}
const headers = key.startsWith("sb_")
  ? { apikey: key, "content-type": "application/json" }
  : { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

async function findUser() {
  for (let page = 1; page < 50; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=100`, { headers });
    if (!r.ok) throw new Error(`listar usuários: HTTP ${r.status} ${await r.text()}`);
    const { users } = await r.json();
    const u = users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u || users.length < 100) return u ?? null;
  }
  return null;
}

let user = await findUser();
if (user) {
  const r = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ password, email_confirm: true }),
  });
  if (!r.ok) throw new Error(`atualizar senha: HTTP ${r.status} ${await r.text()}`);
  console.log(`usuário existente atualizado: ${email}`);
} else {
  const r = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!r.ok) throw new Error(`criar usuário: HTTP ${r.status} ${await r.text()}`);
  user = await r.json();
  console.log(`usuário criado: ${email}`);
}

const g = await fetch(`${url}/rest/v1/rpc/crm_grant_access`, {
  method: "POST",
  headers,
  body: JSON.stringify({ p_user_id: user.id, p_email: email, p_role: role }),
});
if (!g.ok) {
  console.error(`dar acesso: HTTP ${g.status} ${await g.text()}`);
  console.error("Rodou `npm run crm:migrate` antes?");
  process.exit(1);
}
console.log(`acesso ao CRM: ${role}. Entre em http://localhost:8080/login`);
