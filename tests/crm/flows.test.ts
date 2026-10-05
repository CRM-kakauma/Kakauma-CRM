/** Flows (journeys) and message templates: validation, engine, waits, goals, opt-out, simulation, versions. */
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
const call = async <T = any>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const person = (id: string, extra: object = {}) => ({
  id: `cus_${id}`,
  full_name: `Pessoa ${id}`,
  email: `${id.toLowerCase()}@example.com`,
  // unique per id: a shared phone would merge two test customers
  whatsapp: `1197${String([...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9_999_999, 7)).padStart(7, "0")}`,
  ...extra,
});
const send = (p: object) => ingestWebhook(rpc, "b4you", JSON.stringify(p));
const paid = (cust: object, sale: string, amount: number) =>
  send(
    b4("approved-payment", {
      customer: cust,
      sale_id: sale,
      payment_method: "pix",
      created_at: ago(0),
      updated_at: ago(0),
      paid_at: ago(0),
      charges: [{ id: `C${sale}`, amount }],
    }),
  );
const cid = async (ext: string) =>
  (
    await sql!`select customer_id from crm.customers where external_customer_id = ${"cus_" + ext}`
  )[0]!["customer_id"] as string;
const enrollment = async (flow: string, ext: string) =>
  (
    await sql!`select e.* from crm.flow_enrollments e join crm.flows f using (flow_id)
               join crm.customers c using (customer_id)
               where f.key = ${flow} and c.external_customer_id = ${"cus_" + ext}
               order by e.entered_at desc limit 1`
  )[0];

const SMS = "teste_sms";
const graphVip = {
  nodes: [
    { id: "start", type: "trigger", config: {} },
    { id: "sms", type: "send", config: { template_key: SMS } },
    { id: "vip", type: "condition", config: { rule: { field: "net_ltv", op: ">=", value: 300 } } },
    {
      id: "team",
      type: "alert_team",
      config: { message: "VIP {{full_name}} comprou R$ {{net_ltv}}" },
    },
    { id: "w", type: "wait", config: { amount: 1, unit: "days" } },
    { id: "end", type: "exit", config: {} },
  ],
  edges: [
    { source: "start", target: "sms", handle: "next" },
    { source: "sms", target: "vip", handle: "next" },
    { source: "vip", target: "team", handle: "yes" },
    { source: "vip", target: "w", handle: "no" },
    { source: "w", target: "end", handle: "next" },
  ],
};

describe("CRM flows and messages", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'teste_%')`;
    await sql!`delete from crm.flows where key like 'teste_%'`;
    await sql!`delete from crm.message_templates where key like 'teste_%'`;
    await sql!`update crm.automations set active = false`;
    await sql!`update crm.settings set value = '{"start_hour":0,"end_hour":24}' where key = 'send_window'`;
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'teste_%'`;
    await sql!`update crm.automations set active = true`;
    await sql!`update crm.settings set value = '{"start_hour":8,"end_hour":21}' where key = 'send_window'`;
    await sql?.end();
  });

  test("templates are validated per channel", async () => {
    const wa = await call<string[]>("crm_template_errors", {
      p_channel: "whatsapp",
      p_content: {
        category: "marketing",
        body: "oi",
        buttons: [1, 2, 3, 4].map((i) => ({ type: "quick_reply", text: `b${i}` })),
      },
    });
    assert.ok(wa.includes("Máximo de 3 botões"));
    const email = await rpc("crm_upsert_template", {
      p_key: "teste_email",
      p_name: "E",
      p_channel: "email",
      p_content: {
        subject: "",
        blocks: [{ type: "button", text: "x", url: "javascript:alert(1)" }],
      },
    });
    assert.match(String(email.error?.message), /Assunto é obrigatório/);
    assert.match(String(email.error?.message), /https/);
    const rcs = await call<string[]>("crm_template_errors", {
      p_channel: "rcs",
      p_content: { kind: "carousel", cards: [{ title: "a" }] },
    });
    assert.ok(rcs.some((e) => /2 a 10/.test(e)));
    assert.ok(rcs.some((e) => /SMS alternativo/.test(e)));

    await call("crm_upsert_template", {
      p_key: SMS,
      p_name: "SMS teste",
      p_channel: "sms",
      p_purpose: "marketing",
      p_content: { text: "Oi {{first_name}}, obrigado!" },
      p_actor: "op@x.com",
    });
    const list = await call<any[]>("crm_list_templates", { p_channel: "sms" });
    assert.ok(list.some((t) => t.key === SMS));
  });

  test("a graph with problems saves as draft but cannot be published", async () => {
    const bad = {
      nodes: [
        { id: "start", type: "trigger" },
        {
          id: "a",
          type: "split",
          config: {
            branches: [
              { key: "a", percent: 70 },
              { key: "b", percent: 20 },
            ],
          },
        },
        { id: "s", type: "send", config: { template_key: "nao_existe" } },
      ],
      edges: [
        { source: "start", target: "a" },
        { source: "a", target: "s", handle: "c" },
      ],
    };
    const saved = await call("crm_save_flow", {
      p_key: "teste_ruim",
      p_name: "Ruim",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: bad,
    });
    assert.ok(saved.errors.some((e: string) => /somam 90%/.test(e)));
    assert.ok(saved.errors.some((e: string) => /escolha uma mensagem/.test(e)));
    const pub = await rpc("crm_publish_flow", { p_key: "teste_ruim" });
    assert.match(String(pub.error?.message), /Corrija antes de publicar/);
    const act = await rpc("crm_set_flow_status", { p_key: "teste_ruim", p_status: "ACTIVE" });
    assert.match(String(act.error?.message), /Publique/);
  });

  test("purchase runs the flow: message, condition branch, team alert, dry-run delivery", async () => {
    await call("crm_save_flow", {
      p_key: "teste_vip",
      p_name: "VIP",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: graphVip,
      p_actor: "op@x.com",
    });
    assert.equal(await call("crm_publish_flow", { p_key: "teste_vip", p_actor: "op@x.com" }), 1);

    await paid(person("F1"), "SF1", 400); // VIP path
    await paid(person("F2"), "SF2", 100); // wait path
    const r = await runFlows(rpc);
    assert.equal(r.advanced, 2);
    const byChannel = r.messages.reduce<Record<string, number>>(
      (a, m) => ({ ...a, [m.channel]: (a[m.channel] ?? 0) + 1 }),
      {},
    );
    assert.deepEqual(byChannel, { sms: 2, team: 1 });
    assert.ok(r.messages.every((m) => m.status === "DRY_RUN"));

    const e1 = await enrollment("teste_vip", "F1");
    assert.equal(e1!["status"], "COMPLETED");
    const e2 = await enrollment("teste_vip", "F2");
    assert.equal(e2!["status"], "ACTIVE");
    assert.equal(e2!["current_node"], "end");
    assert.ok(new Date(e2!["next_run_at"]).getTime() > Date.now() + 23 * 3600_000);

    const msgs = await call<any[]>("crm_list_messages", { p_flow_key: "teste_vip" });
    const sms = msgs.find((m) => m.channel === "sms" && m.full_name === "Pessoa F1");
    assert.equal(sms.rendered.text, "Oi Pessoa, obrigado!");
    assert.equal(sms.rendered.segments, 1);
    const team = msgs.find((m) => m.channel === "team");
    assert.match(team.rendered.text, /VIP Pessoa F1 comprou R\$ 400/);

    const stats = await call("crm_flow_stats", { p_key: "teste_vip" });
    assert.equal(stats.enrollments.total, 2);
    assert.equal(Number(stats.nodes.vip.outcomes.yes), 1);
    assert.equal(Number(stats.nodes.vip.outcomes.no), 1);
    assert.equal(Number(stats.here_now.w), 1); // waiting in the 1-day wait

    // the wait ends → exit
    await sql!`update crm.flow_enrollments set next_run_at = now() - interval '1 second' where enrollment_id = ${e2!["enrollment_id"]}`;
    await runFlows(rpc);
    assert.equal((await enrollment("teste_vip", "F2"))!["status"], "EXITED");
  });

  test("one live enrollment per customer; 'once' never re-enters", async () => {
    await paid(person("F2"), "SF2b", 50); // F2 already finished teste_vip → after_exit lets it in again
    await runFlows(rpc);
    const n =
      await sql!`select count(*)::int as n from crm.flow_enrollments e join crm.flows f using (flow_id)
                         where f.key = 'teste_vip' and e.customer_id = ${await cid("F2")}`;
    assert.equal(n[0]!["n"], 2);

    await sql!`update crm.flows set reentry = 'once' where key = 'teste_vip'`;
    await paid(person("F2"), "SF2c", 50);
    const m =
      await sql!`select count(*)::int as n from crm.flow_enrollments e join crm.flows f using (flow_id)
                         where f.key = 'teste_vip' and e.customer_id = ${await cid("F2")}`;
    assert.equal(m[0]!["n"], 2);
  });

  test("wait for event: the event continues on its path, otherwise the timeout path", async () => {
    await call("crm_save_flow", {
      p_key: "teste_carrinho",
      p_name: "Carrinho",
      p_trigger_fact: "CHECKOUT_ABANDONED",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger" },
          { id: "w", type: "wait_event", config: { fact: "PURCHASE_PAID", timeout_hours: 24 } },
          { id: "bought", type: "exit" },
          { id: "sms", type: "send", config: { template_key: SMS } },
        ],
        edges: [
          { source: "start", target: "w" },
          { source: "w", target: "bought", handle: "event" },
          { source: "w", target: "sms", handle: "timeout" },
        ],
      },
    });
    await call("crm_publish_flow", { p_key: "teste_carrinho" });
    await sql!`update crm.flows set status = 'PAUSED' where key = 'teste_vip'`;

    for (const id of ["C1", "C2"])
      await send(b4("abandoned-cart", { customer: person(id), updated_at: ago(0) }));
    await runFlows(rpc);
    assert.equal((await enrollment("teste_carrinho", "C1"))!["status"], "WAITING");

    await paid(person("C1"), "SC1", 120);
    await runFlows(rpc);
    const c1 = await enrollment("teste_carrinho", "C1");
    assert.equal(c1!["status"], "EXITED");
    assert.equal(c1!["exit_reason"], "exit_step");

    await sql!`update crm.flow_enrollments set next_run_at = now() - interval '1 second'
               where enrollment_id = ${(await enrollment("teste_carrinho", "C2"))!["enrollment_id"]}`;
    const r = await runFlows(rpc);
    assert.equal(r.messages.length, 1);
    assert.equal((await enrollment("teste_carrinho", "C2"))!["status"], "COMPLETED");
  });

  test("goal ends the enrollment as a conversion", async () => {
    await sql!`update crm.flows set goal_fact = 'PURCHASE_PAID',
                 graph = jsonb_set(graph, '{nodes,1,config,timeout_hours}', '48') where key = 'teste_carrinho'`;
    await call("crm_publish_flow", { p_key: "teste_carrinho" });
    await send(b4("abandoned-cart", { customer: person("C3"), updated_at: ago(0) }));
    await runFlows(rpc);
    assert.equal((await enrollment("teste_carrinho", "C3"))!["version"], 2);
    await paid(person("C3"), "SC3", 90);
    const e = await enrollment("teste_carrinho", "C3");
    assert.equal(e!["status"], "GOAL");
    const stats = await call("crm_flow_stats", { p_key: "teste_carrinho" });
    assert.equal(stats.enrollments.goal, 1);
    assert.deepEqual(stats.split_goals, {}); // no A/B step in this flow
  });

  test("opt-out skips marketing messages; transactional still goes", async () => {
    await sql!`update crm.flows set status = 'ACTIVE' where key = 'teste_vip'`;
    await sql!`update crm.flows set reentry = 'after_exit' where key = 'teste_vip'`;
    await paid(person("O1"), "SO1", 80);
    const id = await cid("O1");
    await call("crm_set_optout", {
      p_customer_id: id,
      p_channel: "sms",
      p_opt_out: true,
      p_actor: "op@x.com",
    });
    const r = await runFlows(rpc);
    const skipped = (await call<any[]>("crm_list_messages", { p_flow_key: "teste_vip" })).find(
      (m) => m.customer_id === id,
    );
    assert.equal(skipped.status, "SKIPPED");
    assert.equal(skipped.skip_reason, "opt_out");
    assert.ok(r.advanced >= 1);

    await sql!`update crm.message_templates set purpose = 'transactional' where key = ${SMS}`;
    await sql!`delete from crm.messages where customer_id = ${id}`;
    await sql!`update crm.flow_enrollments set status = 'ACTIVE', current_node = 'sms', next_run_at = now(), finished_at = null
               where customer_id = ${id}`;
    await runFlows(rpc);
    const ok = (await call<any[]>("crm_list_messages", { p_flow_key: "teste_vip" })).find(
      (m) => m.customer_id === id,
    );
    assert.equal(ok.status, "DRY_RUN");
    const c360 = await call("crm_customer_360", { p_customer_id: id });
    assert.deepEqual(c360.crm.optouts, ["sms"]);
    assert.ok(c360.crm.flows.length >= 1);
    assert.ok(c360.crm.messages.length >= 1);
  });

  test("send window moves marketing messages to the next opening", async () => {
    await sql!`update crm.settings set value = '{"start_hour":8,"end_hour":21}' where key = 'send_window'`;
    const [r] = await sql!`select crm.next_send_time('2026-10-05 23:30:00-03') as a,
                                  crm.next_send_time('2026-10-05 06:00:00-03') as b,
                                  crm.next_send_time('2026-10-05 12:00:00-03') as c`;
    assert.equal(new Date(r!["a"]).toISOString(), "2026-10-06T11:00:00.000Z");
    assert.equal(new Date(r!["b"]).toISOString(), "2026-10-05T11:00:00.000Z");
    assert.equal(new Date(r!["c"]).toISOString(), "2026-10-05T15:00:00.000Z");
    await sql!`update crm.settings set value = '{"start_hour":0,"end_hour":24}' where key = 'send_window'`;
  });

  test("simulation shows the path a customer would take now", async () => {
    const vip = await call("crm_simulate_flow", {
      p_customer_id: await cid("F1"),
      p_graph: graphVip,
    });
    assert.deepEqual(
      vip.path.map((s: any) => `${s.node_id}:${s.outcome}`),
      ["start:next", "sms:next", "vip:yes", "team:next"],
    );
    assert.equal(vip.customer.first_name, "Pessoa");
    const blocked = await call("crm_simulate_flow", {
      p_customer_id: await cid("F1"),
      p_graph: graphVip,
      p_entry_rule: { field: "paid_orders", op: ">", value: 10 },
    });
    assert.equal(blocked.result, "EXITED");

    // "what if" the awaited event happens during the wait (text[] parameter)
    const carrinho = await call("crm_get_flow", { p_key: "teste_carrinho" });
    const happened = await call("crm_simulate_flow", {
      p_customer_id: await cid("C2"),
      p_graph: carrinho.graph,
      p_events: ["PURCHASE_PAID"],
    });
    assert.deepEqual(
      happened.path.map((s: any) => s.outcome),
      ["next", "event", "next"],
    );
  });

  test("editing a published flow keeps running enrollments on their version", async () => {
    const before = await call("crm_get_flow", { p_key: "teste_vip" });
    assert.equal(before.has_unpublished_changes, false);
    await call("crm_save_flow", {
      p_key: "teste_vip",
      p_name: "VIP v2",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        ...graphVip,
        nodes: graphVip.nodes.map((n) =>
          n.id === "w" ? { ...n, config: { amount: 2, unit: "hours" } } : n,
        ),
      },
    });
    const after = await call("crm_get_flow", { p_key: "teste_vip" });
    assert.equal(after.has_unpublished_changes, true);
    assert.equal(after.version, 1);
    assert.equal(after.published_graph.nodes.find((n: any) => n.id === "w").config.amount, 1);

    const archive = await rpc("crm_archive_template", { p_key: SMS });
    assert.match(String(archive.error?.message), /em uso/);

    await call("crm_set_flow_status", { p_key: "teste_vip", p_status: "ARCHIVED" });
    const live =
      await sql!`select count(*)::int as n from crm.flow_enrollments e join crm.flows f using (flow_id)
                            where f.key = 'teste_vip' and e.status in ('ACTIVE','WAITING')`;
    assert.equal(live[0]!["n"], 0);
  });
});
