/**
 * WhatsApp inbox (atendimento): any number of WhatsApp numbers through Evolution API v2.
 *
 *   POST   /instance/create                     { instanceName, integration, qrcode, webhook }
 *   GET    /instance/connect/{i}                → QR (base64)
 *   DELETE /instance/logout/{i}, /instance/delete/{i}
 *   POST   /message/sendText/{i}                { number, text, quoted? }
 *   POST   /message/sendMedia/{i}               { number, mediatype, mimetype, media (base64), caption, fileName }
 *   POST   /message/sendWhatsAppAudio/{i}       { number, audio (base64) }
 *   POST   /chat/getBase64FromMediaMessage/{i}  { message: { key: { id } } }
 *   POST   /chat/findChats/{i}, /chat/findMessages/{i}
 *   POST   /chat/markMessageAsRead/{i}          { readMessages: [{ remoteJid, fromMe, id }] }
 *
 * Webhook events (same URL as the flows): messages.upsert (customer, phone and API),
 * messages.update (statuses), send.message, connection.update.
 * Groups, broadcasts and status stories are left out: 1:1 conversations only.
 */
import { evolutionCall, evolutionError, type EvolutionConfig } from "./evolution.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null;

export interface WaMessage {
  wa_id: string;
  remote_jid: string;
  phone: string | null;
  from_me: boolean;
  push_name: string | null;
  type: string;
  body: string | null;
  media: Obj | null;
  status: string | null;
  at: string;
  sent_by?: string | null;
}

const STATUS: Record<string, string> = {
  PENDING: "pending",
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
  "0": "failed",
  "1": "pending",
  "2": "sent",
  "3": "delivered",
  "4": "read",
  "5": "read",
};

/** 1:1 chats only: groups, newsletters, broadcasts and status stories are skipped. */
export function isPersonJid(jid: string | null): jid is string {
  return (
    !!jid &&
    (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid") || jid.endsWith("@c.us")) &&
    !jid.startsWith("status@")
  );
}

export function jidDigits(jid: string | null | undefined): string | null {
  if (!jid || !/@(s\.whatsapp\.net|c\.us)$/.test(jid)) return null;
  const d = jid.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");
  return d.length >= 10 ? d : null;
}

/** Digits with the country code (Brazil when missing) → the jid WhatsApp uses. */
export function phoneToJid(phone: string): { phone: string; jid: string } | null {
  let d = phone.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (d.length < 12 || d.length > 15) return null;
  return { phone: d, jid: `${d}@s.whatsapp.net` };
}

const tsIso = (v: unknown): string => {
  const n = Number(isObj(v) ? (v["low"] ?? v["high"]) : v);
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
};

/** The message itself, without the ephemeral / view-once / edited wrappers. */
function unwrap(message: Obj): Obj {
  let m = message;
  for (let i = 0; i < 4; i++) {
    const inner =
      obj(m["ephemeralMessage"])["message"] ??
      obj(m["viewOnceMessage"])["message"] ??
      obj(m["viewOnceMessageV2"])["message"] ??
      obj(m["documentWithCaptionMessage"])["message"] ??
      obj(m["editedMessage"])["message"];
    if (!isObj(inner)) break;
    m = inner;
  }
  return m;
}

function quotedText(ctx: Obj): string | null {
  const q = obj(ctx["quotedMessage"]);
  if (!Object.keys(q).length) return null;
  const c = content(q);
  return c.body ?? (c.type === "text" ? null : `[${c.type}]`);
}

/** Type, text and media data of a WhatsApp message. */
export function content(message0: Obj): { type: string; body: string | null; media: Obj | null } {
  const m = unwrap(message0);
  const ctx = (x: Obj) => {
    const q = quotedText(obj(x["contextInfo"]));
    return q ? { quoted: q } : {};
  };
  if (typeof m["conversation"] === "string")
    return { type: "text", body: m["conversation"], media: null };
  const ext = obj(m["extendedTextMessage"]);
  if (str(ext["text"])) {
    const extra = ctx(ext);
    return {
      type: "text",
      body: String(ext["text"]),
      media: Object.keys(extra).length ? extra : null,
    };
  }
  const kinds: [string, string][] = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ];
  for (const [k, type] of kinds) {
    const x = obj(m[k]);
    if (!Object.keys(x).length) continue;
    return {
      type,
      body: str(x["caption"]),
      media: {
        mimetype: str(x["mimetype"]),
        ...(str(x["fileName"]) ? { file_name: str(x["fileName"]) } : {}),
        ...(x["seconds"] !== undefined ? { seconds: Number(x["seconds"]) || 0 } : {}),
        ...(x["ptt"] ? { ptt: true } : {}),
        ...(x["fileLength"] !== undefined
          ? { size: Number(obj(x["fileLength"])["low"] ?? x["fileLength"]) || null }
          : {}),
        ...ctx(x),
      },
    };
  }
  const loc = obj(m["locationMessage"] ?? m["liveLocationMessage"]);
  if (Object.keys(loc).length)
    return {
      type: "location",
      body: str(loc["name"]) ?? str(loc["address"]),
      media: { lat: Number(loc["degreesLatitude"]), lng: Number(loc["degreesLongitude"]) },
    };
  const contact = obj(m["contactMessage"]);
  if (Object.keys(contact).length) {
    const vcard = String(contact["vcard"] ?? "");
    const tel = /TEL[^:]*:([+\d\s()-]+)/.exec(vcard)?.[1]?.trim() ?? null;
    return {
      type: "contact",
      body: str(contact["displayName"]),
      media: tel ? { phone: tel } : null,
    };
  }
  const buttons =
    str(obj(m["buttonsResponseMessage"])["selectedDisplayText"]) ??
    str(obj(obj(m["listResponseMessage"])["singleSelectReply"])["selectedRowId"]) ??
    str(obj(m["listResponseMessage"])["title"]) ??
    str(obj(m["templateButtonReplyMessage"])["selectedDisplayText"]);
  if (buttons) return { type: "text", body: buttons, media: null };
  return { type: "other", body: null, media: null };
}

/** Kinds that are not conversation messages (reactions, deletions, keys, polls updates…). */
function ignorable(message: Obj): boolean {
  const m = unwrap(message);
  return [
    "protocolMessage",
    "reactionMessage",
    "senderKeyDistributionMessage",
    "pollUpdateMessage",
    "messageContextInfo",
  ].some((k) => k in m && Object.keys(m).every((x) => x === k || x === "messageContextInfo"));
}

/** An Evolution message record (webhook messages.upsert / send.message, or findMessages). */
export function waMessageFrom(d: Obj): WaMessage | null {
  const key = obj(d["key"]);
  const id = str(key["id"]) ?? str(d["keyId"]);
  // LID chats: the phone may come in remoteJidAlt / senderPn
  const jid0 = str(key["remoteJid"]) ?? str(d["remoteJid"]);
  const alt = str(key["remoteJidAlt"]) ?? str(key["senderPn"]) ?? str(d["senderPn"]);
  const jid = jid0?.endsWith("@lid") && alt && /@s\.whatsapp\.net$/.test(alt) ? alt : jid0;
  if (!id || !isPersonJid(jid)) return null;
  const message = obj(d["message"]);
  if (!Object.keys(message).length || ignorable(message)) return null;
  const c = content(message);
  const fromMe = key["fromMe"] === true || d["fromMe"] === true;
  return {
    wa_id: id,
    remote_jid: jid,
    phone: jidDigits(jid) ?? jidDigits(alt),
    from_me: fromMe,
    push_name: fromMe ? null : str(d["pushName"]),
    type: c.type,
    body: c.body,
    media: c.media,
    status: fromMe ? (STATUS[String(d["status"] ?? "")] ?? "sent") : null,
    at: tsIso(d["messageTimestamp"] ?? d["date_time"]),
  };
}

export interface WaWebhook {
  instance: string | null;
  messages: WaMessage[];
  statuses: { wa_id: string; status: string }[];
  state: string | null;
}

/** An Evolution webhook body → what the inbox stores. */
export function parseWaWebhook(body: unknown): WaWebhook {
  const b = obj(body);
  const event = String(b["event"] ?? "")
    .toLowerCase()
    .replace(/_/g, ".");
  const instance = str(b["instance"]) ?? str(obj(b["data"])["instance"]);
  const data = Array.isArray(b["data"]) ? (b["data"] as unknown[]) : b["data"] ? [b["data"]] : [];
  const out: WaWebhook = { instance, messages: [], statuses: [], state: null };
  for (const d0 of data) {
    const d = obj(d0);
    if (event === "messages.upsert" || event === "send.message") {
      const m = waMessageFrom(d);
      if (m) out.messages.push(m);
    } else if (event === "messages.update") {
      const st = STATUS[String(d["status"] ?? obj(d["update"])["status"] ?? "")];
      const id = str(d["keyId"]) ?? str(obj(d["key"])["id"]) ?? str(d["messageId"]);
      if (st && id) out.statuses.push({ wa_id: id, status: st });
    } else if (event === "connection.update") {
      out.state = str(d["state"]);
    }
  }
  return out;
}

// --------------------------------------------------------------- Evolution calls

const enc = encodeURIComponent;
type Cfg = Omit<EvolutionConfig, "instance">;
const at = (c: Cfg, instance: string): EvolutionConfig => ({ ...c, instance });

function fail(res: { status: number; body: unknown }) {
  return { ok: false as const, error: evolutionError(res.status, res.body).error };
}

export const WA_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
];

/** A new WhatsApp number: the instance, with the CRM webhook already set. */
export async function waCreateInstance(c: Cfg, name: string, webhookUrl: string) {
  const res = await evolutionCall(at(c, name), "POST", "/instance/create", {
    instanceName: name,
    integration: "WHATSAPP-BAILEYS",
    qrcode: true,
    webhook: { url: webhookUrl, byEvents: false, base64: false, events: WA_EVENTS },
  });
  if (res.status >= 200 && res.status < 300) {
    const qr = obj(obj(res.body)["qrcode"]);
    return { ok: true as const, qr: str(qr["base64"]) };
  }
  return fail(res);
}

export async function waLogout(c: Cfg, name: string) {
  const res = await evolutionCall(at(c, name), "DELETE", `/instance/logout/${enc(name)}`);
  return res.status < 300 || res.status === 404 ? { ok: true as const } : fail(res);
}

export async function waDeleteInstance(c: Cfg, name: string) {
  const res = await evolutionCall(at(c, name), "DELETE", `/instance/delete/${enc(name)}`);
  return res.status < 300 || res.status === 404 ? { ok: true as const } : fail(res);
}

export interface WaSend {
  number: string;
  text?: string | null;
  /** base64 without the data: prefix */
  media?: { data: string; mimetype: string; fileName?: string | null } | null;
  /** the message answered (WhatsApp "responder") */
  quoted?: { id: string; text?: string | null } | null;
}

function mediatype(mime: string): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/") && !mime.includes("svg")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/** Sends from the inbox; answers the WhatsApp id and how the message is stored. */
export async function waSend(c: Cfg, instance: string, s: WaSend) {
  const cfg = at(c, instance);
  const quoted = s.quoted?.id
    ? { quoted: { key: { id: s.quoted.id }, message: { conversation: s.quoted.text ?? "" } } }
    : {};
  let res;
  let type = "text";
  let media: Obj | null = s.quoted?.text ? { quoted: s.quoted.text } : null;
  if (s.media) {
    const kind = mediatype(s.media.mimetype);
    if (kind === "audio") {
      type = "audio";
      res = await evolutionCall(cfg, "POST", `/message/sendWhatsAppAudio/${enc(instance)}`, {
        number: s.number,
        audio: s.media.data,
        encoding: true,
        ...quoted,
      });
      media = { ...media, mimetype: "audio/ogg", ptt: true };
    } else {
      type = kind;
      res = await evolutionCall(cfg, "POST", `/message/sendMedia/${enc(instance)}`, {
        number: s.number,
        mediatype: kind,
        mimetype: s.media.mimetype,
        media: s.media.data,
        caption: s.text ?? "",
        fileName: s.media.fileName ?? (kind === "document" ? "arquivo" : undefined),
        ...quoted,
      });
      media = {
        ...media,
        mimetype: s.media.mimetype,
        ...(s.media.fileName ? { file_name: s.media.fileName } : {}),
      };
    }
  } else {
    res = await evolutionCall(cfg, "POST", `/message/sendText/${enc(instance)}`, {
      number: s.number,
      text: s.text ?? "",
      linkPreview: true,
      ...quoted,
    });
  }
  const id = str(obj(obj(res.body)["key"])["id"]);
  if (res.status >= 200 && res.status < 300 && id)
    return { ok: true as const, id, type, media, body: s.text ?? null };
  return fail(res);
}

/** A media message as a file (base64 + mimetype), fetched from Evolution when opened. */
export async function waMedia(c: Cfg, instance: string, waId: string) {
  const res = await evolutionCall(
    at(c, instance),
    "POST",
    `/chat/getBase64FromMediaMessage/${enc(instance)}`,
    { message: { key: { id: waId } }, convertToMp4: false },
  );
  const b = obj(res.body);
  const data = str(b["base64"]);
  if (res.status >= 200 && res.status < 300 && data)
    return { ok: true as const, data, mimetype: str(b["mimetype"]) ?? "application/octet-stream" };
  return fail(res);
}

/** Older messages of a chat kept by Evolution (when the server stores them). */
export async function waHistory(c: Cfg, instance: string, remoteJid: string, page = 1) {
  const res = await evolutionCall(at(c, instance), "POST", `/chat/findMessages/${enc(instance)}`, {
    where: { key: { remoteJid } },
    page,
    offset: 50,
  });
  if (res.status < 200 || res.status >= 300) return fail(res);
  const b = obj(res.body);
  const box = obj(b["messages"]);
  const records = (
    Array.isArray(box["records"]) ? box["records"] : Array.isArray(res.body) ? res.body : []
  ) as unknown[];
  return {
    ok: true as const,
    messages: records.map((r) => waMessageFrom(obj(r))).filter((m): m is WaMessage => !!m),
    pages: Number(box["pages"]) || 1,
  };
}

/** Conversations the phone already has (to fill the list right after connecting). */
export async function waChats(c: Cfg, instance: string) {
  const res = await evolutionCall(at(c, instance), "POST", `/chat/findChats/${enc(instance)}`, {});
  if (res.status < 200 || res.status >= 300) return fail(res);
  const list = (Array.isArray(res.body) ? res.body : []) as unknown[];
  const out: WaMessage[] = [];
  for (const ch0 of list) {
    const ch = obj(ch0);
    const last = obj(ch["lastMessage"]);
    const m = Object.keys(last).length ? waMessageFrom(last) : null;
    if (m) {
      if (!m.from_me && !m.push_name) m.push_name = str(ch["pushName"]);
      out.push(m);
    }
  }
  return { ok: true as const, messages: out };
}

export async function waMarkRead(
  c: Cfg,
  instance: string,
  items: { remoteJid: string; id: string }[],
) {
  if (!items.length) return;
  await evolutionCall(at(c, instance), "POST", `/chat/markMessageAsRead/${enc(instance)}`, {
    readMessages: items.map((i) => ({ remoteJid: i.remoteJid, fromMe: false, id: i.id })),
  }).catch(() => null);
}

/** Instance name for a new number: letters, digits and dashes. */
export function instanceName(label: string) {
  const base =
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "whatsapp";
  return `kakauma-${base}-${Math.random().toString(36).slice(2, 6)}`;
}
