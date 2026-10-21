/** "Eventos recebidos": the webhooks of one customer, with their JSON, newest first. */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook } from "../../src/server/crm/pipeline.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc = sql ? makeRpc(sql) : null;

describe("Raw events of a customer", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  after(async () => {
    await sql?.end();
  });
  test("refused card then approved payment: both JSONs, newest first; others' events not shown", async () => {
    await resetCrm(sql!);
    const cust = { id: "cus_rw1", full_name: "Gil R", email: "gil.r@example.com" };
    const other = { id: "cus_rw2", full_name: "Outro", email: "outro.r@example.com" };
    const t0 = new Date(Date.now() - 600_000).toISOString();
    const t1 = new Date().toISOString();
    await ingestWebhook(
      rpc!,
      "b4you",
      JSON.stringify(
        b4("declined-payment", {
          customer: cust,
          sale_id: "RW-1",
          payment_method: "credit_card",
          created_at: t0,
          updated_at: t0,
        }),
      ),
    );
    await ingestWebhook(
      rpc!,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: cust,
          sale_id: "RW-1",
          payment_method: "pix",
          created_at: t1,
          updated_at: t1,
          paid_at: t1,
          charges: [{ id: "CRW1", amount: 99 }],
        }),
      ),
    );
    await ingestWebhook(
      rpc!,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: other,
          sale_id: "RW-2",
          payment_method: "pix",
          created_at: t1,
          updated_at: t1,
          paid_at: t1,
          charges: [{ id: "CRW2", amount: 10 }],
        }),
      ),
    );
    const [c] =
      await sql!`select customer_id from crm.customers where external_customer_id = 'cus_rw1'`;
    const r = await rpc!("crm_customer_raw_events", { p_customer_id: c!["customer_id"] });
    assert.equal(r.error, null, r.error?.message);
    const rows = r.data as {
      event_name: string;
      processing_status: string;
      payload: { sale_id: string };
    }[];
    assert.deepEqual(
      rows.map((e) => e.event_name),
      ["approved-payment", "declined-payment"],
    );
    assert.ok(rows.every((e) => e.payload.sale_id === "RW-1"));
    assert.ok(rows.every((e) => e.processing_status === "PROCESSED"));
  });
});
