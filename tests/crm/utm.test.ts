/** UTM tracking added to store links when a message is sent. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tagHtml, tagRendered, tagText, tagUrl, utmSlug } from "../../src/lib/crm-utm.ts";

const ctx = { channel: "email", campaign: "compra_aprovada", content: "email_compra" };
const UTM = "utm_source=email&utm_medium=crm&utm_campaign=compra_aprovada&utm_content=email_compra";

describe("UTM tracking", () => {
  test("names become link-friendly values", () => {
    assert.equal(utmSlug("Compra aprovada"), "compra_aprovada");
    assert.equal(utmSlug("E-mail: Pedido Saiu para entrega!"), "e_mail_pedido_saiu_para_entrega");
    assert.equal(utmSlug("1 Lata - Kakauma (Sleep Drink)"), "1_lata_kakauma_sleep_drink");
    assert.equal(utmSlug("Ação ñ"), "acao_n");
  });

  test("store links get the four parameters; others stay as written", () => {
    assert.equal(tagUrl("https://kakauma.com.br/", ctx), `https://kakauma.com.br/?${UTM}`);
    assert.equal(
      tagUrl("https://www.kakauma.com.br/produto?cor=azul#topo", ctx),
      `https://www.kakauma.com.br/produto?cor=azul&${UTM}#topo`,
    );
    for (const other of [
      "https://instagram.com/kakauma",
      "https://kakauma.com.br.golpe.com/x",
      "mailto:atendimento@kakauma.com.br",
    ])
      assert.equal(tagUrl(other, ctx), other);
    // a CRM short link on a store subdomain keeps its own UTMs
    assert.equal(
      tagUrl("https://k.kakauma.com.br/l/Ab3xY9", ctx),
      "https://k.kakauma.com.br/l/Ab3xY9",
    );
    // old hand-written UTMs (even broken ones) are replaced; other parameters stay
    assert.equal(
      tagUrl(
        "https://kakauma.com.br/?utm_source=&utm_medium=crm&utm_campaign=x&utm_content=&utm_term=sono&cupom=A",
        ctx,
      ),
      `https://kakauma.com.br/?utm_term=sono&cupom=A&${UTM}`,
    );
  });

  test("HTML: only <a href>, keeping &amp; and images untouched", () => {
    const html =
      '<a href="https://kakauma.com.br/x?a=1&amp;b=2">Ver</a><img src="https://kakauma.com.br/logo.png"><a href=\'https://wa.me/55\'>Zap</a>';
    assert.equal(
      tagHtml(html, ctx),
      `<a href="https://kakauma.com.br/x?a=1&amp;b=2&amp;${UTM.replace(/&/g, "&amp;")}">Ver</a><img src="https://kakauma.com.br/logo.png"><a href='https://wa.me/55'>Zap</a>`,
    );
  });

  test("text: links inside a sentence, without eating the final punctuation", () => {
    assert.equal(
      tagText("Compre em https://kakauma.com.br/loja. Até!", { ...ctx, channel: "sms" }),
      `Compre em https://kakauma.com.br/loja?${UTM.replace("email&", "sms&")}. Até!`,
    );
  });

  test("each channel: e-mail html and text, SMS parts recounted, RCS button and SMS alternativo", () => {
    const e = tagRendered(
      "email",
      {
        subject: "Oi",
        html: '<a href="https://kakauma.com.br">Loja</a>',
        text: "Loja: https://kakauma.com.br",
      },
      ctx,
    );
    assert.match(e.html, /utm_campaign=compra_aprovada/);
    assert.match(e.text, /utm_content=email_compra/);
    const s = tagRendered(
      "sms",
      { text: "Kakauma: https://kakauma.com.br", segments: 1 },
      { ...ctx, channel: "sms" },
    );
    assert.match(s.text, /utm_source=sms/);
    assert.equal(s.segments, 1);
    const r = tagRendered(
      "rcs",
      {
        kind: "card",
        text: null,
        cards: [
          {
            title: "T",
            description: "veja https://kakauma.com.br/a",
            media_url: "https://kakauma.com.br/img.png",
          },
        ],
        suggestions: [{ type: "url", text: "Abrir", url: "https://kakauma.com.br/b" }],
        fallback_sms: "Kakauma https://kakauma.com.br/c",
      },
      { ...ctx, channel: "rcs" },
    );
    assert.match(r.suggestions[0]!.url, /utm_source=rcs/);
    assert.match(r.cards[0]!.description, /utm_source=rcs/);
    assert.equal(r.cards[0]!.media_url, "https://kakauma.com.br/img.png");
    assert.match(r.fallback_sms, /utm_source=rcs/);
  });
});
