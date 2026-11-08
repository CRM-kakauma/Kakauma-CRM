/** What the attendant sees: spent, orders, pots, last purchase, temperature, history and tags. */
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
  temperature: string;
  temperature_reason: string;
  tip: string;
  summary: {
    orders: number;
    pots: number;
    spent: number;
    last_product: string | null;
    days_since_purchase: number | null;
  };
  auto: { key: string }[];
  manual: string[];
};
const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
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
const paid = (
  id: string,
  phone: string,
  sale: string,
  amount: number,
  offer: object,
  daysAgo = 0,
) =>
  send(
    b4("approved-payment", {
      customer: buyer(id, phone),
      sale_id: sale,
      offer,
      charges: [{ id: `C${sale}`, amount }],
      created_at: iso(daysAgo),
      updated_at: iso(daysAgo),
      paid_at: iso(daysAgo),
    }),
  );
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
        at: iso(),
      },
    ],
  });
  const [c] = await sql!`select chat_id from crm.wa_chats where phone = ${digits}`;
  return String(c!["chat_id"]);
};
const badges = async (chat: string) =>
  ((await call("crm_wa_chat", { p_chat: chat })) as { badges: Badges }).badges;
const ONE = { id: "of_1", name: "Sleep Drink 1 pote", quantity: 1, original_price: 147 };
const KIT3 = { id: "of_3", name: "Kit 3 potes Sleep Drink", quantity: 3, original_price: 297 };

describe("Cliente no atendimento", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  let original: unknown = null;
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.wa_messages`;
    await sql!`delete from crm.wa_chats`;
    await sql!`delete from crm.customer_tags`;
    original = await call("crm_customer_temperature_config");
  });
  after(async () => {
    if (original) await call("crm_save_customer_temperature", { p_value: original });
    await sql?.end();
  });

  test("pots from the offer name or quantity", async () => {
    const pots = async (name: string | null, offerQty: number | null, qty: number | null) =>
      Number(
        (
          await sql!`select crm.order_pots(${name}, null, ${offerQty}::numeric, ${qty}::numeric) as p`
        )[0]!["p"],
      );
    assert.equal(await pots("Kit 3 potes Sleep Drink", null, null), 3);
    assert.equal(await pots("Compre 2 leve 3 frascos", null, null), 3);
    assert.equal(await pots("Sleep Drink", 2, 2), 2);
    assert.equal(await pots("Sleep Drink", null, 2), 2);
    assert.equal(await pots(null, null, null), 1);
  });

  test("never bought, abandoned a cart today: Quente, with the cart tag", async () => {
    await send(
      b4("abandoned-cart", {
        customer: buyer("Lead", "(31) 91111-2222"),
        created_at: iso(),
        updated_at: iso(),
      }),
    );
    const b = await badges(await chatOf("5531911112222"));
    assert.equal(b.temperature, "quente");
    assert.match(b.temperature_reason, /Tentou comprar hoje/);
    assert.equal(b.summary.orders, 0);
    assert.deepEqual(
      b.auto.map((x) => x.key),
      ["carrinho"],
    );
  });

  test("spent, orders, pots and last purchase; Quente → Morno → Frio with time", async () => {
    await paid("Bia", "(31) 92222-3333", "S-B1", 147, ONE, 50);
    await paid("Bia", "(31) 92222-3333", "S-B2", 297, KIT3, 40);
    const chat = await chatOf("5531922223333");
    let b = await badges(chat);
    assert.equal(b.summary.orders, 2);
    assert.equal(Number(b.summary.pots), 4);
    assert.equal(Number(b.summary.spent), 444);
    assert.equal(b.summary.last_product, "Kit 3 potes Sleep Drink");
    assert.equal(b.summary.days_since_purchase, 40);
    assert.equal(b.temperature, "morno");
    await sql!`update crm.orders set paid_at = paid_at + interval '35 days' where sale_id = 'S-B2'`;
    assert.equal((await badges(chat)).temperature, "quente");
    await sql!`update crm.orders set paid_at = now() - interval '200 days' where customer_id =
                 (select customer_id from crm.customers where external_customer_id = 'cus_Bia')`;
    b = await badges(chat);
    assert.equal(b.temperature, "frio");
    assert.match(b.tip, /reative/i);
  });

  test("history: purchases with product, pots and value, newest first", async () => {
    const chat = await chatOf("5531922223333");
    const h = (await call("crm_wa_history", { p_chat: chat })) as {
      kind: string;
      product: string;
      pots: number;
      amount: number;
    }[];
    const buys = h.filter((x) => x.kind === "PURCHASE_PAID");
    assert.equal(buys.length, 2);
    assert.deepEqual(
      buys.map((x) => [x.product, Number(x.pots), Number(x.amount)]),
      [
        ["Kit 3 potes Sleep Drink", 3, 297],
        ["Sleep Drink 1 pote", 1, 147],
      ],
    );
  });

  test("temperature days can be changed", async () => {
    const cfg = (await call("crm_customer_temperature_config")) as Record<string, unknown>;
    cfg["warm_purchase_days"] = 365;
    await call("crm_save_customer_temperature", { p_value: cfg, p_actor: "admin@x" });
    assert.equal((await badges(await chatOf("5531922223333"))).temperature, "morno");
  });

  test("manual tags: on the customer, or on the chat for a contact who is not a customer", async () => {
    const chat = await chatOf("5531922223333");
    await call("crm_wa_tag", {
      p_chat: chat,
      p_tag: "  Prefere   áudio ",
      p_add: true,
      p_actor: "a@x",
    });
    await call("crm_wa_tag", { p_chat: chat, p_tag: "Kit família", p_add: true });
    assert.deepEqual((await badges(chat)).manual, ["Prefere áudio", "Kit família"]);
    await call("crm_wa_tag", { p_chat: chat, p_tag: "Kit família", p_add: false });
    assert.deepEqual((await badges(chat)).manual, ["Prefere áudio"]);
    const stranger = await chatOf("5511955556666");
    await call("crm_wa_tag", { p_chat: stranger, p_tag: "Revendedor", p_add: true });
    const sb = await badges(stranger);
    assert.deepEqual(sb.manual, ["Revendedor"]);
    assert.equal(sb.temperature, "frio");
    const found = (await call("crm_wa_chats", {
      p_instance: "Kakauma",
      p_search: "revend",
    })) as unknown[];
    assert.equal(found.length, 1);
  });
});
