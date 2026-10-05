/** Management functions: automation editor, rule preview, segment deletion, single-event requeue, users, audit. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, processPending, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runAutomations } from "../../src/server/crm/automation.ts";
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

describe("CRM management", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`truncate crm.app_users`;
    await sql!`delete from crm.segments where not is_system`;
    await sql!`delete from crm.automations where key like 'teste_%'`;
    await sql!`update crm.automations set active = false`;
  });
  after(async () => {
    // test automations must not leak into other test files
    await sql!`delete from crm.automation_runs where automation_id in (select automation_id from crm.automations where key like 'teste_%')`;
    await sql!`delete from crm.automations where key like 'teste_%'`;
    await sql`update crm.automations set active = true`;
    await sql?.end();
  });

  test("automation editor validates and creates a working automation", async () => {
    const bad = await rpc("crm_upsert_automation", {
      p_key: "teste_x",
      p_name: "X",
      p_trigger_fact: "NAO_EXISTE",
      p_conditions: {},
      p_action_config: { channel: "whatsapp", message: "oi" },
    });
    assert.match(String(bad.error?.message), /unknown trigger/);
    const noMsg = await rpc("crm_upsert_automation", {
      p_key: "teste_x",
      p_name: "X",
      p_trigger_fact: "PURCHASE_PAID",
      p_conditions: {},
      p_action_config: { channel: "whatsapp", message: " " },
    });
    assert.match(String(noMsg.error?.message), /message is required/);
    const badRule = await rpc("crm_upsert_automation", {
      p_key: "teste_x",
      p_name: "X",
      p_trigger_fact: "PURCHASE_PAID",
      p_conditions: { field: "senha", op: "=", value: 1 },
      p_action_config: { channel: "whatsapp", message: "oi" },
    });
    assert.match(String(badRule.error?.message), /unknown rule field/);

    await call("crm_upsert_automation", {
      p_key: "teste_vip",
      p_name: "Boas-vindas VIP",
      p_trigger_fact: "PURCHASE_PAID",
      p_conditions: { field: "net_ltv", op: ">=", value: 300 },
      p_action_config: { channel: "whatsapp", message: "Oi {{first_name}}, bem-vinda ao clube!" },
      p_actor: "felipe@kakauma.com.br",
    });
    const list = await call<any[]>("crm_list_automations");
    const a = list.find((x) => x.key === "teste_vip");
    assert.equal(a.trigger_fact, "PURCHASE_PAID");
    assert.deepEqual(a.conditions, { field: "net_ltv", op: ">=", value: 300 });

    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: {
            id: "cus_m1",
            full_name: "Lia Rosa",
            email: "lia@example.com",
            whatsapp: "11955550001",
          },
          sale_id: "SM1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CM1", amount: 400 }],
        }),
      ),
    );
    await runAutomations(rpc);
    const runs = await call<any[]>("crm_list_automation_runs", { p_key: "teste_vip" });
    assert.equal(runs[0].status, "DRY_RUN");
    assert.equal(runs[0].message, "Oi Lia, bem-vinda ao clube!");
    const audit = await call<any[]>("crm_list_audit", { p_entity: "automations" });
    assert.ok(
      audit.some(
        (x) =>
          x.entity_id === "teste_vip" &&
          x.field === "created" &&
          x.actor === "user:felipe@kakauma.com.br",
      ),
    );
  });

  test("rule preview counts matching customers now", async () => {
    const p = await call("crm_preview_rule", {
      p_rule: { field: "net_ltv", op: ">=", value: 300 },
    });
    assert.equal(p.matches, 1);
    assert.equal(p.sample[0].email, "lia@example.com");
    const bad = await rpc("crm_preview_rule", { p_rule: { field: "x", op: "=" } });
    assert.match(String(bad.error?.message), /unknown rule field/);
  });

  test("custom segments can be deleted; system ones cannot", async () => {
    await call("crm_upsert_segment", {
      p_key: "teste_seg",
      p_name: "Teste",
      p_definition: { field: "paid_orders", op: ">=", value: 1 },
    });
    assert.equal(
      await call("crm_delete_segment", { p_key: "teste_seg", p_actor: "felipe@kakauma.com.br" }),
      true,
    );
    const sys = await rpc("crm_delete_segment", { p_key: "value_high" });
    assert.match(String(sys.error?.message), /cannot be deleted/);
  });

  test("a single dead-lettered event can be reprocessed", async () => {
    const r = await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(b4("approved-payment", { sale_id: "SM9", payment_method: "pix" })),
    );
    const eventId = String(r.body["event_id"]);
    assert.equal(r.body["status"], "DEAD_LETTER");
    await call("crm_requeue_event", { p_event_id: eventId, p_actor: "felipe@kakauma.com.br" });
    const ops = await call("crm_ops_overview");
    assert.equal(ops.dead_letters_open, 0);
    const res = await processPending(rpc, {});
    assert.equal(res.results.find((x) => x.event_id === eventId)?.status, "DEAD_LETTER"); // still invalid, back in the queue
    const bad = await rpc("crm_requeue_event", { p_event_id: "evt_nope" });
    assert.match(String(bad.error?.message), /not found/);
  });

  test("user access: roles, and the last admin is protected", async () => {
    await call("crm_grant_access", {
      p_user_id: "6f1c2c9e-0000-4000-8000-0000000000a1",
      p_email: "dono@kakauma.com.br",
      p_role: "admin",
    });
    await call("crm_grant_access", {
      p_user_id: "6f1c2c9e-0000-4000-8000-0000000000a2",
      p_email: "op@kakauma.com.br",
      p_role: "viewer",
    });
    await call("crm_set_user_access", {
      p_email: "op@kakauma.com.br",
      p_role: "operator",
      p_active: true,
      p_actor: "dono@kakauma.com.br",
    });
    const users = await call<any[]>("crm_list_app_users");
    assert.equal(users.find((u) => u.email === "op@kakauma.com.br").role, "operator");
    const guard = await rpc("crm_set_user_access", {
      p_email: "dono@kakauma.com.br",
      p_role: "viewer",
      p_active: true,
    });
    assert.match(String(guard.error?.message), /last active admin/);
    const audit = await call<any[]>("crm_list_audit", { p_entity: "app_users" });
    assert.ok(
      audit.some(
        (x) =>
          x.field === "role" &&
          x.new_value === "operator" &&
          x.actor === "user:dono@kakauma.com.br",
      ),
    );
  });

  test("trigger list is exposed for the editor", async () => {
    const facts = await call<string[]>("crm_trigger_facts");
    assert.ok(facts.includes("CHECKOUT_ABANDONED") && facts.includes("SEGMENT_ENTERED"));
  });
});
