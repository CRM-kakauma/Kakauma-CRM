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

describe(
  "Short link made outside a flow",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    const sql2 = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
    const rpc2 = sql2 ? makeRpc(sql2) : null;
    after(async () => {
      await sql2!`update crm.flows set status = 'ARCHIVED' where key = 'sl_flow'`;
      await sql2!`delete from crm.short_links where url like '%sl-test%'`;
      await sql2?.end();
    });

    test("counts for the flow that sends it and redirects with that flow's UTMs", async () => {
      await sql2!`delete from crm.short_links`;
      await sql2!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key = 'sl_flow')`;
      await sql2!`delete from crm.flows where key = 'sl_flow'`;
      const made = await rpc2!("crm_create_short_link", {
        p_url:
          "https://kakauma.com.br/sl-test?utm_source=sms&utm_medium=crm&utm_campaign=nome_do_fluxo&utm_content=bora",
      });
      const code = (made.data as { code: string }).code;
      // the SMS with that short link, used by a flow
      for (const r of [
        await rpc2!("crm_upsert_template", {
          p_key: "sl_sms",
          p_name: "Lembrete 1",
          p_channel: "sms",
          p_purpose: "marketing",
          p_content: { text: `Kakauma: volte https://kakauma-crm.vercel.app/l/${code}` },
        }),
        await rpc2!("crm_save_flow", {
          p_key: "sl_flow",
          p_name: "Carrinho abandonado - SMS",
          p_trigger_fact: "CHECKOUT_ABANDONED",
          p_graph: {
            nodes: [
              { id: "start", type: "trigger", config: {} },
              { id: "m", type: "send", config: { template_key: "sl_sms" } },
            ],
            edges: [{ source: "start", target: "m", handle: "next" }],
          },
        }),
      ])
        assert.equal(r.error, null, r.error?.message);

      const opened = await rpc2!("crm_open_short_link", { p_code: code });
      assert.equal(
        opened.data,
        "https://kakauma.com.br/sl-test?utm_source=sms&utm_medium=crm&utm_campaign=carrinho_abandonado_sms&utm_content=lembrete_1",
      );
      const r = await rpc2!("crm_results", {
        p_from: new Date(Date.now() - 86_400_000).toISOString(),
        p_to: new Date(Date.now() + 60_000).toISOString(),
        p_window_days: 7,
      });
      const flows = (r.data as { by_flow: { campaign: string; clicks: number }[] }).by_flow;
      assert.equal(flows.find((f) => f.campaign === "carrinho_abandonado_sms")?.clicks, 1);
      assert.equal(
        flows.find((f) => f.campaign === "nome_do_fluxo"),
        undefined,
      );
    });
  },
);
