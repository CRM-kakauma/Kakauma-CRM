/** "Colocar em fluxo" on the customer page: a real enrollment, not a test. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data;
};

describe("Colocar em fluxo", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  let customer = "";
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'me_%')`;
    await sql!`delete from crm.flows where key like 'me_%'`;
    await sql!`update crm.settings set value = '{"start_hour":0,"end_hour":24}' where key = 'send_window'`;
    await call("crm_upsert_template", {
      p_key: "me_sms",
      p_name: "Carrinho SMS",
      p_channel: "sms",
      p_purpose: "marketing",
      p_content: { text: "Kakauma: {{first_name}}, seu carrinho te espera" },
    });
    await call("crm_save_flow", {
      p_key: "me_cart",
      p_name: "Carrinho abandonado",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_reentry: "once",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "me_sms" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    await call("crm_save_flow", {
      p_key: "me_draft",
      p_name: "Rascunho",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_graph: { nodes: [{ id: "start", type: "trigger", config: {} }], edges: [] },
    });
    await call("crm_publish_flow", { p_key: "me_cart" });
    const [c] =
      await sql!`insert into crm.customers (full_name, phone, whatsapp) values ('Cliente 79', '79991592167', '79991592167')
                            returning customer_id`;
    customer = String(c!["customer_id"]);
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'me_%'`;
    await sql!`update crm.settings set value = '{"start_hour":8,"end_hour":21}' where key = 'send_window'`;
    await sql?.end();
  });

  test("enters for real and gets the message like any customer", async () => {
    const r = (await call("crm_enroll_customer", {
      p_flow_key: "me_cart",
      p_customer: customer,
    })) as {
      flow: string;
    };
    assert.equal(r.flow, "Carrinho abandonado");
    const sent: string[] = [];
    await runFlows(rpc, {
      pushfy: {
        token: "t",
        live: true,
        fetchImpl: (async (_u: string, init: RequestInit) => {
          sent.push(String(init.body));
          return new Response(JSON.stringify({ id: 1, status: "sent" }), { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    const [m] =
      await sql!`select m.status, e.is_test from crm.messages m join crm.flow_enrollments e using (enrollment_id)
                            where m.customer_id = ${customer}`;
    assert.equal(m!["is_test"], false, "a real enrollment, not a test");
    assert.notEqual(m!["status"], "QUEUED");
    const [n] =
      await sql!`select count(*)::int as n from crm.audit_logs where field = 'manual_enroll'`;
    assert.equal(n!["n"], 1);
  });

  test("already in the flow, flow not active, or only once: refused (once can be forced)", async () => {
    const { error: notActive } = await rpc("crm_enroll_customer", {
      p_flow_key: "me_draft",
      p_customer: customer,
    });
    assert.match(notActive!.message, /não está ativo/);
    const { error: once } = await rpc("crm_enroll_customer", {
      p_flow_key: "me_cart",
      p_customer: customer,
    });
    assert.match(once!.message, /ONCE: este cliente já passou/);
    await call("crm_enroll_customer", {
      p_flow_key: "me_cart",
      p_customer: customer,
      p_force: true,
    });
    const { error: busy } = await rpc("crm_enroll_customer", {
      p_flow_key: "me_cart",
      p_customer: customer,
      p_force: true,
    });
    assert.match(busy!.message, /já está no fluxo/);
  });
});
