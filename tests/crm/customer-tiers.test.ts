/** Customer level (Sem compra / Bronze / Prata / Ouro), sales tags and manual tags. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data;
};
type Badges = {
  tier: string;
  tier_label: string;
  tip: string;
  orders: number;
  auto: { key: string }[];
  manual: string[];
};
const now = () => new Date().toISOString();
const buyer = (id: string, phone: string) => ({
  id: `cus_${id}`,
  full_name: id,
  email: `${id.toLowerCase()}@example.com`,
  whatsapp: phone,
});
const send = async (p: object) => {
  const r = await ingestWebhook(rpc, "b4you", JSON.stringify(p));
  assert.ok(r.status < 300, JSON.stringify(r.body));
};
const paid = (id: string, phone: string, sale: string, amount: number, at = now()) =>
  send(
    b4("approved-payment", {
      customer: buyer(id, phone),
      sale_id: sale,
      charges: [{ id: `C${sale}`, amount }],
      created_at: at,
      updated_at: at,
      paid_at: at,
    }),
  );
/** A WhatsApp conversation with the contact; answers its badges. */
const chatOf = async (digits: string) => {
  await call("crm_wa_ingest", {
    p_instance: "Kakauma",
    p_messages: [
      {
        wa_id: `M${digits}${Math.random()}`,
        remote_jid: `${digits}@s.whatsapp.net`,
        phone: digits,
        from_me: false,
        type: "text",
        body: "oi",
        at: now(),
      },
    ],
  });
  const [c] = await sql!`select chat_id from crm.wa_chats where phone = ${digits}`;
  return String(c!["chat_id"]);
};
const badges = async (chat: string) =>
  ((await call("crm_wa_chat", { p_chat: chat })) as { badges: Badges }).badges;

describe("Níveis do cliente", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  let original: unknown = null;
  before(async () => {
    original = await call("crm_customer_tiers_config");
    await resetCrm(sql!);
    await sql!`delete from crm.wa_messages`;
    await sql!`delete from crm.wa_chats`;
    await sql!`delete from crm.customer_tags`;
  });
  after(async () => {
    if (original) await call("crm_save_customer_tiers", { p_value: original });
    await sql?.end();
  });

  test("thresholds: orders or revenue", async () => {
    const t = async (o: number, r: number) =>
      (await sql!`select crm.customer_tier(${o}::int, ${r}::numeric) as t`)[0]!["t"];
    assert.equal(await t(0, 0), "sem_compra");
    assert.equal(await t(1, 227), "bronze");
    assert.equal(await t(2, 300), "prata");
    assert.equal(await t(1, 500), "prata"); // one big order
    assert.equal(await t(4, 400), "ouro");
    assert.equal(await t(1, 950), "ouro");
  });

  test("a contact who never bought: Sem compra, abandoned cart is shown", async () => {
    await send(
      b4("abandoned-cart", {
        customer: buyer("Lead", "(31) 91111-2222"),
        created_at: now(),
        updated_at: now(),
      }),
    );
    const b = await badges(await chatOf("5531911112222"));
    assert.equal(b.tier, "sem_compra");
    assert.match(b.tip, /primeira compra/);
    assert.deepEqual(
      b.auto.map((x) => x.key),
      ["carrinho"],
    );
  });

  test("Bronze → Prata with the second purchase; the cart disappears after buying", async () => {
    await send(
      b4("abandoned-cart", {
        customer: buyer("Bia", "(31) 92222-3333"),
        created_at: now(),
        updated_at: now(),
      }),
    );
    await paid("Bia", "(31) 92222-3333", "S-B1", 227);
    const chat = await chatOf("5531922223333");
    let b = await badges(chat);
    assert.equal(b.tier, "bronze");
    assert.equal(b.orders, 1);
    assert.ok(!b.auto.some((x) => x.key === "carrinho"), "bought after the cart");
    await paid("Bia", "(31) 92222-3333", "S-B2", 227);
    b = await badges(chat);
    assert.equal(b.tier, "prata");
    assert.equal(b.tier_label, "Prata");
  });

  test("time to buy again, then inactive", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await paid("Caio", "(31) 93333-4444", "S-C1", 100, old);
    const chat = await chatOf("5531933334444");
    assert.ok((await badges(chat)).auto.some((x) => x.key === "recompra"));
    await sql!`update crm.customers set last_purchase_at = now() - interval '120 days' where external_customer_id = 'cus_Caio'`;
    assert.ok((await badges(chat)).auto.some((x) => x.key === "sumido"));
  });

  test("manual tags: on the customer, or on the chat for a contact who is not a customer", async () => {
    const chat = await chatOf("5531922223333"); // Bia, customer
    await call("crm_wa_tag", {
      p_chat: chat,
      p_tag: "  Prefere   áudio ",
      p_add: true,
      p_actor: "a@x",
    });
    await call("crm_wa_tag", { p_chat: chat, p_tag: "Kit família", p_add: true });
    assert.deepEqual((await badges(chat)).manual, ["Prefere áudio", "Kit família"]);
    const [n] = await sql!`select count(*)::int as n from crm.customer_tags`;
    assert.equal(n!["n"], 2);
    await call("crm_wa_tag", { p_chat: chat, p_tag: "Kit família", p_add: false });
    assert.deepEqual((await badges(chat)).manual, ["Prefere áudio"]);

    const stranger = await chatOf("5511955556666");
    await call("crm_wa_tag", { p_chat: stranger, p_tag: "Revendedor", p_add: true });
    assert.deepEqual((await badges(stranger)).manual, ["Revendedor"]);
    assert.deepEqual(await call("crm_wa_tag_list"), ["Prefere áudio", "Revendedor"]);
    // search by tag in the conversation list
    const found = (await call("crm_wa_chats", {
      p_instance: "Kakauma",
      p_search: "revend",
    })) as unknown[];
    assert.equal(found.length, 1);
  });

  test("the levels can be changed", async () => {
    const cfg = (await call("crm_customer_tiers_config")) as Record<
      string,
      Record<string, unknown>
    >;
    cfg["prata"]!["orders"] = 3;
    cfg["prata"]!["revenue"] = 10_000;
    await call("crm_save_customer_tiers", { p_value: cfg, p_actor: "admin@x" });
    const chat = await chatOf("5531922223333"); // Bia: 2 orders
    assert.equal((await badges(chat)).tier, "bronze");
  });
});
