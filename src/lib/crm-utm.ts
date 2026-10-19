/**
 * UTM tracking on links to the store, added when a message is sent:
 *   utm_source = channel (email, sms, rcs, whatsapp), utm_medium = crm,
 *   utm_campaign = flow name, utm_content = message name — as link-friendly
 *   words ("Compra aprovada" → compra_aprovada).
 * Only links to our own domains are tagged. These four always follow the rule,
 * replacing any value written by hand (old links keep working); other
 * parameters, utm_term and utm_id included, stay as written.
 */

import { smsInfo } from "./crm-messages.ts";

export interface UtmContext {
  channel: string;
  /** flow name as a UTM value (or "teste" for a test send) */
  campaign: string | null;
  /** message name as a UTM value */
  content: string | null;
}

export const UTM_DOMAINS = ["kakauma.com.br"];

/** A name as a UTM value: no accents, lowercase, words joined by "_". */
export function utmSlug(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export const ownDomain = (host: string) =>
  UTM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

export function tagUrl(url: string, ctx: UtmContext): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(u.protocol) || !ownDomain(u.hostname.toLowerCase())) return url;
  // a CRM short link (/l/<code>, e.g. on a kakauma.com.br subdomain) already carries its UTMs
  if (/^\/l\/[A-Za-z0-9]{4,12}\/?$/.test(u.pathname)) return url;
  for (const k of [...u.searchParams.keys()])
    if (/^utm_(source|medium|campaign|content)$/i.test(k)) u.searchParams.delete(k);
  u.searchParams.set("utm_source", ctx.channel);
  u.searchParams.set("utm_medium", "crm");
  if (ctx.campaign) u.searchParams.set("utm_campaign", ctx.campaign);
  if (ctx.content) u.searchParams.set("utm_content", ctx.content);
  return u.toString();
}

/** The address without the four UTMs the CRM fills in (other parameters stay). */
export function stripUtm(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/^utm_(source|medium|campaign|content)$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Each link written in plain text (SMS, RCS, the text version of an e-mail), through `fn`. */
export function mapText(text: string, fn: (url: string) => string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/g, (m) => {
    // a sentence's final punctuation is not part of the link
    const tail = /[.,;:!?)\]]+$/.exec(m)?.[0] ?? "";
    return fn(m.slice(0, m.length - tail.length)) + tail;
  });
}

/** Each href="…" link of an HTML e-mail through `fn` (images keep their address). */
export function mapHtml(html: string, fn: (url: string) => string): string {
  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (_, pre: string, q: string, href: string) => {
      const plain = href.replace(/&amp;/g, "&");
      const to = fn(plain);
      return `${pre}${q}${to === plain ? href : to.replace(/&/g, "&amp;")}${q}`;
    },
  );
}

export const tagText = (text: string, ctx: UtmContext) => mapText(text, (u) => tagUrl(u, ctx));
export const tagHtml = (html: string, ctx: UtmContext) => mapHtml(html, (u) => tagUrl(u, ctx));

type Obj = Record<string, unknown>;

/** Every link of a rendered message through `fn`, per channel (SMS parts recounted). */
export function mapRenderedLinks<T>(channel: string, rendered: T, fn: (url: string) => string): T {
  const r = rendered as Obj;
  if (!r || typeof r !== "object") return rendered;
  const text = (v: unknown) => (typeof v === "string" ? mapText(v, fn) : v);
  const withUrl = (list: unknown) =>
    Array.isArray(list)
      ? list.map((x: Obj) =>
          typeof x?.["url"] === "string" ? { ...x, url: fn(x["url"] as string) } : x,
        )
      : list;
  switch (channel) {
    case "email":
      return {
        ...r,
        html: typeof r["html"] === "string" ? mapHtml(r["html"], fn) : r["html"],
        text: text(r["text"]),
      } as T;
    case "sms": {
      const t = String(text(r["text"]) ?? "");
      const info = smsInfo(t); // a longer or shorter link changes the SMS parts
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

/** The rendered message with its store links tagged, per channel. */
export const tagRendered = <T>(channel: string, rendered: T, ctx: UtmContext): T =>
  mapRenderedLinks(channel, rendered, (u) => tagUrl(u, ctx));

/** Store links of a rendered message that a CRM click link can stand for. */
export function storeLinks(channel: string, rendered: unknown): string[] {
  const out = new Set<string>();
  mapRenderedLinks(channel, rendered, (u) => {
    try {
      const x = new URL(u);
      if (
        x.protocol === "https:" &&
        ownDomain(x.hostname.toLowerCase()) &&
        !/^\/l\//.test(x.pathname)
      )
        out.add(u);
    } catch {
      /* not a link */
    }
    return u;
  });
  return [...out];
}
