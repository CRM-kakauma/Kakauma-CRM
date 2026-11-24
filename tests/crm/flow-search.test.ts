/** Busca em Fluxos: by flow name or by the text of its messages; and the sent messages of a flow. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { snippet, fold } from "../../src/lib/crm-search.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

describe("destaque do trecho encontrado", () => {
  test("ignora acento e maiúscula e corta em volta", () => {
    assert.equal(fold("Promoção"), "promocao");
    const s = snippet("Kakauma: Regule o seu cortisol com a nossa fórmula", "CORTISOL", 10);
    assert.deepEqual(s, { before: "…ule o seu ", hit: "cortisol", after: " com a nos…" });
    assert.equal(snippet("Fórmula", "formula")?.hit, "Fórmula");
    assert.equal(snippet("abc", "x"), null);
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data;
};
/** only this test's flows (the database may have others) */
const search = async (q: string) =>
  ((await call("crm_search_flows", { p_query: q })) as Hit[]).filter((h) =>
    h.key.startsWith("fs_"),
  );
type Hit = {
  key: string;
  matches: { node_id: string; channel: string; template_name: string; text: string }[];
};

describe("busca nos fluxos", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'fs_%')`;
    await sql!`delete from crm.flows where key like 'fs_%'`;
    await call("crm_upsert_template", {
      p_key: "fs_sms_cortisol",
      p_name: "SMS cortisol",
      p_channel: "sms",
      p_content: { text: "Kakauma: Regule o seu CORTISOL com a fórmula {{first_name}}" },
    });
    await call("crm_upsert_template", {
      p_key: "fs_wpp_pix",
      p_name: "Pix pendente",
      p_channel: "whatsapp",
      p_content: { body: "Seu Pix está esperando, promoção até hoje" },
    });
    const graph = (tpl: string) => ({
      nodes: [
        { id: "start", type: "trigger", config: {} },
        { id: "msg1", type: "send", config: { template_key: tpl } },
        { id: "eq", type: "alert_team", config: { text: "Ligar para cliente da promoção" } },
      ],
      edges: [
        { source: "start", target: "msg1", handle: "next" },
        { source: "msg1", target: "eq", handle: "next" },
      ],
    });
    await call("crm_save_flow", {
      p_key: "fs_carrinho",
      p_name: "Carrinho abandonado",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_graph: graph("fs_sms_cortisol"),
    });
    await call("crm_save_flow", {
      p_key: "fs_pix",
      p_name: "Pix",
      p_description: "Recupera Pix",
      p_trigger_fact: "PAYMENT_PENDING",
      p_graph: graph("fs_wpp_pix"),
    });
  });
  after(async () => {
    await sql?.end();
  });

  test("acha o fluxo pela copy da mensagem, sem acento e sem maiúscula", async () => {
    const r = await search("cortisol");
    assert.deepEqual(
      r.map((h) => h.key),
      ["fs_carrinho"],
    );
    assert.equal(r[0]!.matches[0]!.node_id, "msg1");
    assert.equal(r[0]!.matches[0]!.channel, "sms");
    assert.equal(r[0]!.matches[0]!.template_name, "SMS cortisol");
    const f = await search("FORMULA");
    assert.deepEqual(
      f.map((h) => h.key),
      ["fs_carrinho"],
    );
  });

  test("acha pelo nome, pela descrição e pelo alerta da equipe", async () => {
    assert.deepEqual(
      (await search("carrinho")).map((h) => h.key),
      ["fs_carrinho"],
    );
    const d = await search("recupera pix");
    assert.deepEqual(
      d.map((h) => h.key),
      ["fs_pix"],
    );
    assert.equal(d[0]!.matches.length, 0); // matched by the description only
    const p = await search("promocao");
    assert.deepEqual(p.map((h) => h.key).sort(), ["fs_carrinho", "fs_pix"]);
    const pix = p.find((h) => h.key === "fs_pix")!;
    assert.deepEqual(pix.matches.map((m) => m.channel).sort(), ["team", "whatsapp"]);
  });

  test("busca curta demais não traz nada", async () => {
    assert.equal(((await call("crm_search_flows", { p_query: " a " })) as Hit[]).length, 0);
  });

  test("mensagens enviadas: por cliente, telefone ou texto", async () => {
    const [c] =
      await sql!`insert into crm.customers (full_name, email, whatsapp) values ('Joana Mendonça', 'joana@example.com', '79991592167') returning customer_id`;
    const [o] =
      await sql!`insert into crm.customers (full_name, email) values ('Outro', 'outro@example.com') returning customer_id`;
    const [f] = await sql!`select flow_id from crm.flows where key = 'fs_carrinho'`;
    for (const [cust, text] of [
      [c!["customer_id"], "Joana, regule o seu cortisol"],
      [o!["customer_id"], "Outro texto qualquer"],
    ] as const)
      await sql!`insert into crm.messages (customer_id, flow_id, channel, template_key, status, rendered, recipient)
                 values (${cust}, ${f!["flow_id"]}, 'sms', 'fs_sms_cortisol', 'SENT', ${sql!.json({ text })}, 'x')`;
    const by = async (q: string) =>
      (
        (await call("crm_search_messages", { p_flow_key: "fs_carrinho", p_query: q })) as {
          full_name: string;
        }[]
      ).map((m) => m.full_name);
    assert.deepEqual(await by("mendonca"), ["Joana Mendonça"]);
    assert.deepEqual(await by("JOANA@example"), ["Joana Mendonça"]);
    assert.deepEqual(await by("99159-2167"), ["Joana Mendonça"]);
    assert.deepEqual(await by("cortisol"), ["Joana Mendonça"]);
    assert.deepEqual(await by("qualquer"), ["Outro"]);
    assert.deepEqual(await by("nada disso"), []);
  });
});
