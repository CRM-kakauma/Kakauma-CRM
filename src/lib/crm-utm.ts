/**
 * UTM tracking on links to the store, added when a message is sent:
 *   utm_source = channel (email, sms, rcs, whatsapp), utm_medium = crm,
 *   utm_campaign = flow key, utm_content = message key.
 * Only links to our own domains are tagged, and a link that already has any
 * utm_ parameter is left exactly as written (manual tracking wins).
 */

import { smsInfo } from "./crm-messages.ts";

export interface UtmContext {
  channel: string;
  /** flow key (or "teste" for a test send) */
  campaign: string | null;
  /** message (template) key */
  content: string | null;
}

export const UTM_DOMAINS = ["kakauma.com.br"];

const ownDomain = (host: string) => UTM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

export function tagUrl(url: string, ctx: UtmContext): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(u.protocol) || !ownDomain(u.hostname.toLowerCase())) return url;
  if ([...u.searchParams.keys()].some((k) => k.toLowerCase().startsWith("utm_"))) return url;
  u.searchParams.set("utm_source", ctx.channel);
  u.searchParams.set("utm_medium", "crm");
  if (ctx.campaign) u.searchParams.set("utm_campaign", ctx.campaign);
  if (ctx.content) u.searchParams.set("utm_content", ctx.content);
  return u.toString();
}

/** Links written in plain text (SMS, RCS, the text version of an e-mail). */
export function tagText(text: string, ctx: UtmContext): string {
  return text.replace(/https?:\/\/[^\s<>"']+/g, (m) => {
    // a sentence's final punctuation is not part of the link
    const tail = /[.,;:!?)\]]+$/.exec(m)?.[0] ?? "";
    return tagUrl(m.slice(0, m.length - tail.length), ctx) + tail;
  });
}

/** href="…" links of an HTML e-mail (images keep their address). */
export function tagHtml(html: string, ctx: UtmContext): string {
  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (_, pre: string, q: string, href: string) => {
      const tagged = tagUrl(href.replace(/&amp;/g, "&"), ctx);
      return `${pre}${q}${tagged === href.replace(/&amp;/g, "&") ? href : tagged.replace(/&/g, "&amp;")}${q}`;
    },
  );
}

type Obj = Record<string, unknown>;

/** The rendered message with its store links tagged, per channel. */
export function tagRendered<T>(channel: string, rendered: T, ctx: UtmContext): T {
  const r = rendered as Obj;
  if (!r || typeof r !== "object") return rendered;
  const text = (v: unknown) => (typeof v === "string" ? tagText(v, ctx) : v);
  const withUrl = (list: unknown) =>
    Array.isArray(list)
      ? list.map((x: Obj) =>
          typeof x?.["url"] === "string" ? { ...x, url: tagUrl(x["url"] as string, ctx) } : x,
        )
      : list;
  switch (channel) {
    case "email":
      return {
        ...r,
        html: typeof r["html"] === "string" ? tagHtml(r["html"], ctx) : r["html"],
        text: text(r["text"]),
      } as T;
    case "sms": {
      const t = String(text(r["text"]) ?? "");
      const info = smsInfo(t); // a longer link can mean one more SMS part
      return { ...r, text: t, segments: info.segments, encoding: info.encoding } as T;
    }
    case "rcs":
      return {
        ...r,
        text: text(r["text"]),
        cards: Array.isArray(r["cards"])
          ? (r["cards"] as Obj[]).map((k) => ({ ...k, description: text(k["description"]) }))
          : r["cards"],
        suggestions: withUrl(r["suggestions"]),
        fallback_sms: text(r["fallback_sms"]),
      } as T;
    case "whatsapp":
      return { ...r, body: text(r["body"]), buttons: withUrl(r["buttons"]) } as T;
    default:
      return rendered;
  }
}
