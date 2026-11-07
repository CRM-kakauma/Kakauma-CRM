/** A message never reaches the customer twice: interrupted sends, repeats within a day, time limit. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
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

/** Evolution double: counts the messages that reached "WhatsApp". */
function evolution() {
  const sent: string[] = [];
  const impl = (async (_url: string, init: RequestInit = {}) => {
    sent.push(String(JSON.parse(String(init.body)).number));
    return new Response(JSON.stringify({ key: { id: `EVO${sent.length}` } }), { status: 201 });
  }) as unknown as typeof fetch;
  return {
    sent,
    opts: {
      evolution: {
        baseUrl: "https://evo.example.com",
        apiKey: "K",
        instance: "kakauma",
        fetchImpl: impl,
        live: true,
      },
    },
  };
}

let n = 0;
const abandon = async (who: string, phone: string, offer = "off_1") => {
  n++;
  const now = new Date(Date.now() - n * 1000).toISOString(); // distinct events
  const r = await ingestWebhook(
    rpc,
    "b4you",
    JSON.stringify(
      b4("abandoned-cart", {
        customer: {
          id: `cus_${who}`,
          full_name: who,
          email: `${who}@example.com`,
          whatsapp: phone,
        },
        offer: { id: offer, name: offer, quantity: 1, original_price: 100 },
        created_at: now,
        updated_at: now,
      }),
    ),
  );
  assert.ok(r.status < 300, JSON.stringify(r.body));
};
const messages = (who: string) =>
  sql!`select m.status, m.skip_reason, m.error from crm.messages m join crm.customers c using (customer_id)
        where c.external_customer_id = ${"cus_" + who} order by m.created_at`;

describe("Messages go out once", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'mo_%')`;
    await sql!`delete from crm.flows where key like 'mo_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await sql!`update crm.settings set value = '{"start_hour":0,"end_hour":24}' where key = 'send_window'`;
    await call("crm_upsert_template", {
      p_key: "mo_cart",
      p_name: "Carrinho WA",
      p_channel: "whatsapp",
      p_purpose: "marketing",
      p_content: {
        category: "marketing",
        header: { type: "none" },
        body: "Oi {{first_name}}, esqueceu algo?",
        footer: "",
        buttons: [],
      },
    });
    await call("crm_save_flow", {
      p_key: "mo_flow",
      p_name: "Carrinho abandonado",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "mo_cart" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    assert.equal(await call("crm_publish_flow", { p_key: "mo_flow" }), 1);
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'mo_%'`;
    await sql!`update crm.automations set active = true`;
    await sql!`update crm.settings set value = '{"start_hour":8,"end_hour":21}' where key = 'send_window'`;
    await sql?.end();
  });

  test("a send cut midway is closed as interrupted, never sent again", async () => {
    const evo = evolution();
    await abandon("Ana", "(11) 91111-1111");
    // the request stopped after the provider got it: the message stays PROCESSING
    await call("crm_flow_tick", { p_limit: 500 });
    await call("crm_claim_messages", { p_limit: 100 });
    await sql!`update crm.messages set updated_at = now() - interval '20 minutes' where status = 'PROCESSING'`;
    await runFlows(rpc, evo.opts);
    assert.equal(evo.sent.length, 0, "not sent a second time");
    const [m] = await messages("Ana");
    assert.equal(m!["status"], "FAILED");
    assert.match(String(m!["error"]), /interrompido/);
  });

  test("two abandoned carts in a row: the same message only once a day", async () => {
    const evo = evolution();
    await abandon("Bia", "(11) 92222-2222", "off_1");
    await runFlows(rpc, evo.opts);
    await abandon("Bia", "(11) 92222-2222", "off_2"); // another offer: the flow starts again
    await runFlows(rpc, evo.opts);
    assert.equal(evo.sent.length, 1);
    const ms = await messages("Bia");
    assert.deepEqual(
      ms.map((m) => [m["status"], m["skip_reason"]]),
      [
        ["SENT", null],
        ["SKIPPED", "repeated_24h"],
      ],
    );
  });

  test("out of time: nothing is sent and the messages go back to the queue", async () => {
    const evo = evolution();
    await abandon("Caio", "(11) 93333-3333");
    await runFlows(rpc, { ...evo.opts, deadline: Date.now() - 1 });
    assert.equal(evo.sent.length, 0);
    const [m] = await messages("Caio");
    assert.equal(m!["status"], "QUEUED");
    // the next run (the cron) sends it
    await runFlows(rpc, evo.opts);
    assert.equal(evo.sent.length, 1);
    const [m2] = await messages("Caio");
    assert.equal(m2!["status"], "SENT");
  });
});

describe(
  "Each flow only once per customer",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    const sql2 = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
    const rpc2: Rpc = sql2 ? makeRpc(sql2) : async () => ({ data: null, error: null });
    const call2 = async (fn: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await rpc2(fn, args);
      assert.equal(error, null, error?.message);
      return data;
    };
    const cart = async (who: string, offer: string) => {
      const now = new Date().toISOString();
      const r = await ingestWebhook(
        rpc2,
        "b4you",
        JSON.stringify(
          b4("abandoned-cart", {
            customer: { id: `cus_${who}`, full_name: who, email: `${who}@example.com` },
            offer: { id: offer, name: offer, quantity: 1, original_price: 100 },
            created_at: now,
            updated_at: now,
          }),
        ),
      );
      assert.ok(r.status < 300, JSON.stringify(r.body));
    };
    const entries = async (who: string) =>
      (
        await sql2!`select count(*)::int as n from crm.flow_enrollments en join crm.flows f using (flow_id)
                   join crm.customers c using (customer_id)
                   where f.key = 'mo_once' and c.external_customer_id = ${"cus_" + who} and not en.is_test`
      )[0]!["n"];

    before(async () => {
      await sql2!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
      await call2("crm_save_flow", {
        p_key: "mo_once",
        p_name: "Carrinho uma vez",
        p_trigger_fact: "CHECKOUT_ABANDONED",
        p_reentry: "once",
        p_graph: {
          nodes: [
            { id: "start", type: "trigger", config: {} },
            { id: "end", type: "exit", config: {} },
          ],
          edges: [{ source: "start", target: "end", handle: "next" }],
        },
      });
      await call2("crm_publish_flow", { p_key: "mo_once" });
    });
    after(async () => {
      await sql2!`update crm.flows set status = 'ARCHIVED' where key = 'mo_once'`;
      await sql2?.end();
    });

    test("finished the flow once: a new trigger does not start it again", async () => {
      await cart("Duda", "off_a");
      await runFlows(rpc2, {});
      assert.equal(await entries("Duda"), 1);
      await cart("Duda", "off_b");
      await runFlows(rpc2, {});
      assert.equal(await entries("Duda"), 1);
    });

    test("a test run does not count as having been through the flow", async () => {
      await cart("Edu", "off_a"); // creates the customer and enters
      await sql2!`delete from crm.flow_enrollments where customer_id in
                 (select customer_id from crm.customers where external_customer_id = 'cus_Edu')`;
      await sql2!`insert into crm.flow_enrollments (flow_id, version, customer_id, current_node, status, is_test, finished_at)
                 select f.flow_id, f.version, c.customer_id, 'end', 'COMPLETED', true, now()
                   from crm.flows f, crm.customers c where f.key = 'mo_once' and c.external_customer_id = 'cus_Edu'`;
      await cart("Edu", "off_b");
      assert.equal(await entries("Edu"), 1);
    });

    test("every flow is 'only once' and new flows start that way", async () => {
      const [d] = await sql2!`select column_default from information_schema.columns
                             where table_schema = 'crm' and table_name = 'flows' and column_name = 'reentry'`;
      assert.match(String(d!["column_default"]), /once/);
    });
  },
);
