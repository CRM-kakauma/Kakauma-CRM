/** "Por que não entrou?": who triggered the flow, who entered and why the others did not. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { importBackfill } from "../../src/server/crm/backfill.ts";
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
let n = 0;
const cart = (who: string, offer = "off_1") => {
  n++;
  const at = new Date(Date.now() - n * 60_000).toISOString();
  return b4("abandoned-cart", {
    customer: { id: `cus_${who}`, full_name: who, email: `${who.toLowerCase()}@example.com` },
    offer: { id: offer, name: offer, quantity: 1, original_price: 100 },
    created_at: at,
    updated_at: at,
  });
};
const send = async (p: object) => {
  const r = await ingestWebhook(rpc, "b4you", JSON.stringify(p));
  assert.ok(r.status < 300, JSON.stringify(r.body));
};

describe("Por que não entrou?", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'fd_%')`;
    await sql!`delete from crm.flows where key like 'fd_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await call("crm_save_flow", {
      p_key: "fd_cart",
      p_name: "Carrinho",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_reentry: "once",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "w", type: "wait", config: { amount: 1, unit: "days" } },
        ],
        edges: [{ source: "start", target: "w", handle: "next" }],
      },
    });
    await call("crm_publish_flow", { p_key: "fd_cart" });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'fd_%'`;
    await sql?.end();
  });

  test("entered, already in the flow, already went through, history", async () => {
    await send(cart("Ana")); // enters
    await send(cart("Ana", "off_2")); // still in the flow (waiting 1 day)
    await send(cart("Bia")); // enters...
    await sql!`update crm.flow_enrollments set status = 'COMPLETED', finished_at = now()
                where customer_id = (select customer_id from crm.customers where external_customer_id = 'cus_Bia')`;
    await send(cart("Bia", "off_3")); // ...finished: "only once" keeps her out
    await importBackfill(rpc, "b4you", [{ payload: cart("Caio") }], 1); // history
    const d = (await call("crm_flow_entry_diagnosis", { p_key: "fd_cart", p_hours: 24 })) as {
      facts: number;
      by_result: Record<string, number>;
      recent: { who: string; result: string }[];
    };
    assert.equal(d.facts, 5);
    assert.deepEqual(d.by_result, { entered: 2, busy: 1, once: 1, history: 1 });
    assert.equal(d.recent.length, 5);
  });
});
