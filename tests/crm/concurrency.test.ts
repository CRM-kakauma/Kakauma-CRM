/** Concurrency and ordering guarantees (same database as engine.test.ts; run files sequentially). */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 10, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const send = (p: unknown) => ingestWebhook(rpc, "b4you", JSON.stringify(p));
describe("CRM concurrency and ordering", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(() => resetCrm(sql!));
  after(() => sql?.end());
  const C = { email: "concurrent@example.com", full_name: "Conc" };

  test("parallel events of a brand-new customer create exactly one customer", async () => {
    const evs = Array.from({ length: 8 }, (_, i) =>
      b4("abandoned-cart", { customer: C, updated_at: `2027-02-0${i + 1}T00:00:00Z` }),
    );
    evs.push(
      b4("generated-pix", {
        customer: { ...C, id: "cus_conc" },
        sale_id: "SC1",
        payment_method: "pix",
        charges: [{ id: "CC1", amount: 10 }],
      }),
    );
    const res = await Promise.all(evs.map(send));
    assert.ok(
      res.every((r) => r.status === 200),
      JSON.stringify(res.map((r) => r.body)),
    );
    const n =
      await sql!`select count(*)::int as n from crm.customer_identities i where i.kind = 'email' and i.value = 'concurrent@example.com'`;
    const cust =
      await sql!`select count(distinct customer_id)::int as n from crm.customer_identities where value in ('concurrent@example.com','cus_conc','SC1')`;
    assert.equal(n[0]!["n"], 1);
    assert.equal(cust[0]!["n"], 1);
  });

  test("same webhook delivered 5x in parallel is stored and counted once", async () => {
    const p = b4("approved-payment", {
      customer: { id: "cus_par", email: "par@example.com" },
      sale_id: "SP1",
      payment_method: "pix",
      charges: [{ id: "CP1", amount: 99 }],
    });
    await Promise.all(Array.from({ length: 5 }, () => send(p)));
    const r =
      await sql!`select (select count(*)::int from crm.events where payload->>'sale_id' = 'SP1') e, (select count(*)::int from crm.financial_events where sale_id = 'SP1') f`;
    assert.deepEqual([r[0]!["e"], r[0]!["f"]], [1, 1]);
  });

  test("out of order: refund and tracking before approval", async () => {
    const cu = { id: "cus_ooo", email: "ooo@example.com" };
    await send(
      b4("refund", {
        customer: cu,
        sale_id: "SO1",
        updated_at: "2027-03-05T00:00:00Z",
        charges: [{ id: "CO1", amount: 80 }],
      }),
    );
    await send(
      b4("tracking", {
        customer: cu,
        sale_id: "SO1",
        updated_at: "2027-03-03T00:00:00Z",
        tracking: { code: "TRK1", company: "Correios", status: "delivered" },
      }),
    );
    await send(
      b4("approved-payment", {
        customer: cu,
        sale_id: "SO1",
        payment_method: "pix",
        paid_at: "2027-03-01T00:00:00Z",
        charges: [{ id: "CO1", amount: 80 }],
      }),
    );
    const t = await sql!`select status, amount from crm.transactions where charge_id = 'CO1'`;
    const c =
      await sql!`select total_gross_revenue g, total_refund_amount r, total_net_revenue n from crm.customers where external_customer_id = 'cus_ooo'`;
    const o = await sql!`select status from crm.orders where sale_id = 'SO1'`;
    assert.equal(t[0]!["status"], "REFUNDED");
    assert.equal(Number(c[0]!["g"]), 80);
    assert.equal(Number(c[0]!["r"]), 80);
    assert.equal(Number(c[0]!["n"]), 0);
  });
});
