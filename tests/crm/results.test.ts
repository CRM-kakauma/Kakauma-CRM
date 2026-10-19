/** "Resultados": sends, clicks, orders with the CRM's UTMs and orders influenced by a message. */
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
const call = async <T = unknown>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const range = () => ({
  p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  p_to: new Date(Date.now() + 60_000).toISOString(),
});
const send = (p: object) => ingestWebhook(rpc, "b4you", JSON.stringify(p));
const iso = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const ana = {
  id: "cus_rs1",
  full_name: "Ana Resultado",
  email: "ana.r@example.com",
  whatsapp: "11977771111",
};
const bia = {
  id: "cus_rs2",
  full_name: "Bia Semmsg",
  email: "bia.r@example.com",
  whatsapp: "11977772222",
};

interface Row {
  campaign: string;
  name?: string;
  channel?: string;
  sent: number;
  clicks: number;
  infl_orders: number;
  infl_revenue: number;
  utm_orders: number;
  utm_revenue: number;
}

describe("Resultados do CRM", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.short_links`;
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'rs_%')`;
    await sql!`delete from crm.flows where key like 'rs_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_upsert_template", {
      p_key: "rs_sms",
      p_name: "Lembrete 1",
      p_channel: "sms",
      p_purpose: "marketing",
      p_content: { text: "Kakauma: volte https://kakauma.com.br/" },
    });
    await call("crm_save_flow", {
      p_key: "rs_cart",
      p_name: "Carrinho abandonado",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "rs_sms" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    assert.equal(await call("crm_publish_flow", { p_key: "rs_cart" }), 1);
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'rs_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("a cart reminder, its clicks and the purchase that followed", async () => {
    await send(b4("abandoned-cart", { customer: ana, created_at: iso(3), updated_at: iso(3) }));
    await runFlows(rpc, {});
    // the SMS went out two hours ago
    await sql!`update crm.messages set status = 'SENT', executed_at = now() - interval '2 hours'
                where template_key = 'rs_sms'`;
    // two clicks on the CRM short link of that SMS
    const url =
      "https://kakauma.com.br/?utm_source=sms&utm_medium=crm&utm_campaign=carrinho_abandonado&utm_content=lembrete_1";
    const { code } = await call<{ code: string }>("crm_create_short_link", { p_url: url });
    await call("crm_open_short_link", { p_code: code });
    await call("crm_open_short_link", { p_code: code });
    // Ana buys with the CRM's UTMs; Bia buys without having received anything
    for (const [c, sale, amount, utm] of [
      [
        ana,
        "RS-1",
        150,
        {
          utm_source: "sms",
          utm_medium: "crm",
          utm_campaign: "carrinho_abandonado",
          utm_content: "lembrete_1",
        },
      ],
      [bia, "RS-2", 999, { utm_source: "facebook", utm_medium: "cpc" }],
    ] as const)
      await send(
        b4("approved-payment", {
          customer: c,
          sale_id: sale,
          payment_method: "pix",
          created_at: iso(),
          updated_at: iso(),
          paid_at: iso(),
          charges: [{ id: `C${sale}`, amount }],
          utm,
        }),
      );

    const r = await call<{
      totals: Omit<Row, "campaign">;
      by_flow: Row[];
      by_channel: Row[];
      by_message: (Row & { message_name: string })[];
      daily: { day: string; sent_sms: number; infl_revenue: number }[];
    }>("crm_results", { ...range(), p_window_days: 7 });

    const flow = r.by_flow.find((f) => f.campaign === "carrinho_abandonado");
    assert.ok(flow, JSON.stringify(r.by_flow));
    assert.equal(flow.name, "Carrinho abandonado");
    assert.deepEqual(
      [
        flow.sent,
        flow.clicks,
        flow.infl_orders,
        Number(flow.infl_revenue),
        flow.utm_orders,
        Number(flow.utm_revenue),
      ],
      // clicks: 2 on the short link + 1 proved by the sale with the CRM's UTMs
      [1, 3, 1, 150, 1, 150],
    );
    // Bia's order is neither influenced nor CRM-tracked
    assert.equal(Number(r.totals.infl_revenue), 150);
    assert.equal(Number(r.totals.utm_revenue), 150);
    const msg = r.by_message.find((m) => m.content === "lembrete_1" && m.channel === "sms");
    assert.equal(msg?.message_name, "Lembrete 1");
    assert.equal(r.by_channel.find((c) => c.channel === "sms")?.sent, 1);
    assert.equal(
      r.daily.reduce((a, d) => a + d.sent_sms, 0),
      1,
    );
  });

  test("a purchase after the attribution window is not influenced", async () => {
    const r = await call<{ totals: { infl_orders: number } }>("crm_results", {
      ...range(),
      p_window_days: 1,
    });
    assert.equal(r.totals.infl_orders, 1); // 2 h < 1 day
    await sql!`update crm.messages set executed_at = now() - interval '3 days' where template_key = 'rs_sms'`;
    const r2 = await call<{ totals: { infl_orders: number } }>("crm_results", {
      ...range(),
      p_window_days: 1,
    });
    assert.equal(r2.totals.infl_orders, 0);
  });
});
