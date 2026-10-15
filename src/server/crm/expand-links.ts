import { ownDomain, stripUtm } from "../../lib/crm-utm.ts";
import type { EmailBlock, EmailContent } from "../../lib/crm-messages.ts";

/**
 * Short links in e-mails (bit.ly and the like) hide the store address, so the
 * automatic UTMs cannot reach them. This follows each one to where it lands
 * and, when that is our store, puts the store address back (without the four
 * UTMs the CRM fills in when sending). Links to other sites stay.
 */

const HREF = /(<a\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi;

/** Links of an e-mail that may be short links: http(s), not ours, no {{variable}}. */
export function candidateLinks(c: EmailContent): string[] {
  const urls = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== "string" || u.includes("{{")) return;
    try {
      const x = new URL(u.trim());
      if (/^https?:$/.test(x.protocol) && !ownDomain(x.hostname.toLowerCase())) urls.add(u.trim());
    } catch {
      /* not a link */
    }
  };
  for (const m of (c.html ?? "").matchAll(HREF)) add(m[3]!.replace(/&amp;/g, "&"));
  for (const b of c.blocks ?? []) {
    if (b.type === "button") add(b.url);
    if (b.type === "image") add(b.link);
  }
  return [...urls];
}

/** Where a link ends up after its redirects (null: could not tell). */
export async function finalUrl(url: string, fetchImpl: typeof fetch = fetch, hops = 6) {
  let current = url;
  for (let i = 0; i <= hops; i++) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "user-agent": "Mozilla/5.0 (KakaumaCRM link check)" },
      });
    } catch {
      return null;
    }
    const loc = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return res.status < 400 ? current : null;
  }
  return null;
}

/** The e-mail with each mapped link replaced (HTML hrefs and block links). */
export function replaceLinks(c: EmailContent, map: Map<string, string>): EmailContent {
  const html = c.html?.replace(HREF, (all, pre: string, q: string, href: string) => {
    const to = map.get(href.replace(/&amp;/g, "&").trim());
    return to ? `${pre}${q}${to.replace(/&/g, "&amp;")}${q}` : all;
  });
  const blocks = c.blocks?.map((b): EmailBlock => {
    if (b.type === "button" && map.has(b.url.trim())) return { ...b, url: map.get(b.url.trim())! };
    if (b.type === "image" && b.link && map.has(b.link.trim()))
      return { ...b, link: map.get(b.link.trim())! };
    return b;
  });
  return { ...c, ...(html !== undefined ? { html } : {}), ...(blocks ? { blocks } : {}) };
}

/** Short link → store address, for the links that land on our store. */
export async function resolveStoreLinks(urls: string[], fetchImpl: typeof fetch = fetch) {
  const map = new Map<string, string>();
  const other: { url: string; to: string | null }[] = [];
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        const to = await finalUrl(u, fetchImpl);
        let host = "";
        try {
          host = to ? new URL(to).hostname.toLowerCase() : "";
        } catch {
          /* ignore */
        }
        if (to && ownDomain(host)) map.set(u, stripUtm(to));
        else other.push({ url: u, to });
      }
    }),
  );
  return { map, other };
}
