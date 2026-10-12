/** E-mail in the person's own HTML: rendering, safety, text version and the database rules. */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  blocksToHtml,
  defaultContent,
  htmlToText,
  renderMessage,
  type EmailContent,
} from "../../src/lib/crm-messages.ts";
import { makeRpc, TEST_DB_URL } from "./db.ts";

const vars = { first_name: "<Ana & Cia>", email: "ana@example.com" };
const html = (h: string, extra: Partial<EmailContent> = {}): EmailContent => ({
  subject: "Oi {{first_name}}",
  format: "html",
  html: h,
  blocks: [],
  ...extra,
});
const render = (c: EmailContent) =>
  renderMessage("email", c, vars) as { subject: string; html: string; text: string };

describe("E-mail HTML", () => {
  test("variables are filled and HTML-escaped where they land", () => {
    const r = render(html(`<html><body><h1>Olá {{ first_name }}</h1></body></html>`));
    assert.match(r.html, /<h1>Olá &lt;Ana &amp; Cia&gt;<\/h1>/);
    assert.equal(r.subject, "Oi <Ana & Cia>");
  });

  test("scripts, inline handlers and javascript: links are removed", () => {
    const r = render(
      html(
        `<html><body onload="steal()"><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)></body></html>`,
      ),
    );
    assert.doesNotMatch(r.html, /<script|onload|onerror|javascript:/i);
    assert.match(r.html, /<a href="#">x<\/a>/);
  });

  test("a fragment becomes a full document; the preheader goes right after <body>", () => {
    const r = render(html(`<p>Oi</p>`, { preheader: "Novidade para {{first_name}}" }));
    assert.match(r.html, /^<!doctype html><html lang="pt-BR">/);
    assert.match(
      r.html,
      /<body[^>]*><div style="display:none[^"]*">Novidade para &lt;Ana &amp; Cia&gt;<\/div><p>Oi<\/p>/,
    );
  });

  test("the text version keeps words and links, not the hidden preheader", () => {
    const r = render(
      html(
        `<html><head><style>p{color:red}</style></head><body><h1>Olá</h1><p>Linha 1<br>Linha 2</p><a href="https://kakauma.com.br/x">Ver loja</a></body></html>`,
        { preheader: "escondido" },
      ),
    );
    assert.equal(r.text, "Olá\nLinha 1\nLinha 2\nVer loja: https://kakauma.com.br/x");
    assert.equal(htmlToText("a&nbsp;&amp;&nbsp;b"), "a & b");
  });

  test("blocks can be turned into editable HTML that keeps the variables", () => {
    const c = defaultContent("email") as EmailContent;
    const h = blocksToHtml(c);
    assert.match(h, /Olá, \{\{first_name\}\}!/);
    assert.match(h, /href="https:\/\/kakauma\.com\.br"/);
    // rendering that HTML shows the same words as the blocks
    const text = render({ ...c, format: "html", html: h }).text;
    for (const part of [
      "Olá, <Ana & Cia>!",
      "Escreva aqui a sua mensagem.",
      "Ver agora: https://kakauma.com.br",
    ])
      assert.ok(text.includes(part), `${part} in ${text}`);
  });

  test("blocks stay the default format", () => {
    const r = render(defaultContent("email") as EmailContent);
    assert.match(r.html, /border-top:4px solid #075DA8/);
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
describe(
  "E-mail HTML rules in the database",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    after(async () => {
      await sql!`delete from crm.message_templates where key = 'tl_html'`;
      await sql?.end();
    });
    const rpc = sql ? makeRpc(sql) : null;
    const errors = async (content: object) =>
      ((await rpc!("crm_template_errors", { p_channel: "email", p_content: content })).data ??
        []) as string[];

    test("valid HTML passes; empty, scripts, forms and iframes are refused", async () => {
      assert.deepEqual(await errors({ subject: "x", format: "html", html: "<p>oi</p>" }), []);
      assert.deepEqual(await errors({ subject: "x", format: "html", html: " " }), [
        "Cole ou escreva o HTML do e-mail",
      ]);
      assert.match(
        (await errors({ subject: "x", format: "html", html: "<SCRIPT>x" }))[0]!,
        /script/,
      );
      assert.match(
        (await errors({ subject: "x", format: "html", html: "<form action=x>" }))[0]!,
        /formulários/,
      );
      assert.match(
        (await errors({ subject: "x", format: "html", html: "x".repeat(100_001) }))[0]!,
        /100 mil/,
      );
      assert.match((await errors({ subject: "x", format: "mjml", html: "<p>" }))[0]!, /Formato/);
      // the block rules still apply to block e-mails
      assert.deepEqual(await errors({ subject: "x", blocks: [] }), [
        "Adicione pelo menos um bloco ao e-mail",
      ]);
    });

    test("an HTML template can be saved and listed", async () => {
      const r = await rpc!("crm_upsert_template", {
        p_key: "tl_html",
        p_name: "HTML",
        p_channel: "email",
        p_purpose: "marketing",
        p_content: { subject: "Oi", format: "html", html: "<p>Oi {{first_name}}</p>", blocks: [] },
      });
      assert.equal(r.error, null, r.error?.message);
      const [t] =
        await sql!`select content->>'format' as f from crm.message_templates where key = 'tl_html'`;
      assert.equal(t!["f"], "html");
    });
  },
);
