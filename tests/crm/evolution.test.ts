/** WhatsApp through Evolution API: sending (text / media), errors, webhook statuses and PARAR. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import {
  evolutionError,
  evolutionItems,
  evolutionPlan,
  evolutionSend,
  evolutionSetWebhook,
  evolutionStatus,
} from "../../src/server/crm/evolution.ts";
import { renderMessage } from "../../src/lib/crm-messages.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
function fakeFetch(responses: { status: number; body: unknown }[] = []) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? {
      status: 201,
      body: {
        key: { remoteJid: "x@s.whatsapp.net", fromMe: true, id: `EVO${calls.length}` },
        status: "PENDING",
      },
    };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const cfg = (impl: typeof fetch) => ({
  baseUrl: "https://evo.example.com/",
  apiKey: "KEY",
  instance: "kakauma",
  fetchImpl: impl,
});

describe("Evolution API", () => {
  test("text: header, body, links and code go in the message; apikey header", async () => {
    const rendered = renderMessage(
      "whatsapp",
      {
        category: "marketing",
        header: { type: "text", text: "Oi {{first_name}}" },
        body: "Seu pedido chegou.",
        footer: "Kakauma",
        buttons: [
          { type: "url", text: "Ver", url: "https://kakauma.com.br/x" },
          { type: "quick_reply", text: "Ok" },
        ],
      },
      { first_name: "Ana" },
    );
    const f = fakeFetch();
    const r = await evolutionSend(cfg(f.impl), "(11) 98888-7777", rendered);
    assert.equal(r.ok, true);
    assert.equal(r.id, "EVO1");
    assert.equal(f.calls[0]!.url, "https://evo.example.com/message/sendText/kakauma");
    assert.equal(f.calls[0]!.headers["apikey"], "KEY");
    assert.deepEqual(f.calls[0]!.body, {
      number: "5511988887777",
      text: "*Oi Ana*\n\nSeu pedido chegou.\n\nVer: https://kakauma.com.br/x\n\n_Kakauma_",
      linkPreview: true,
    });
  });

  test("image header: sendMedia with caption", () => {
    const p = evolutionPlan({
      header: { type: "image", url: "https://cdn/x.png" },
      body: "Olha",
      buttons: [],
    });
    assert.deepEqual(p, {
      kind: "media",
      mediatype: "image",
      media: "https://cdn/x.png",
      text: "Olha",
    });
  });

  test("errors: number without WhatsApp is final; disconnected is retried", async () => {
    const f = fakeFetch([
      {
        status: 400,
        body: {
          status: 400,
          error: "Bad Request",
          response: { message: [{ exists: false, number: "55119" }] },
        },
      },
    ]);
    const r = await evolutionSend(cfg(f.impl), "11988887777", { body: "oi" });
    assert.equal(r.ok, false);
    assert.equal(r.permanent, true);
    assert.equal(r.error, "Número sem WhatsApp");
    assert.equal(
      evolutionError(500, { response: { message: ["Connection Closed"] } }).permanent,
      false,
    );
    assert.match(evolutionError(401, {}).error, /EVOLUTION_API_KEY/);
    const bad = await evolutionSend(cfg(f.impl), "123", { body: "oi" });
    assert.equal(bad.error, "Telefone inválido");
  });

  test("state, number and webhook registration", async () => {
    const f = fakeFetch([
      { status: 200, body: { instance: { instanceName: "kakauma", state: "open" } } },
      {
        status: 200,
        body: [
          { name: "kakauma", ownerJid: "5511940000000@s.whatsapp.net", profileName: "Kakauma" },
        ],
      },
      { status: 201, body: { webhook: {} } },
    ]);
    const s = await evolutionStatus(cfg(f.impl));
    assert.deepEqual(s, { ok: true, state: "open", number: "5511940000000", name: "Kakauma" });
    assert.deepEqual(
      await evolutionSetWebhook(cfg(f.impl), "https://crm/api/webhooks/evolution?token=t"),
      {
        ok: true,
      },
    );
    assert.equal(f.calls[2]!.url, "https://evo.example.com/webhook/set/kakauma");
    assert.equal(f.calls[2]!.body.webhook.url, "https://crm/api/webhooks/evolution?token=t");
    assert.ok(f.calls[2]!.body.webhook.events.includes("MESSAGES_UPDATE"));
    // Evolution v2.0: the flat form when the nested one is refused
    const old = fakeFetch([
      { status: 400, body: { response: { message: ['instance requires property "url"'] } } },
      { status: 201, body: {} },
    ]);
    assert.deepEqual(await evolutionSetWebhook(cfg(old.impl), "https://crm/x"), { ok: true });
    assert.equal(old.calls[1]!.body.url, "https://crm/x");
    assert.equal(old.calls[1]!.body.webhookByEvents, false);
  });

  test("webhook: statuses mapped; only opt-out words from customers are kept", () => {
    const items = evolutionItems({
      event: "messages.update",
      instance: "kakauma",
      data: {
        keyId: "EVO1",
        remoteJid: "5511988887777@s.whatsapp.net",
        fromMe: true,
        status: "DELIVERY_ACK",
      },
    });
    assert.deepEqual(items[0]![0], "status");
    assert.equal(items[0]![1]["status"], "delivered");
    assert.equal(items[0]![1]["id"], "EVO1");
    const up = (text: string, fromMe = false, jid = "5511988887777@s.whatsapp.net") =>
      evolutionItems({
        event: "MESSAGES_UPSERT",
        data: { key: { remoteJid: jid, fromMe, id: "IN1" }, message: { conversation: text } },
      });
    assert.equal(up(" Parar ")[0]![1]["from"], "5511988887777");
    assert.equal(up("oi, quero comprar").length, 0); // conversations are not stored
    assert.equal(up("parar", true).length, 0); // our own messages
    assert.equal(up("parar", false, "1203630@g.us").length, 0); // groups
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async <T = unknown>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};

describe("Evolution in the CRM", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.provider_events where provider = 'whatsapp'`;
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'ev_%')`;
    await sql!`delete from crm.flows where key like 'ev_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'ev_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("the flow sends through Evolution; read and PARAR come back by webhook", async () => {
    await call("crm_upsert_template", {
      p_key: "ev_msg",
      p_name: "Compra aprovada WA",
      p_channel: "whatsapp",
      p_purpose: "transactional",
      p_content: {
        category: "utility",
        header: { type: "none" },
        body: "Oi {{first_name}}, pedido aprovado!",
        footer: "",
        buttons: [],
      },
    });
    await call("crm_save_flow", {
      p_key: "ev_flow",
      p_name: "Compra aprovada",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "ev_msg" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    assert.equal(await call("crm_publish_flow", { p_key: "ev_flow" }), 1);
    const now = new Date().toISOString();
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: {
            id: "cus_ev",
            full_name: "Eva V",
            email: "ev@example.com",
            whatsapp: "(11) 96666-5555",
          },
          sale_id: "EV-1",
          payment_method: "pix",
          created_at: now,
          updated_at: now,
          paid_at: now,
          charges: [{ id: "CEV", amount: 90 }],
        }),
      ),
    );
    const f = fakeFetch();
    // both providers set: Evolution takes the place of the official API
    await runFlows(rpc, {
      evolution: { ...cfg(f.impl), live: true },
      whatsapp: { token: "x", phoneNumberId: "y", live: true, fetchImpl: f.impl },
    });
    const [m] =
      await sql!`select message_id, status, result from crm.messages where template_key = 'ev_msg'`;
    assert.equal(m!["status"], "SENT");
    assert.equal((m!["result"] as any).provider, "evolution");
    assert.equal((m!["result"] as any).wamid, "EVO1");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.body.text, "Oi Eva, pedido aprovado!");

    const save = async (body: unknown) => {
      for (const [kind, payload] of evolutionItems(body))
        await call("crm_whatsapp_event", { p_kind: kind, p_payload: payload });
    };
    await save({ event: "messages.update", data: { keyId: "EVO1", status: "SERVER_ACK" } });
    await save({ event: "messages.update", data: { keyId: "EVO1", status: "READ" } });
    await save({ event: "messages.update", data: { keyId: "EVO1", status: "DELIVERY_ACK" } }); // late
    const [row] =
      await sql!`select provider_status, delivered_at, opened_at from crm.messages where message_id = ${m!["message_id"]}`;
    assert.equal(row!["provider_status"], "Read");
    assert.ok(row!["delivered_at"] && row!["opened_at"]);

    await save({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "5511966665555@s.whatsapp.net", fromMe: false, id: "IN9" },
        message: { conversation: "SAIR" },
      },
    });
    const opts =
      await sql!`select o.channel from crm.channel_optouts o join crm.customers c using (customer_id)
                             where c.email = 'ev@example.com'`;
    assert.deepEqual(
      opts.map((o) => o["channel"]),
      ["whatsapp"],
    );
  });
});
