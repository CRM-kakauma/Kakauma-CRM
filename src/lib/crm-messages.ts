/**
 * Message templates for the four channels: content types, defaults, limits and
 * rendering. Shared by the editor (simulators) and the server worker, so what
 * the preview shows is exactly what is sent.
 */
import { renderTemplate } from "./crm-template.ts";

export type Channel = "email" | "sms" | "whatsapp" | "rcs";
export type Purpose = "marketing" | "transactional";

export type EmailBlock =
  | { type: "heading"; text: string; align?: "left" | "center" }
  | { type: "text"; text: string; align?: "left" | "center" }
  | { type: "button"; text: string; url: string; align?: "left" | "center" }
  | { type: "image"; url: string; alt?: string; link?: string }
  | { type: "divider" }
  | { type: "spacer"; size?: number };

export interface EmailContent {
  subject: string;
  preheader?: string;
  from_name?: string;
  accent?: string;
  footer?: string;
  blocks: EmailBlock[];
}
export interface SmsContent {
  text: string;
}
export interface WhatsappButton {
  type: "quick_reply" | "url" | "phone";
  text: string;
  url?: string;
  phone?: string;
}
export interface WhatsappContent {
  category: "marketing" | "utility";
  header?: { type: "none" | "text" | "image"; text?: string; url?: string };
  body: string;
  footer?: string;
  buttons?: WhatsappButton[];
}
export interface RcsCard {
  title: string;
  description?: string;
  media_url?: string;
  media_height?: "short" | "medium" | "tall";
}
export interface RcsSuggestion {
  type: "reply" | "url" | "dial";
  text: string;
  url?: string;
  phone?: string;
}
export interface RcsContent {
  kind: "text" | "card" | "carousel";
  text?: string;
  cards?: RcsCard[];
  suggestions?: RcsSuggestion[];
  fallback_sms: string;
}
export type Content = EmailContent | SmsContent | WhatsappContent | RcsContent;

export const CHANNEL_LABEL: Record<Channel | "team", string> = {
  email: "E-mail",
  sms: "SMS",
  whatsapp: "WhatsApp",
  rcs: "RCS",
  team: "Alerta para a equipe",
};

/** Variables available in every template ({{name}}), with a sample value for previews. */
export const VARIABLES: { key: string; label: string; sample: string | number }[] = [
  { key: "first_name", label: "Primeiro nome", sample: "Maria" },
  { key: "full_name", label: "Nome completo", sample: "Maria Souza" },
  { key: "email", label: "E-mail", sample: "maria@exemplo.com.br" },
  { key: "city", label: "Cidade", sample: "Campinas" },
  { key: "net_ltv", label: "LTV líquido (R$)", sample: 561 },
  { key: "paid_orders", label: "Pedidos pagos", sample: 3 },
  { key: "subscription_cycle", label: "Ciclo da assinatura", sample: 3 },
  { key: "days_since_last_purchase", label: "Dias desde a última compra", sample: 42 },
  { key: "lifecycle", label: "Etapa do ciclo de vida", sample: "ACTIVE_SUBSCRIBER" },
  { key: "risk", label: "Risco", sample: "AT_RISK" },
];
export const SAMPLE_CUSTOMER: Record<string, unknown> = Object.fromEntries(
  VARIABLES.map((v) => [v.key, v.sample]),
);

export function defaultContent(channel: Channel): Content {
  switch (channel) {
    case "email":
      return {
        subject: "{{first_name}}, temos uma novidade",
        preheader: "",
        from_name: "Kakauma",
        accent: "#075DA8",
        footer: "Kakauma · Você recebe este e-mail porque é cliente.",
        blocks: [
          { type: "heading", text: "Olá, {{first_name}}!" },
          { type: "text", text: "Escreva aqui a sua mensagem." },
          { type: "button", text: "Ver agora", url: "https://kakauma.com.br" },
        ],
      };
    case "sms":
      return { text: "Kakauma: oi {{first_name}}, " };
    case "whatsapp":
      return {
        category: "marketing",
        header: { type: "none" },
        body: "Oi {{first_name}}! ",
        footer: "",
        buttons: [],
      };
    case "rcs":
      return {
        kind: "card",
        cards: [
          { title: "Olá, {{first_name}}", description: "", media_url: "", media_height: "medium" },
        ],
        suggestions: [],
        fallback_sms: "Kakauma: oi {{first_name}}, ",
      };
  }
}

// ------------------------------------------------------------------ SMS

const GSM =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** Segments of an SMS: GSM-7 (160/153 chars) or Unicode when any char is outside it (70/67). */
export function smsInfo(text: string) {
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (GSM.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  const length = gsm ? units : [...text].length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);
  const nonGsm = gsm
    ? []
    : [...new Set([...text].filter((c) => !GSM.includes(c) && !GSM_EXT.includes(c)))];
  return {
    encoding: gsm ? "GSM-7" : "Unicode",
    length,
    segments,
    perSegment: segments > 1 ? multi : single,
    nonGsm,
  };
}

// ------------------------------------------------------------------ rendering

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only http(s) links survive rendering (a variable may resolve to anything). */
const safeUrl = (u: string | undefined) => {
  const v = (u ?? "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v : null;
};

const hex = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : "#075DA8");

export function renderEmailHtml(c: EmailContent, vars: Record<string, unknown>) {
  const r = (t: string) => renderTemplate(t, vars);
  const accent = hex(c.accent);
  const rows = c.blocks
    .map((b) => {
      const align = "align" in b && b.align === "center" ? "center" : "left";
      switch (b.type) {
        case "heading":
          return `<tr><td style="padding:8px 32px;text-align:${align};font:600 24px/1.3 Arial,sans-serif;color:#111827">${esc(r(b.text))}</td></tr>`;
        case "text":
          return `<tr><td style="padding:8px 32px;text-align:${align};font:400 16px/1.6 Arial,sans-serif;color:#374151">${esc(r(b.text)).replace(/\n/g, "<br>")}</td></tr>`;
        case "button": {
          const url = safeUrl(r(b.url));
          if (!url) return "";
          return `<tr><td style="padding:16px 32px;text-align:${align}"><a href="${esc(url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font:600 16px Arial,sans-serif;padding:12px 24px;border-radius:8px">${esc(r(b.text))}</a></td></tr>`;
        }
        case "image": {
          const src = safeUrl(r(b.url));
          if (!src) return "";
          const img = `<img src="${esc(src)}" alt="${esc(r(b.alt ?? ""))}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px">`;
          const link = safeUrl(r(b.link ?? ""));
          return `<tr><td style="padding:8px 32px">${link ? `<a href="${esc(link)}">${img}</a>` : img}</td></tr>`;
        }
        case "divider":
          return `<tr><td style="padding:16px 32px"><hr style="border:0;border-top:1px solid #e5e7eb;margin:0"></td></tr>`;
        case "spacer":
          return `<tr><td style="height:${Math.min(Math.max(b.size ?? 24, 4), 96)}px;line-height:0;font-size:0">&nbsp;</td></tr>`;
      }
    })
    .join("");
  const pre = c.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(r(c.preheader))}</div>`
    : "";
  const footer = c.footer
    ? `<tr><td style="padding:24px 32px;font:400 12px/1.5 Arial,sans-serif;color:#9ca3af;text-align:center">${esc(r(c.footer))}</td></tr>`
    : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r(c.subject))}</title></head><body style="margin:0;padding:0;background:#f3f4f6">${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;border-top:4px solid ${accent}"><tr><td style="height:24px"></td></tr>${rows}<tr><td style="height:24px"></td></tr></table><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">${footer}</table></td></tr></table></body></html>`;
}

function emailText(c: EmailContent, vars: Record<string, unknown>) {
  const r = (t: string) => renderTemplate(t, vars);
  return c.blocks
    .map((b) => {
      if (b.type === "heading" || b.type === "text") return r(b.text);
      if (b.type === "button") return `${r(b.text)}: ${safeUrl(r(b.url)) ?? ""}`;
      return "";
    })
    .filter(Boolean)
    .concat(c.footer ? [`--\n${r(c.footer)}`] : [])
    .join("\n\n");
}

/** Final content per channel, with variables filled. This is what the worker sends. */
export function renderMessage(channel: Channel, content: Content, vars: Record<string, unknown>) {
  const r = (t: string | undefined) => renderTemplate(t ?? "", vars);
  switch (channel) {
    case "email": {
      const c = content as EmailContent;
      return {
        subject: r(c.subject),
        preheader: r(c.preheader),
        from_name: c.from_name ?? "",
        html: renderEmailHtml(c, vars),
        text: emailText(c, vars),
      };
    }
    case "sms": {
      const text = r((content as SmsContent).text);
      const info = smsInfo(text);
      return { text, segments: info.segments, encoding: info.encoding };
    }
    case "whatsapp": {
      const c = content as WhatsappContent;
      return {
        category: c.category,
        header:
          c.header?.type === "text"
            ? { type: "text", text: r(c.header.text) }
            : c.header?.type === "image"
              ? { type: "image", url: safeUrl(r(c.header.url)) }
              : null,
        body: r(c.body),
        footer: r(c.footer) || null,
        buttons: (c.buttons ?? []).map((b) => ({
          type: b.type,
          text: r(b.text),
          ...(b.type === "url" ? { url: safeUrl(r(b.url)) } : {}),
          ...(b.type === "phone" ? { phone: b.phone } : {}),
        })),
      };
    }
    case "rcs": {
      const c = content as RcsContent;
      return {
        kind: c.kind,
        text: c.kind === "text" ? r(c.text) : null,
        cards:
          c.kind === "text"
            ? []
            : (c.cards ?? []).map((k) => ({
                title: r(k.title),
                description: r(k.description),
                media_url: safeUrl(r(k.media_url)),
                media_height: k.media_height ?? "medium",
              })),
        suggestions: (c.suggestions ?? []).map((s) => ({
          type: s.type,
          text: r(s.text),
          ...(s.type === "url" ? { url: safeUrl(r(s.url)) } : {}),
          ...(s.type === "dial" ? { phone: s.phone } : {}),
        })),
        fallback_sms: r(c.fallback_sms),
      };
    }
  }
}

/** Short one-line summary for lists and flow nodes. */
export function summary(channel: Channel, content: Content) {
  switch (channel) {
    case "email":
      return (content as EmailContent).subject;
    case "sms":
      return (content as SmsContent).text;
    case "whatsapp":
      return (content as WhatsappContent).body;
    case "rcs": {
      const c = content as RcsContent;
      return c.kind === "text" ? (c.text ?? "") : (c.cards?.[0]?.title ?? "");
    }
  }
}
