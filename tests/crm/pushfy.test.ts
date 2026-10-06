/** Pushfy adapter (HTTP contract) and real sending through flows: live switch, errors, opt-out sync. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows, syncPushfyOptouts } from "../../src/server/crm/messages.ts";
import { pushfyOptouts, pushfySend, toPushfyNumber } from "../../src/server/crm/pushfy.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
/** fetch double: records calls, answers with the next queued response (default 200 accepted). */
function fakeFetch(responses: { status: number; body: unknown }[] = []) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? { status: 200, body: { accepted: 1, queued: 1 } };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const cfg = (impl: typeof fetch) => ({ token: "tok-test", smsFrom: "Kakauma", fetchImpl: impl });

describe("Pushfy adapter", () => {
  test("phone numbers become 55DDDNUMBER", () => {
    assert.equal(toPushfyNumber("(11) 98888-7777"), "5511988887777");
    assert.equal(toPushfyNumber("+55 11 98888-7777"), "5511988887777");
    assert.equal(toPushfyNumber("1133334444"), "551133334444");
    assert.equal(toPushfyNumber("98888-7777"), null);
    assert.equal(toPushfyNumber(null), null);
  });

  test("SMS request follows the documented contract", async () => {
    const f = fakeFetch();
    const r = await pushfySend(cfg(f.impl), "sms", {
      to: "5511988887777",
      text: "Oi",
      extId: "m-1",
    });
    assert.equal(r.ok, true);
    assert.equal(f.calls[0]!.url, "https://portal.pushfy.com/webapi");
    assert.equal(f.calls[0]!.method, "POST");
    assert.equal(f.calls[0]!.headers["authorization"], "Bearer tok-test");
    assert.deepEqual(f.calls[0]!.body, {
      messages: [
        { destinations: [{ to: "5511988887777" }], text: "Oi", ext_id: "m-1", from: "Kakauma" },
      ],
    });
    const rcs = fakeFetch();
    await pushfySend(cfg(rcs.impl), "rcs", { to: "5511988887777", text: "Oi", extId: "m-2" });
    assert.equal(rcs.calls[0]!.url, "https://portal.pushfy.com/rcs");
    assert.equal(rcs.calls[0]!.body.messages[0].from, undefined, "sender name is an SMS field");
  });

  test("errors: 4xx are final, 5xx and 429 retry, accepted 0 is final", async () => {
    const bad = await pushfySend(
      cfg(fakeFetch([{ status: 400, body: { error: "invalid" } }]).impl),
      "sms",
      {
        to: "55119",
        text: "x",
        extId: "a",
      },
    );
    assert.deepEqual([bad.ok, bad.permanent], [false, true]);
    const busy = await pushfySend(cfg(fakeFetch([{ status: 503, body: "busy" }]).impl), "sms", {
      to: "1",
      text: "x",
      extId: "b",
    });
    assert.deepEqual([busy.ok, busy.permanent], [false, false]);
    const rate = await pushfySend(cfg(fakeFetch([{ status: 429, body: "" }]).impl), "sms", {
      to: "1",
      text: "x",
      extId: "c",
    });
    assert.equal(rate.permanent, false);
    const none = await pushfySend(
      cfg(fakeFetch([{ status: 200, body: { accepted: 0, queued: 0 } }]).impl),
      "sms",
      {
        to: "1",
        text: "x",
        extId: "d",
      },
    );
    assert.deepEqual([none.ok, none.permanent], [false, true]);
  });

  test("opt-outs: pages of 1000, 404 (plain text) means empty", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({
      phone_number: `55119${String(i).padStart(8, "0")}`,
      optout_via: "SMS: PARAR",
      opted_out_at: "x",
    }));
    const f = fakeFetch([
      { status: 200, body: page },
      {
        status: 200,
        body: [{ phone_number: "5511900000000", optout_via: "RCS: SAIR", opted_out_at: "x" }],
      },
    ]);
    const rows = await pushfyOptouts(cfg(f.impl), "2026-10-06");
    assert.equal(rows.length, 1001);
    assert.match(f.calls[0]!.url, /\/optoutapi\?limit=1000&offset=0&date=2026-10-06$/);
    assert.match(f.calls[1]!.url, /offset=1000/);
    const empty = await pushfyOptouts(
      cfg(fakeFetch([{ status: 404, body: "Nenhum opt-out encontrado" }]).impl),
    );
    assert.deepEqual(empty, []);
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
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const buy = (id: string, phone: string | null, sale: string) =>
  ingestWebhook(
    rpc,
    "b4you",
    JSON.stringify(
      b4("approved-payment", {
        customer: {
          id: `cus_${id}`,
          full_name: `Cliente ${id}`,
          email: `${id}@example.com`,
          whatsapp: phone,
        },
        sale_id: sale,
        payment_method: "pix",
        created_at: ago(0),
        updated_at: ago(0),
        paid_at: ago(0),
        charges: [{ id: `C${sale}`, amount: 50 }],
      }),
    ),
  );
const lastMessage = async (id: string) =>
  (
    await sql!`select m.status, m.skip_reason, m.error, m.result, m.attempts from crm.messages m
               join crm.customers c using (customer_id) where c.external_customer_id = ${"cus_" + id}
               order by m.created_at desc limit 1`
  )[0];

describe("Sending through Pushfy", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'teste_%')`;
    await sql!`delete from crm.flows where key like 'teste_%'`;
    await sql!`delete from crm.message_templates where key like 'teste_%'`;
    await sql!`update crm.automations set active = false`;
    await sql!`update crm.settings set value = '{"start_hour":0,"end_hour":24}' where key = 'send_window'`;
    await sql!`update crm.settings set value = '20' where key = 'max_actions_per_customer_per_day'`;
    await call("crm_upsert_template", {
      p_key: "teste_px_sms",
      p_name: "SMS",
      p_channel: "sms",
      p_purpose: "marketing",
      p_content: { text: "Kakauma: oi {{first_name}}" },
    });
    await call("crm_upsert_template", {
      p_key: "teste_px_card",
      p_name: "Card",
      p_channel: "rcs",
      p_content: { kind: "card", cards: [{ title: "Oi" }], suggestions: [], fallback_sms: "Oi" },
    });
    await call("crm_save_flow", {
      p_key: "teste_px",
      p_name: "Pushfy",
      p_trigger_fact: "PURCHASE_PAID",
      p_reentry: "after_exit",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger" },
          { id: "s", type: "send", config: { template_key: "teste_px_sms" } },
          { id: "r", type: "send", config: { template_key: "teste_px_card" } },
        ],
        edges: [
          { source: "start", target: "s" },
          { source: "s", target: "r" },
        ],
      },
    });
    await call("crm_publish_flow", { p_key: "teste_px" });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'teste_%'`;
    await sql!`update crm.automations set active = true`;
    await sql!`update crm.settings set value = '{"start_hour":8,"end_hour":21}' where key = 'send_window'`;
    await sql!`update crm.settings set value = '3' where key = 'max_actions_per_customer_per_day'`;
    await sql?.end();
  });

  test("token without PUSHFY_LIVE: nothing is sent (simulation)", async () => {
    const f = fakeFetch();
    await buy("P0", "11977770000", "SP0");
    await runFlows(rpc, { pushfy: { ...cfg(f.impl), live: false } });
    assert.equal(f.calls.length, 0);
    const m =
      await sql!`select status, result->>'reason' as reason from crm.messages m join crm.customers c using (customer_id)
                         where c.external_customer_id = 'cus_P0' and m.channel = 'sms'`;
    assert.deepEqual([m[0]!["status"], m[0]!["reason"]], ["DRY_RUN", "pushfy_not_live"]);
  });

  test("live: SMS goes to Pushfy with the rendered text; rich RCS waits", async () => {
    const f = fakeFetch();
    await buy("P1", "(11) 97777-0001", "SP1");
    await runFlows(rpc, { pushfy: { ...cfg(f.impl), live: true } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.body.messages[0].destinations[0].to, "5511977770001");
    assert.equal(f.calls[0]!.body.messages[0].text, "Kakauma: oi Cliente");
    const rows =
      await sql!`select m.channel, m.status, m.skip_reason, m.result->>'provider' as provider, m.result->'response' as response
                            from crm.messages m join crm.customers c using (customer_id)
                            where c.external_customer_id = 'cus_P1' order by m.channel desc`;
    assert.deepEqual(
      rows.map((r) => [r["channel"], r["status"], r["skip_reason"] ?? r["provider"]]),
      [
        ["sms", "SENT", "pushfy"],
        ["rcs", "SKIPPED", "rcs_rich_not_supported"],
      ],
    );
    assert.deepEqual(rows[0]!["response"], { accepted: 1, queued: 1 });
  });

  test("rejected (400) is final; overloaded (503) retries later", async () => {
    await buy("P2", "11977770002", "SP2");
    await runFlows(rpc, {
      pushfy: { ...cfg(fakeFetch([{ status: 400, body: { error: "bad" } }]).impl), live: true },
    });
    const m2 = await sql!`select status from crm.messages m join crm.customers c using (customer_id)
                          where c.external_customer_id = 'cus_P2' and m.channel = 'sms'`;
    assert.equal(m2[0]!["status"], "FAILED");

    await buy("P3", "11977770003", "SP3");
    await runFlows(rpc, {
      pushfy: { ...cfg(fakeFetch([{ status: 503, body: "busy" }]).impl), live: true },
    });
    const m3 =
      await sql!`select status, scheduled_for > now() as later from crm.messages m join crm.customers c using (customer_id)
                          where c.external_customer_id = 'cus_P3' and m.channel = 'sms'`;
    assert.deepEqual([m3[0]!["status"], m3[0]!["later"]], ["QUEUED", true]);
  });

  test("customer without a valid phone is skipped", async () => {
    await buy("P4", "12345", "SP4");
    const f = fakeFetch();
    await runFlows(rpc, { pushfy: { ...cfg(f.impl), live: true } });
    const m =
      await sql!`select status, skip_reason from crm.messages m join crm.customers c using (customer_id)
                         where c.external_customer_id = 'cus_P4' and m.channel = 'sms'`;
    assert.deepEqual([m[0]!["status"], m[0]!["skip_reason"]], ["SKIPPED", "invalid_phone"]);
    assert.equal(f.calls.length, 0);
  });

  test("Pushfy opt-outs block the next marketing SMS", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: [
          {
            phone_number: "5511977770005",
            optout_via: "SMS: PARAR",
            opted_out_at: "2026-10-06 10:00:00",
          },
          { phone_number: "5511900000000", optout_via: "SMS: SAIR", opted_out_at: "x" },
        ],
      },
    ]);
    await buy("P5", "11 97777-0005", "SP5a");
    await sql!`update crm.messages set status = 'SKIPPED' where status = 'QUEUED'`; // isolate: only the next purchase matters
    await sql!`update crm.flow_enrollments set status = 'COMPLETED' where status in ('ACTIVE','WAITING')`;
    const r = await syncPushfyOptouts(rpc, cfg(f.impl), "2026-10-06");
    assert.deepEqual(r, { received: 2, customers: 1, added: 2 });
    const opt =
      await sql!`select array_agg(channel order by channel) as ch from crm.channel_optouts o join crm.customers c using (customer_id)
                           where c.external_customer_id = 'cus_P5'`;
    assert.deepEqual(opt[0]!["ch"], ["rcs", "sms"]);

    await buy("P5", "11 97777-0005", "SP5b");
    const send = fakeFetch();
    await runFlows(rpc, { pushfy: { ...cfg(send.impl), live: true } });
    const m = await lastMessage("P5");
    assert.equal(send.calls.length, 0);
    assert.ok(["opt_out", "rcs_rich_not_supported"].includes(String(m!["skip_reason"])));
    const sms =
      await sql!`select status, skip_reason from crm.messages m join crm.customers c using (customer_id)
                           where c.external_customer_id = 'cus_P5' and m.channel = 'sms' order by m.created_at desc limit 1`;
    assert.deepEqual([sms[0]!["status"], sms[0]!["skip_reason"]], ["SKIPPED", "opt_out"]);
  });
});
