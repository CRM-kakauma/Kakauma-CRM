/** Resend (e-mail): request contract, error handling and sending through flows. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import { fromHeader, isEmail, resendSend } from "../../src/server/crm/resend.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

function fake(responses: { status: number; body: unknown }[] = []) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const r = responses.shift() ?? { status: 200, body: { id: "re_123" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const cfg = (impl: typeof fetch) => ({
  apiKey: "re_key",
  from: "contato@kakauma.com.br",
  fetchImpl: impl,
});

describe("Resend adapter", () => {
  test("request follows the API: from with name, idempotency key, html + text", async () => {
    const f = fake();
    const r = await resendSend(cfg(f.impl), {
      to: " ana@example.com ",
      subject: "Oi",
      html: "<p>Oi</p>",
      text: "Oi",
      fromName: 'Kakauma "Loja" <x>',
      idempotencyKey: "m-1",
    });
    assert.equal(r.ok, true);
    assert.equal(f.calls[0]!.url, "https://api.resend.com/emails");
    assert.equal(f.calls[0]!.headers["authorization"], "Bearer re_key");
    assert.equal(f.calls[0]!.headers["idempotency-key"], "m-1");
    assert.deepEqual(f.calls[0]!.body, {
      from: "Kakauma Loja x <contato@kakauma.com.br>",
      to: ["ana@example.com"],
      subject: "Oi",
      html: "<p>Oi</p>",
      text: "Oi",
    });
    assert.equal(fromHeader("", "a@b.com"), "a@b.com");
    assert.equal(isEmail("a@b.com"), true);
    assert.equal(isEmail("a@b"), false);
  });

  test("4xx is final with Resend's message; 429 and 5xx retry", async () => {
    const bad = await resendSend(
      cfg(
        fake([{ status: 403, body: { message: "The kakauma.com.br domain is not verified" } }])
          .impl,
      ),
      { to: "a@b.com", subject: "x", html: "x", text: "x", idempotencyKey: "k" },
    );
    assert.deepEqual([bad.ok, bad.permanent], [false, true]);
    assert.match(bad.error ?? "", /not verified/);
    for (const status of [429, 500]) {
      const r = await resendSend(cfg(fake([{ status, body: { message: "busy" } }]).impl), {
        to: "a@b.com",
        subject: "x",
        html: "x",
        text: "x",
        idempotencyKey: "k",
      });
      assert.deepEqual([r.ok, r.permanent], [false, false]);
    }
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async <T = any>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};

describe("E-mail through flows", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 're_%')`;
    await sql!`delete from crm.flows where key like 're_%'`;
    await sql!`delete from crm.message_templates where key like 're_%'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_upsert_template", {
      p_key: "re_mail",
      p_name: "Mail",
      p_channel: "email",
      p_purpose: "transactional",
      p_content: {
        subject: "Oi {{first_name}}",
        from_name: "Kakauma",
        format: "html",
        html: "<p>Olá {{first_name}}</p>",
        blocks: [],
      },
    });
    await call("crm_save_flow", {
      p_key: "re_flow",
      p_name: "Mail",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "re_mail" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    for (const [n, e] of [
      ["Ana Mail", "ana.mail@example.com"],
      ["Sem Email", ""],
    ])
      await call("crm_add_test_contact", {
        p_name: n,
        p_email: e || null,
        p_phone: e ? null : "11 91111-0000",
      });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 're_%'`;
    await sql!`delete from crm.segment_members where segment_id = (select segment_id from crm.segments where key = 'teste')`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("a test launch sends the e-mail through Resend even before EMAIL_LIVE", async () => {
    const f = fake();
    await call("crm_launch_flow_test", { p_key: "re_flow" });
    await runFlows(rpc, { resend: { ...cfg(f.impl), live: false } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.body.to[0], "ana.mail@example.com");
    assert.equal(f.calls[0]!.body.subject, "Oi Ana");
    assert.match(f.calls[0]!.body.html, /<p>Olá Ana<\/p>/);
    const rows =
      await sql!`select c.email, m.status, m.skip_reason, m.result->>'provider' as provider
                              from crm.messages m join crm.customers c using (customer_id)
                             where m.channel = 'email' order by c.email nulls last`;
    assert.deepEqual(
      rows.map((r) => [r["email"], r["status"], r["skip_reason"] ?? r["provider"]]),
      [
        ["ana.mail@example.com", "SENT", "resend"],
        [null, "SKIPPED", "no_contact_for_email"],
      ],
    );
  });

  test("without EMAIL_LIVE a real customer's e-mail stays a simulation", async () => {
    await call("crm_set_flow_status", { p_key: "re_flow", p_status: "ACTIVE" }).catch(() => null);
    await call("crm_publish_flow", { p_key: "re_flow" });
    const [c] =
      await sql!`select customer_id from crm.customers where email = 'ana.mail@example.com'`;
    await sql!`update crm.customers set is_test = false where customer_id = ${c!["customer_id"]}`;
    await sql!`insert into crm.customer_events (dedupe_key, fact_type, customer_id, occurred_at, data)
               values ('re-test-' || gen_random_uuid(), 'PURCHASE_PAID', ${c!["customer_id"]}, now(), '{}')`;
    const f = fake();
    await runFlows(rpc, { resend: { ...cfg(f.impl), live: false } });
    assert.equal(f.calls.length, 0);
    const [m] = await sql!`select m.status, m.result->>'reason' as reason from crm.messages m
                            join crm.flow_enrollments e using (enrollment_id)
                           where m.customer_id = ${c!["customer_id"]} and not e.is_test`;
    assert.deepEqual([m!["status"], m!["reason"]], ["DRY_RUN", "email_not_live"]);
  });
});
