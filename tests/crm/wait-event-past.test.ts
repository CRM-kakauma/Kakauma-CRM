/** "Aguardar evento" counts an event that already happened while the customer was in the flow. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
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
const send = (p: object) => ingestWebhook(rpc, "b4you", JSON.stringify(p));
const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const buyer = (id: string) => ({
  id: `cus_${id}`,
  full_name: `Pessoa ${id}`,
  email: `${id.toLowerCase()}@example.com`,
});
const paid = (id: string, sale: string) =>
  send(
    b4("approved-payment", {
      customer: buyer(id),
      sale_id: sale,
      payment_method: "pix",
      created_at: iso(),
      updated_at: iso(),
      paid_at: iso(),
      charges: [{ id: `C${sale}`, amount: 100 }],
    }),
  );
const tracking = (id: string, sale: string, minutesAgo = 0) =>
  send(
    b4("tracking", {
      customer: buyer(id),
      sale_id: sale,
      updated_at: iso(minutesAgo),
      tracking: { code: `T${sale}` },
    }),
  );
const state = async (id: string) =>
  (
    await sql!`select e.status, e.current_node,
                      (select string_agg(m.node_id, ',' order by m.node_id) from crm.messages m
                        where m.enrollment_id = e.enrollment_id) as sent
                 from crm.flow_enrollments e join crm.flows f using (flow_id)
                 join crm.customers c using (customer_id)
                where f.key = 'wp_flow' and c.external_customer_id = ${"cus_" + id}
                order by e.entered_at desc limit 1`
  )[0];

describe(
  "Aguardar evento: event already happened",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await resetCrm(sql!);
      await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'wp_%')`;
      await sql!`delete from crm.flows where key like 'wp_%'`;
      await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
      await sql!`update crm.automations set active = false`;
      for (const k of ["wp_ok", "wp_track"])
        await call("crm_upsert_template", {
          p_key: k,
          p_name: k,
          p_channel: "email",
          p_purpose: "transactional",
          p_content: { subject: k, format: "html", html: "<p>oi</p>", blocks: [] },
        });
      await call("crm_save_flow", {
        p_key: "wp_flow",
        p_name: "Compra aprovada",
        p_trigger_fact: "PURCHASE_PAID",
        p_graph: {
          nodes: [
            { id: "start", type: "trigger", config: {} },
            { id: "w", type: "wait", config: { amount: 1, unit: "hours" } },
            { id: "ok", type: "send", config: { template_key: "wp_ok" } },
            {
              id: "env",
              type: "wait_event",
              config: { fact: "FULFILLMENT_FULFILLMENT_CREATED", timeout_hours: 240 },
            },
            { id: "track", type: "send", config: { template_key: "wp_track" } },
            { id: "end", type: "exit", config: {} },
          ],
          edges: [
            { source: "start", target: "w", handle: "next" },
            { source: "w", target: "ok", handle: "next" },
            { source: "ok", target: "env", handle: "next" },
            { source: "env", target: "track", handle: "event" },
            { source: "env", target: "end", handle: "timeout" },
          ],
        },
      });
      assert.equal(await call("crm_publish_flow", { p_key: "wp_flow" }), 1);
    });
    after(async () => {
      await sql!`update crm.flows set status = 'ARCHIVED' where key like 'wp_%'`;
      await sql!`update crm.automations set active = true`;
      await sql?.end();
    });

    test("tracking that arrived during an earlier step moves the customer on at once", async () => {
      await paid("WP1", "SWP1");
      await runFlows(rpc, {});
      assert.equal((await state("WP1"))!["current_node"], "ok"); // in the 1 h wait
      await tracking("WP1", "SWP1");
      await sql!`update crm.flow_enrollments set next_run_at = now() where status = 'ACTIVE'`;
      await runFlows(rpc, {});
      const s = await state("WP1");
      assert.equal(s!["sent"], "ok,track");
      assert.equal(s!["status"], "COMPLETED"); // "track" is the end of that path
    });

    test("the purchase that started the flow is not the purchase it waits for", async () => {
      await call("crm_save_flow", {
        p_key: "wp_rebuy",
        p_name: "Recompra",
        p_trigger_fact: "PURCHASE_PAID",
        p_graph: {
          nodes: [
            { id: "start", type: "trigger", config: {} },
            {
              id: "env",
              type: "wait_event",
              config: { fact: "PURCHASE_PAID", timeout_hours: 240 },
            },
            { id: "track", type: "send", config: { template_key: "wp_track" } },
          ],
          edges: [
            { source: "start", target: "env", handle: "next" },
            { source: "env", target: "track", handle: "event" },
          ],
        },
      });
      assert.equal(await call("crm_publish_flow", { p_key: "wp_rebuy" }), 1);
      await paid("WP3", "SWP3");
      await runFlows(rpc, {});
      const [e] =
        await sql!`select e.status from crm.flow_enrollments e join crm.flows f using (flow_id)
                    where f.key = 'wp_rebuy'`;
      assert.equal(e!["status"], "WAITING");
      await sql!`update crm.flows set status = 'ARCHIVED' where key = 'wp_rebuy'`;
    });

    test("tracking from before the customer entered the flow does not count", async () => {
      await tracking("WP2", "SOLD", 120); // an older order, two hours ago
      await paid("WP2", "SWP2");
      await runFlows(rpc, {});
      await sql!`update crm.flow_enrollments set next_run_at = now() where status = 'ACTIVE'`;
      await runFlows(rpc, {});
      const s = await state("WP2");
      assert.deepEqual([s!["status"], s!["sent"]], ["WAITING", "ok"]);
    });
  },
);
