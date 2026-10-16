/** B4you "subscription.expiring_soon" starts a flow (“Aviso de próxima cobrança”). */
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

describe(
  "Trigger: subscription.expiring_soon",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await resetCrm(sql!);
      await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'xp_%')`;
      await sql!`delete from crm.flows where key like 'xp_%'`;
      await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
      await sql!`update crm.automations set active = false`;
      await call("crm_upsert_template", {
        p_key: "xp_mail",
        p_name: "Aviso de cobranca",
        p_channel: "email",
        p_purpose: "transactional",
        p_content: {
          subject: "Sua assinatura {{plan_name}} renova em {{next_charge_date}}",
          format: "html",
          html: "<p>oi</p>",
          blocks: [],
        },
      });
      await call("crm_save_flow", {
        p_key: "xp_flow",
        p_name: "Aviso de próxima cobrança",
        p_trigger_fact: "SUBSCRIPTION_EXPIRING_SOON",
        p_graph: {
          nodes: [
            { id: "start", type: "trigger", config: {} },
            { id: "m", type: "send", config: { template_key: "xp_mail" } },
          ],
          edges: [{ source: "start", target: "m", handle: "next" }],
        },
      });
      assert.equal(await call("crm_publish_flow", { p_key: "xp_flow" }), 1);
    });
    after(async () => {
      await sql!`update crm.flows set status = 'ARCHIVED' where key like 'xp_%'`;
      await sql!`update crm.automations set active = true`;
      await sql?.end();
    });

    test("the webhook enters the flow and the e-mail gets plan and next charge date", async () => {
      const now = new Date();
      const next = new Date(now.getTime() + 3 * 86_400_000);
      const r = await ingestWebhook(
        rpc,
        "b4you",
        JSON.stringify(
          b4("subscription.expiring_soon", {
            customer: { id: "cus_xp", full_name: "Xuxa P", email: "xp@example.com" },
            subscription: {
              id: "SUB-XP",
              status: "active",
              plan: { id: "pl1", name: "Mensal" },
              next_charge: next.toISOString(),
            },
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          }),
        ),
      );
      assert.ok(r.status < 300, JSON.stringify(r.body));
      await runFlows(rpc, {});
      const [m] =
        await sql!`select m.rendered->>'subject' as subject from crm.messages m join crm.flows f using (flow_id)
                    where f.key = 'xp_flow'`;
      assert.ok(m, "message queued by the flow");
      const d = next.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
      assert.equal(m!["subject"], `Sua assinatura Mensal renova em ${d}`);
    });
  },
);
