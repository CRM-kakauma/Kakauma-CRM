/** "Trocar links curtos": short links in e-mails go back to the store address. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateLinks,
  replaceLinks,
  resolveStoreLinks,
} from "../../src/server/crm/expand-links.ts";
import type { EmailContent } from "../../src/lib/crm-messages.ts";

/** Fake web: bit.ly → t.co → store (with old UTMs); insta stays; dead link fails. */
const web = (async (url: string) => {
  const hop: Record<string, string> = {
    "https://bit.ly/kk1": "https://t.co/x",
    "https://t.co/x":
      "https://kakauma.com.br/produto?utm_source=sms&utm_medium=crm&utm_content={{USER_ID}}&cupom=A",
    "https://bit.ly/insta": "https://instagram.com/kakauma",
  };
  if (url.startsWith("https://dead.link")) throw new Error("offline");
  const to = hop[url];
  return to
    ? new Response(null, { status: 301, headers: { location: to } })
    : new Response("ok", { status: 200 });
}) as unknown as typeof fetch;

const email: EmailContent = {
  subject: "Oi",
  format: "html",
  html: '<a href="https://bit.ly/kk1">Comprar</a> <a href="https://bit.ly/insta">Insta</a> <a href="https://dead.link/a">X</a> <a href="https://kakauma.com.br/">Site</a> <a href="{{checkout_url}}">Checkout</a>',
  blocks: [{ type: "button", text: "Ver", url: "https://bit.ly/kk1" }],
};

describe("Short links in e-mails", () => {
  test("only outside links without variables are checked", () => {
    assert.deepEqual(candidateLinks(email).sort(), [
      "https://bit.ly/insta",
      "https://bit.ly/kk1",
      "https://dead.link/a",
    ]);
  });

  test("links landing on the store are replaced (old UTMs out, other params kept)", async () => {
    const { map, other } = await resolveStoreLinks(candidateLinks(email), web);
    assert.equal(map.get("https://bit.ly/kk1"), "https://kakauma.com.br/produto?cupom=A");
    assert.deepEqual(other.map((o) => [o.url, o.to]).sort(), [
      ["https://bit.ly/insta", "https://instagram.com/kakauma"],
      ["https://dead.link/a", null],
    ]);
    const out = replaceLinks(email, map);
    assert.match(out.html!, /<a href="https:\/\/kakauma\.com\.br\/produto\?cupom=A">Comprar<\/a>/);
    assert.match(out.html!, /href="https:\/\/bit\.ly\/insta"/);
    assert.match(out.html!, /href="\{\{checkout_url\}\}"/);
    assert.equal((out.blocks![0] as { url: string }).url, "https://kakauma.com.br/produto?cupom=A");
  });
});
