/** Link shortener: only store links, one code per link, clicks counted. */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { makeRpc, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc = sql ? makeRpc(sql) : null;

describe("Short links", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  after(async () => {
    await sql!`delete from crm.short_links where url like '%short-test%'`;
    await sql?.end();
  });

  test("a store link gets a code; the same link gets the same code", async () => {
    const url = "https://kakauma.com.br/short-test?utm_source=sms&utm_medium=crm";
    const a = await rpc!("crm_create_short_link", { p_url: url, p_actor: "op@x.com" });
    assert.equal(a.error, null, a.error?.message);
    const code = (a.data as { code: string }).code;
    assert.match(code, /^[A-Za-z0-9]{6}$/);
    const b = await rpc!("crm_create_short_link", { p_url: ` ${url} ` });
    assert.equal((b.data as { code: string }).code, code);
  });

  test("opening counts the click; unknown codes return nothing", async () => {
    const [l] = await sql!`select code from crm.short_links where url like '%short-test%'`;
    for (let i = 0; i < 2; i++) {
      const r = await rpc!("crm_open_short_link", { p_code: l!["code"] });
      assert.match(String(r.data), /short-test/);
    }
    const [c] = await sql!`select clicks from crm.short_links where code = ${l!["code"]}`;
    assert.equal(Number(c!["clicks"]), 2);
    assert.equal((await rpc!("crm_open_short_link", { p_code: "zzzzzz" })).data, null);
  });

  test("other sites are refused (no open redirect)", async () => {
    for (const bad of [
      "https://evil.com/?q=kakauma.com.br",
      "https://kakauma.com.br.evil.com/",
      "http://kakauma.com.br/",
      "javascript:alert(1)",
    ]) {
      const r = await rpc!("crm_create_short_link", { p_url: bad });
      assert.match(r.error?.message ?? "", /kakauma\.com\.br/, bad);
    }
  });
});
