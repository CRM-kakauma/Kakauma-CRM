/** Click tracking: store links of a sent message become CRM links that count the click. */
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
const BASE = "https://k.kakauma.com.br";
const sentTexts: string[] = [];
const fakePushfy = (async (_url: string, init: RequestInit = {}) => {
  const body = JSON.parse(String(init.body ?? "{}"));
  sentTexts.push(body.messages?.[0]?.text ?? "");
  return new Response(JSON.stringify({ accepted: 1, queued: 1 }), { status: 200 });
}) as unknown as typeof fetch;
const opts = {
  pushfy: { token: "t", fetchImpl: fakePushfy, live: true },
  links: { base: BASE, email: true },
};

describe("Click tracking", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.short_links`; // manual short links of other tests
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'ck_%')`;
    await sql!`delete from crm.flows where key like 'ck_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_upsert_template", {
      p_key: "ck_sms",
      p_name: "Lembrete 1",
      p_channel: "sms",
      p_purpose: "transactional",
      p_content: {
        text: "Kakauma: finalize em https://kakauma.com.br/checkout. Ou veja https://instagram.com/kakauma",
      },
    });
    await call("crm_save_flow", {
      p_key: "ck_flow",
      p_name: "Carrinho abandonado",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "ck_sms" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    assert.equal(await call("crm_publish_flow", { p_key: "ck_flow" }), 1);
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'ck_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("the SMS goes out with a short CRM link; the click is counted per message", async () => {
    const now = new Date().toISOString();
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("abandoned-cart", {
          customer: {
            id: "cus_ck",
            full_name: "Cora K",
            email: "ck@example.com",
            whatsapp: "11977773333",
          },
          created_at: now,
          updated_at: now,
        }),
      ),
    );
    await runFlows(rpc, opts);
    const text = sentTexts.at(-1)!;
    const m = /https:\/\/k\.kakauma\.com\.br\/l\/([A-Za-z0-9]{7})\./.exec(text);
    assert.ok(m, text); // the final period stays outside the link
    assert.match(text, /https:\/\/instagram\.com\/kakauma$/); // other sites untouched
    // the code leads to the store page with the UTMs (flow and message names)
    const url = await call<string>("crm_open_short_link", { p_code: m[1] });
    assert.equal(
      url,
      "https://kakauma.com.br/checkout?utm_source=sms&utm_medium=crm&utm_campaign=carrinho_abandonado&utm_content=lembrete_1",
    );
    await call("crm_open_short_link", { p_code: m[1] });
    const [msg] =
      await sql!`select clicked_at, rendered->>'text' as t from crm.messages where template_key = 'ck_sms'`;
    assert.ok(msg!["clicked_at"], "message marked as clicked");
    assert.match(String(msg!["t"]), /k\.kakauma\.com\.br\/l\//); // what was really sent is kept
    const r = await call<{ by_flow: { campaign: string; clicks: number }[] }>("crm_results", {
      p_from: new Date(Date.now() - 86_400_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
      p_window_days: 7,
    });
    // two clicks on the same message: one clicked message
    assert.equal(r.by_flow.find((f) => f.campaign === "carrinho_abandonado")?.clicks, 1);
    // her purchase with the CRM's UTMs does not count that click again
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: {
            id: "cus_ck",
            full_name: "Cora K",
            email: "ck@example.com",
            whatsapp: "11977773333",
          },
          sale_id: "CK-1",
          payment_method: "pix",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
          charges: [{ id: "CCK-1", amount: 100 }],
          utm: { utm_source: "sms", utm_medium: "crm", utm_campaign: "carrinho_abandonado" },
        }),
      ),
    );
    const r2 = await call<{ by_flow: { campaign: string; clicks: number; utm_orders: number }[] }>(
      "crm_results",
      {
        p_from: new Date(Date.now() - 86_400_000).toISOString(),
        p_to: new Date(Date.now() + 60_000).toISOString(),
        p_window_days: 7,
      },
    );
    const f2 = r2.by_flow.find((f) => f.campaign === "carrinho_abandonado");
    assert.deepEqual([f2?.clicks, f2?.utm_orders], [1, 1]);
  });

  test("utm_source extended by the site still counts as its channel", async () => {
    const [x] = await sql!`select crm.utm_channel('emailjLj6ad6764ba4c3619b682e8e3e') as a,
                                  crm.utm_channel('SMS') as b, crm.utm_channel('facebook') as c`;
    assert.deepEqual([x!["a"], x!["b"], x!["c"]], ["email", "sms", "facebook"]);
  });
});
