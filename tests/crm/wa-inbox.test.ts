/** WhatsApp inbox: Evolution webhooks → conversations and messages. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { ingestWebhook } from "../../src/server/crm/pipeline.ts";
import {
  content,
  instanceName,
  parseWaWebhook,
  phoneToJid,
  waMessageFrom,
  waSend,
} from "../../src/server/crm/wa-inbox.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const upsert = (data: Record<string, unknown>, instance = "Kakauma") => ({
  event: "messages.upsert",
  instance,
  data,
  date_time: "2026-11-08T12:00:00.000Z",
});
const inbound = (
  id: string,
  text: string,
  jid = "5531988887777@s.whatsapp.net",
  ts = 1793880000,
) => ({
  key: { remoteJid: jid, fromMe: false, id },
  pushName: "Maria",
  message: { conversation: text },
  messageType: "conversation",
  messageTimestamp: ts,
});

describe("Evolution → inbox items", () => {
  test("text, from the customer and from the phone", () => {
    const a = parseWaWebhook(upsert(inbound("A1", "Oi, meu pedido?")));
    assert.equal(a.instance, "Kakauma");
    assert.deepEqual(a.messages[0], {
      wa_id: "A1",
      remote_jid: "5531988887777@s.whatsapp.net",
      phone: "5531988887777",
      from_me: false,
      push_name: "Maria",
      type: "text",
      body: "Oi, meu pedido?",
      media: null,
      status: null,
      at: new Date(1793880000 * 1000).toISOString(),
    });
    const b = parseWaWebhook(
      upsert({
        key: { remoteJid: "5531988887777@s.whatsapp.net", fromMe: true, id: "B1" },
        message: {
          extendedTextMessage: {
            text: "Já saiu!",
            contextInfo: { quotedMessage: { conversation: "Oi, meu pedido?" } },
          },
        },
        messageTimestamp: 1793880060,
        status: "SERVER_ACK",
      }),
    );
    assert.equal(b.messages[0]!.from_me, true);
    assert.equal(b.messages[0]!.push_name, null);
    assert.equal(b.messages[0]!.status, "sent");
    assert.deepEqual(b.messages[0]!.media, { quoted: "Oi, meu pedido?" });
  });

  test("media, ephemeral wrapper, location and contact", () => {
    assert.deepEqual(content({ imageMessage: { mimetype: "image/jpeg", caption: "olha" } }), {
      type: "image",
      body: "olha",
      media: { mimetype: "image/jpeg" },
    });
    assert.equal(
      content({
        ephemeralMessage: {
          message: { audioMessage: { mimetype: "audio/ogg", seconds: 7, ptt: true } },
        },
      }).type,
      "audio",
    );
    assert.equal(
      content({
        documentWithCaptionMessage: {
          message: { documentMessage: { fileName: "nota.pdf", mimetype: "application/pdf" } },
        },
      }).media?.["file_name"],
      "nota.pdf",
    );
    assert.deepEqual(
      content({ locationMessage: { degreesLatitude: -19.9, degreesLongitude: -43.9 } }).media,
      {
        lat: -19.9,
        lng: -43.9,
      },
    );
    assert.equal(
      content({
        contactMessage: {
          displayName: "João",
          vcard: "BEGIN:VCARD\nTEL;type=CELL:+55 31 99999-0000\nEND:VCARD",
        },
      }).media?.["phone"],
      "+55 31 99999-0000",
    );
  });

  test("groups, status stories and reactions are left out; LID uses the phone jid", () => {
    assert.equal(waMessageFrom(inbound("G1", "oi", "1203630@g.us")), null);
    assert.equal(waMessageFrom(inbound("S1", "oi", "status@broadcast")), null);
    assert.equal(
      waMessageFrom({ ...inbound("R1", ""), message: { reactionMessage: { text: "👍" } } }),
      null,
    );
    const lid = waMessageFrom({
      ...inbound("L1", "oi", "123456789@lid"),
      key: {
        remoteJid: "123456789@lid",
        remoteJidAlt: "5531977776666@s.whatsapp.net",
        fromMe: false,
        id: "L1",
      },
    });
    assert.equal(lid?.remote_jid, "5531977776666@s.whatsapp.net");
    assert.equal(lid?.phone, "5531977776666");
  });

  test("statuses and connection", () => {
    const s = parseWaWebhook({
      event: "messages.update",
      instance: "Kakauma",
      data: { keyId: "B1", status: "READ", remoteJid: "x@s.whatsapp.net" },
    });
    assert.deepEqual(s.statuses, [{ wa_id: "B1", status: "read" }]);
    const c = parseWaWebhook({
      event: "CONNECTION_UPDATE",
      instance: "Vendas",
      data: { state: "open" },
    });
    assert.equal(c.state, "open");
  });

  test("phone and instance names", () => {
    assert.deepEqual(phoneToJid("(31) 98888-7777"), {
      phone: "5531988887777",
      jid: "5531988887777@s.whatsapp.net",
    });
    assert.equal(phoneToJid("123"), null);
    assert.match(instanceName("Atendimento Ana"), /^kakauma-atendimento-ana-[a-z0-9]{4}$/);
  });

  test("send: text with reply, image, voice note", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ key: { id: `W${calls.length}` } }), { status: 201 });
    }) as unknown as typeof fetch;
    const cfg = { baseUrl: "https://evo.test/", apiKey: "K", fetchImpl };
    const t = await waSend(cfg, "Kakauma", {
      number: "5531988887777",
      text: "Oi!",
      quoted: { id: "A1", text: "Oi, meu pedido?" },
    });
    assert.ok(t.ok);
    assert.equal(calls[0]!.url, "https://evo.test/message/sendText/Kakauma");
    assert.deepEqual(calls[0]!.body["quoted"], {
      key: { id: "A1" },
      message: { conversation: "Oi, meu pedido?" },
    });
    const img = await waSend(cfg, "Kakauma", {
      number: "5531988887777",
      text: "foto",
      media: { data: "AAAA", mimetype: "image/png", fileName: "a.png" },
    });
    assert.ok(img.ok && img.type === "image");
    assert.equal(calls[1]!.url, "https://evo.test/message/sendMedia/Kakauma");
    assert.equal(calls[1]!.body["mediatype"], "image");
    const audio = await waSend(cfg, "Kakauma", {
      number: "5531988887777",
      media: { data: "BBBB", mimetype: "audio/webm" },
    });
    assert.ok(audio.ok && audio.type === "audio");
    assert.equal(calls[2]!.url, "https://evo.test/message/sendWhatsAppAudio/Kakauma");
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data;
};
const save = (body: unknown) => {
  const w = parseWaWebhook(body);
  return call("crm_wa_ingest", {
    p_instance: w.instance,
    p_messages: w.messages,
    p_statuses: w.statuses,
    p_state: w.state,
    p_history: false,
  });
};
type Chat = {
  chat_id: string;
  unread: number;
  last_preview: string;
  customer_name: string | null;
  last_status: string | null;
};

describe("Inbox in the database", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.wa_messages`;
    await sql!`delete from crm.wa_chats`;
    await sql!`delete from crm.wa_instances`;
    // a B4you customer whose WhatsApp has the 9th digit; WhatsApp sends it without
    const r = await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: {
            id: "cus_wa",
            full_name: "Maria Souza",
            email: "maria.wa@example.com",
            whatsapp: "(31) 98888-7777",
          },
          sale_id: "S-WA",
          charges: [{ id: "C-WA", amount: 100 }],
        }),
      ),
    );
    assert.ok(r.status < 300);
  });
  after(async () => {
    await sql?.end();
  });

  test("conversation, unread, customer by phone (with or without the 9th digit)", async () => {
    await save(upsert(inbound("A1", "Oi, meu pedido?", "553188887777@s.whatsapp.net", 1793880000)));
    await save(upsert(inbound("A2", "Alô?", "553188887777@s.whatsapp.net", 1793880030)));
    await save(upsert(inbound("A2", "Alô?", "553188887777@s.whatsapp.net", 1793880030))); // webhook again
    const chats = (await call("crm_wa_chats", { p_instance: "Kakauma" })) as Chat[];
    assert.equal(chats.length, 1);
    assert.equal(chats[0]!.unread, 2);
    assert.equal(chats[0]!.last_preview, "Alô?");
    assert.equal(chats[0]!.customer_name, "Maria Souza");
    const msgs = (await call("crm_wa_messages", { p_chat: chats[0]!.chat_id })) as {
      wa_id: string;
    }[];
    assert.deepEqual(
      msgs.map((m) => m.wa_id),
      ["A1", "A2"],
    );
  });

  test("an answer reads the chat; statuses only move forward", async () => {
    await save(
      upsert({
        key: { remoteJid: "553188887777@s.whatsapp.net", fromMe: true, id: "B1" },
        message: { conversation: "Saiu hoje!" },
        messageTimestamp: 1793880100,
        status: "SERVER_ACK",
      }),
    );
    await save({
      event: "messages.update",
      instance: "Kakauma",
      data: { keyId: "B1", status: "READ" },
    });
    await save({
      event: "messages.update",
      instance: "Kakauma",
      data: { keyId: "B1", status: "DELIVERY_ACK" },
    });
    const [c] = (await call("crm_wa_chats", { p_instance: "Kakauma" })) as Chat[];
    assert.equal(c!.unread, 0);
    assert.equal(c!.last_status, "read");
    const [m] = await sql!`select status from crm.wa_messages where wa_id = 'B1'`;
    assert.equal(m!["status"], "read");
  });

  test("history brings old messages without marking them unread; search and filters", async () => {
    await call("crm_wa_ingest", {
      p_instance: "Kakauma",
      p_messages: [
        waMessageFrom(inbound("H0", "mensagem antiga", "553188887777@s.whatsapp.net", 1790000000)),
      ],
      p_history: true,
    });
    const [c] = (await call("crm_wa_chats", { p_instance: "Kakauma" })) as Chat[];
    assert.equal(c!.unread, 0);
    assert.equal(c!.last_preview, "Saiu hoje!"); // the old one does not take the preview
    assert.equal(
      ((await call("crm_wa_chats", { p_instance: "Kakauma", p_search: "maria" })) as Chat[]).length,
      1,
    );
    assert.equal(
      ((await call("crm_wa_chats", { p_instance: "Kakauma", p_search: "8888" })) as Chat[]).length,
      1,
    );
    assert.equal(
      ((await call("crm_wa_chats", { p_instance: "Kakauma", p_filter: "unread" })) as Chat[])
        .length,
      0,
    );
  });

  test("opening from the customer page reuses the conversation (with or without the 9th digit)", async () => {
    const [existing] = await sql!`select chat_id from crm.wa_chats where phone = '553188887777'`;
    // the customer page has the number with the 9; WhatsApp uses it without
    const id = await call("crm_wa_open_chat", {
      p_instance: "Kakauma",
      p_remote_jid: "5531988887777@s.whatsapp.net",
      p_phone: "5531988887777",
      p_name: "Maria",
    });
    assert.equal(id, existing!["chat_id"]);
    const [n] = await sql!`select count(*)::int as n from crm.wa_chats where instance = 'Kakauma'`;
    assert.equal(n!["n"], 1);
  });

  test("numbers: several instances, each with its own conversations", async () => {
    await call("crm_wa_save_instance", { p_name: "vendas", p_label: "Vendas", p_color: "#7C3AED" });
    await save(upsert(inbound("V1", "Quero comprar", "5511977776666@s.whatsapp.net"), "vendas"));
    const list = (await call("crm_wa_instances")) as {
      name: string;
      unread: number;
      label: string;
    }[];
    const byName = Object.fromEntries(list.map((i) => [i.name, i]));
    assert.equal(byName["vendas"]!.label, "Vendas");
    assert.equal(Number(byName["vendas"]!.unread), 1);
    assert.equal(((await call("crm_wa_chats", { p_instance: "vendas" })) as Chat[]).length, 1);
    const id = await call("crm_wa_open_chat", {
      p_instance: "vendas",
      p_remote_jid: "5531955554444@s.whatsapp.net",
      p_phone: "5531955554444",
      p_name: "Novo",
    });
    assert.ok(id);
    await call("crm_wa_delete_instance", { p_name: "vendas" });
    const [n] = await sql!`select count(*)::int as n from crm.wa_chats where instance = 'vendas'`;
    assert.equal(n!["n"], 0);
  });
});
