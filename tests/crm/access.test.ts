/** Phase 5: access control, audited mutations and the read models used by the screens. */
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
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const call = async <T = any>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const send = (p: unknown) => ingestWebhook(rpc, "b4you", JSON.stringify(p));
const USER = "6f1c2c9e-0000-4000-8000-000000000001";

describe(
  "CRM app access + screen read models (phase 5)",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await resetCrm(sql!);
      await sql!`truncate crm.app_users`;
      await sql!`delete from crm.segments where not is_system`;
      await sql!`update crm.automations set active = true`;
    });
    after(() => sql?.end());

    test("roles: unknown users have no access; granted users get their role", async () => {
      assert.equal(
        await call("crm_user_role", { p_user_id: USER, p_email: "felipe@kakauma.com.br" }),
        null,
      );
      await call("crm_grant_access", {
        p_user_id: USER,
        p_email: "Felipe@Kakauma.com.br",
        p_role: "admin",
      });
      assert.equal(
        await call("crm_user_role", { p_user_id: USER, p_email: "felipe@kakauma.com.br" }),
        "admin",
      );
      await sql!`update crm.app_users set active = false`;
      assert.equal(
        await call("crm_user_role", { p_user_id: USER, p_email: "felipe@kakauma.com.br" }),
        null,
      );
      await sql!`update crm.app_users set active = true`;
    });

    test("mutations record WHO changed them in the audit log", async () => {
      await call("crm_set_automation_active", {
        p_key: "pix_reminder",
        p_active: false,
        p_actor: "felipe@kakauma.com.br",
      });
      await call("crm_update_setting", {
        p_key: "recent_days",
        p_value: 45,
        p_actor: "felipe@kakauma.com.br",
      });
      const log = await sql!`select entity, field, new_value, actor from crm.audit_logs
                            where actor like 'user:%' order by id`;
      assert.deepEqual(
        log.map((l) => `${l["entity"]}.${l["field"]}=${l["new_value"]} by ${l["actor"]}`),
        [
          "automations.active=false by user:felipe@kakauma.com.br",
          "settings.value=45 by user:felipe@kakauma.com.br",
        ],
      );
      await call("crm_set_automation_active", { p_key: "pix_reminder", p_active: true });
      await call("crm_update_setting", { p_key: "recent_days", p_value: 30 });
    });

    test("settings and segments are validated", async () => {
      const bad = await rpc("crm_update_setting", { p_key: "recent_days", p_value: "trinta" });
      assert.match(String(bad.error?.message), /must be a number/);
      const sys = await rpc("crm_upsert_segment", {
        p_key: "value_high",
        p_name: "x",
        p_definition: {},
      });
      assert.match(String(sys.error?.message), /system segment/);
    });

    test("recovery queue lists only open situations", async () => {
      const c = {
        id: "cus_q1",
        full_name: "Quel",
        email: "quel@example.com",
        whatsapp: "11966660001",
      };
      await send(
        b4("abandoned-cart", {
          customer: c,
          updated_at: ago(1),
          offer: { id: "off_q", name: "Kit Q" },
        }),
      );
      await send(
        b4("generated-pix", {
          customer: c,
          sale_id: "SQ1",
          payment_method: "pix",
          created_at: ago(1),
          updated_at: ago(1),
          charges: [{ id: "CQ1", amount: 99 }],
        }),
      );
      let q = await call<any[]>("crm_recovery_queue");
      assert.deepEqual(q.map((x) => x.kind).sort(), ["CHECKOUT_ABANDONED", "PAYMENT_PENDING"]);

      await send(
        b4("approved-payment", {
          customer: c,
          sale_id: "SQ1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CQ1", amount: 99 }],
        }),
      );
      q = await call<any[]>("crm_recovery_queue");
      assert.equal(q.length, 0); // paid → nothing left to recover
    });

    test("ops overview, automation runs, rule fields and segment search", async () => {
      const ops = await call("crm_ops_overview");
      assert.ok(Number(ops.events.PROCESSED) >= 3);
      assert.equal(ops.totals.customers, 1);
      const runs = await call<any[]>("crm_list_automation_runs", { p_limit: 10 });
      assert.ok(runs.some((r) => r.automation === "onboarding_purchase"));
      const fields = await call<string[]>("crm_rule_fields");
      assert.ok(fields.includes("net_ltv"));
      const found = await call<any[]>("crm_search_customers", { p_segment: "behavior_one_time" });
      assert.deepEqual(
        found.map((r) => r.email),
        ["quel@example.com"],
      );
    });
  },
);
