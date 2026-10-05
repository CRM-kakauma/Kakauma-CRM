/** Profit per customer (COGS + taxes), CX score, LTV curve and LGPD anonymization. */
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
const call = async <T = any>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const ANA = {
  id: "cus_e1",
  full_name: "Ana Prado",
  email: "ana.prado@example.com",
  whatsapp: "11944440001",
  document_number: "111.222.333-44",
  address: {
    street: "Rua das Flores",
    number: "99",
    city: "Campinas",
    state: "SP",
    zipcode: "13000-000",
  },
};

const sale = (id: string, amount: number, days: number) =>
  ingestWebhook(
    rpc,
    "b4you",
    JSON.stringify(
      b4("approved-payment", {
        customer: ANA,
        sale_id: id,
        payment_method: "pix",
        paid_at: ago(days),
        created_at: ago(days),
        updated_at: ago(days),
        charges: [{ id: `C${id}`, amount }],
      }),
    ),
  );

async function customerId() {
  const [r] =
    await sql!`select customer_id from crm.customers where external_customer_id = 'cus_e1' or full_name = 'Cliente anonimizado' limit 1`;
  return r!["customer_id"] as string;
}

describe(
  "CRM profit, CX, LTV curve, LGPD",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await resetCrm(sql!);
      await sql!`update crm.settings set value = 'null' where key = 'tax_rate_pct'`;
      await sql!`update crm.automations set active = false`;
    });
    after(async () => {
      await sql!`update crm.settings set value = 'null' where key = 'tax_rate_pct'`;
      await sql!`update crm.automations set active = true`;
      await sql?.end();
    });

    test("profit stays unknown until every sale has a cost and the tax rate is set", async () => {
      await sale("SE1", 200, 40);
      await sale("SE2", 200, 5);
      const id = await customerId();
      let f = (await call("crm_customer_360", { p_customer_id: id })).financial;
      assert.equal(num(f.net_ltv), 400);
      assert.equal(f.cogs_missing_sales, 2);
      assert.equal(f.profit_ltv, null);

      const costs = await call<any[]>("crm_list_product_costs");
      const product = costs.find((c) => c.product_id === "prod_sleep" && c.offer_id === null);
      assert.equal(Number(product.paid_sales), 2);
      assert.equal(product.unit_cost, null);

      assert.equal(
        await call("crm_set_product_cost", {
          p_product_id: "prod_sleep",
          p_unit_cost: 50,
          p_actor: "a@x.com",
        }),
        1,
      );
      f = (await call("crm_customer_360", { p_customer_id: id })).financial;
      assert.equal(num(f.cogs), 100);
      assert.equal(f.cogs_missing_sales, 0);
      assert.equal(f.profit_ltv, null, "tax rate not set yet");

      await call("crm_update_setting", { p_key: "tax_rate_pct", p_value: 10, p_actor: "a@x.com" });
      f = (await call("crm_customer_360", { p_customer_id: id })).financial;
      assert.equal(num(f.taxes), 40);
      assert.equal(num(f.profit_ltv), num(f.contribution_ltv)! - 100 - 40);

      // an offer cost (e.g. a kit) wins over the product cost
      await call("crm_set_product_cost", {
        p_offer_id: "off_1",
        p_unit_cost: 70,
        p_actor: "a@x.com",
      });
      f = (await call("crm_customer_360", { p_customer_id: id })).financial;
      assert.equal(num(f.cogs), 140);
      const rule = await call("crm_preview_rule", {
        p_rule: { field: "profit_ltv", op: ">", value: 0 },
      });
      assert.equal(rule.matches, 1);

      const bad = await rpc("crm_update_setting", { p_key: "tax_rate_pct", p_value: 150 });
      assert.match(String(bad.error?.message), /between 0 and 100/);

      const d = await call("crm_dashboard", { p_from: ago(60), p_to: ago(-1) });
      assert.equal(num(d.commerce.cogs), 140);
      assert.equal(num(d.commerce.taxes), 40);
      assert.notEqual(d.commerce.profit, null);
      assert.equal(num(d.customer.avg_profit_ltv), num(f.profit_ltv));
    });

    test("CX score rewards reorders and drops with refunds", async () => {
      const id = await customerId();
      let x = (await call("crm_customer_360", { p_customer_id: id })).experience;
      assert.equal(num(x.cx_score), 85); // base 80 + 1 reorder × 5
      await ingestWebhook(
        rpc,
        "b4you",
        JSON.stringify(
          b4("refund", {
            customer: ANA,
            sale_id: "SE1",
            updated_at: ago(1),
            charges: [{ id: "CSE1", amount: 200 }],
          }),
        ),
      );
      x = (await call("crm_customer_360", { p_customer_id: id })).experience;
      assert.equal(num(x.cx_score), 65);
      const p = await call("crm_preview_rule", {
        p_rule: { field: "cx_score", op: "<", value: 70 },
      });
      assert.equal(p.matches, 1);
    });

    test("LTV curve only counts customers old enough for each month", async () => {
      const [row] = await call<any[]>("crm_ltv_curve", {
        p_dimension: "all",
        p_from: ago(60),
        p_to: ago(-1),
      });
      assert.equal(row.cohort, "Todos");
      assert.equal(row.customers, 1);
      const m = Object.fromEntries(row.points.map((p: any) => [p.month, p]));
      assert.equal(m[0].eligible, 1);
      assert.equal(num(m[0].avg_net_ltv), 200); // first sale only; the second came after 30+ days
      assert.equal(m[1].eligible, 1);
      assert.equal(num(m[1].avg_net_ltv), 200); // +200 second sale −200 refund of the first
      assert.equal(m[2].eligible, 0);
      assert.equal(m[2].avg_net_ltv, null);
      assert.equal(row.points.length, 13);
      const bad = await rpc("crm_ltv_curve", {
        p_dimension: "senha",
        p_from: ago(60),
        p_to: ago(-1),
      });
      assert.match(String(bad.error?.message), /unknown dimension/);
    });

    test("anonymization removes personal data and keeps the money", async () => {
      const id = await customerId();
      const before = (await call("crm_customer_360", { p_customer_id: id })).financial;
      const noReason = await rpc("crm_anonymize_customer", { p_customer_id: id, p_reason: " " });
      assert.match(String(noReason.error?.message), /reason is required/);

      const r = await call("crm_anonymize_customer", {
        p_customer_id: id,
        p_reason: "Solicitação LGPD #123",
        p_actor: "a@x.com",
      });
      assert.ok(r.events_redacted >= 3);

      const c = await call("crm_customer_360", { p_customer_id: id });
      assert.equal(c.identity.full_name, "Cliente anonimizado");
      assert.equal(c.identity.email, null);
      assert.equal(c.identity.whatsapp, null);
      assert.equal(c.identity.document_number, null);
      assert.deepEqual(c.identity.identifiers, []);
      assert.ok(c.identity.anonymized_at);
      assert.equal(num(c.financial.net_ltv), num(before.net_ltv));

      const raw =
        await sql!`select payload::text as p, redacted_fields from crm.events where customer_id = ${id}`;
      for (const e of raw) {
        assert.doesNotMatch(
          String(e["p"]),
          /ana\.prado|Ana Prado|111\.222|Flores|11944440001|cus_e1/,
        );
        assert.ok((e["redacted_fields"] as string[]).includes("lgpd"));
      }
      assert.match(String(raw[0]!["p"]), /SE\d/, "sale ids are kept");

      // the raw store is still immutable outside the anonymization path
      await assert.rejects(
        sql!`update crm.events set payload = '{}' where customer_id = ${id}`,
        /immutable/,
      );

      const again = await rpc("crm_anonymize_customer", { p_customer_id: id, p_reason: "x" });
      assert.match(String(again.error?.message), /already anonymized/);

      const audit = await call<any[]>("crm_list_audit", { p_entity: "customers" });
      assert.ok(audit.some((a) => a.field === "anonymized" && a.actor === "user:a@x.com"));

      // the same person buying again is a new customer (nothing left to match)
      await sale("SE3", 100, 0);
      const [{ n }] = await sql!`select count(*)::int as n from crm.customers`;
      assert.equal(n, 2);
    });
  },
);
