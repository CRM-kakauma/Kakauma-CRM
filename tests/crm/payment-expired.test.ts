/** Pix/boleto expirado (PAYMENT_EXPIRED) no longer fires the "Pagamento recusado" flows. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { b4 } from "./fixtures.ts";
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
const flow = (key: string, name: string, fact: string) => ({
  p_key: key,
  p_name: name,
  p_trigger_fact: fact,
  p_graph: {
    nodes: [
      { id: "start", type: "trigger", config: {} },
      { id: "w", type: "wait", config: { amount: 1, unit: "days" } },
    ],
    edges: [{ source: "start", target: "w", handle: "next" }],
  },
});
const send = async (event: string, sale: string) => {
  const now = new Date().toISOString();
  const r = await ingestWebhook(
    rpc,
    "b4you",
    JSON.stringify(
      b4(event, {
        sale_id: sale,
        payment_method: "pix",
        charges: [{ id: `CH-${sale}`, amount: 100 }],
        created_at: now,
        updated_at: now,
      }),
    ),
  );
  assert.ok(r.status < 300, JSON.stringify(r.body));
};
const enrolled = async (key: string) =>
  (
    await sql!`select count(*)::int as n from crm.flow_enrollments en join crm.flows f using (flow_id)
                where f.key = ${key}`
  )[0]!["n"];

describe("Trigger: Pix/boleto expirado", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'pe_%')`;
    await sql!`delete from crm.flows where key like 'pe_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_save_flow", flow("pe_failed", "Pagamento recusado", "PAYMENT_FAILED"));
    await call("crm_save_flow", flow("pe_expired", "Pix expirado", "PAYMENT_EXPIRED"));
    await call("crm_publish_flow", { p_key: "pe_failed" });
    await call("crm_publish_flow", { p_key: "pe_expired" });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'pe_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("pix-expired is PAYMENT_EXPIRED and only enters the expired flow", async () => {
    await send("pix-expired", "S-PE1");
    const [f] = await sql!`select fact_type, data from crm.customer_events where sale_id = 'S-PE1'`;
    assert.equal(f!["fact_type"], "PAYMENT_EXPIRED");
    assert.equal((f!["data"] as Record<string, unknown>)["reason"], "expired");
    assert.equal(await enrolled("pe_expired"), 1);
    assert.equal(await enrolled("pe_failed"), 0);
    // The charge itself is still a failed one.
    const [tx] = await sql!`select status from crm.transactions where charge_id = 'CH-S-PE1'`;
    assert.equal(tx!["status"], "FAILED");
  });

  test("a declined card still is PAYMENT_FAILED", async () => {
    await sql!`update crm.flow_enrollments set status = 'COMPLETED' where status in ('ACTIVE','WAITING')`;
    await send("declined-payment", "S-PE2");
    const [f] = await sql!`select fact_type, data from crm.customer_events where sale_id = 'S-PE2'`;
    assert.equal(f!["fact_type"], "PAYMENT_FAILED");
    assert.equal((f!["data"] as Record<string, unknown>)["reason"], "declined");
    assert.equal(await enrolled("pe_failed"), 1);
  });

  test("PAYMENT_EXPIRED is an accepted trigger", async () => {
    const facts = (await call("crm_trigger_facts")) as string[];
    assert.ok(facts.includes("PAYMENT_EXPIRED"));
  });
});
