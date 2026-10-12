/** Test contacts, the manual "Teste" segment and firing a flow by hand ("Disparar teste"). */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
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

function fakeFetch() {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ accepted: 1, queued: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const pushfy = (impl: typeof fetch, live: boolean) => ({
  pushfy: { token: "tok-test", fetchImpl: impl, live },
});

const graph = {
  nodes: [
    { id: "start", type: "trigger", config: {} },
    { id: "w", type: "wait", config: { amount: 2, unit: "days" } },
    { id: "sms", type: "send", config: { template_key: "tl_sms" } },
    { id: "ev", type: "wait_event", config: { fact: "PURCHASE_PAID", timeout_hours: 48 } },
    { id: "mail", type: "send", config: { template_key: "tl_email" } },
  ],
  edges: [
    { source: "start", target: "w", handle: "next" },
    { source: "w", target: "sms", handle: "next" },
    { source: "sms", target: "ev", handle: "next" },
    { source: "ev", target: "mail", handle: "timeout" },
  ],
};

describe("Test segment and test launch", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'tl_%')`;
    await sql!`delete from crm.flows where key like 'tl_%'`;
    await sql!`delete from crm.message_templates where key like 'tl_%'`;
    await sql!`delete from crm.segments where key = 'tl_regra'`;
    await sql!`update crm.automations set active = false`;
    // outside the send window and a cap of 1: a test must ignore both
    await sql!`update crm.settings set value = '{"start_hour":3,"end_hour":3}' where key = 'send_window'`;
    await sql!`update crm.settings set value = '1' where key = 'max_actions_per_customer_per_day'`;
    await call("crm_upsert_template", {
      p_key: "tl_sms",
      p_name: "SMS teste",
      p_channel: "sms",
      p_purpose: "marketing",
      p_content: { text: "Kakauma: oi {{first_name}}" },
    });
    await call("crm_upsert_template", {
      p_key: "tl_email",
      p_name: "E-mail teste",
      p_channel: "email",
      p_purpose: "marketing",
      p_content: { subject: "Oi", blocks: [{ type: "text", text: "Oi {{first_name}}" }] },
    });
    await call("crm_save_flow", {
      p_key: "tl_fluxo",
      p_name: "Fluxo de teste",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: graph,
      // nobody matches this entry rule: a test must not depend on it
      p_entry_rule: { field: "paid_orders", op: ">=", value: 99 },
    });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'tl_%'`;
    await sql!`delete from crm.segment_members where segment_id = (select segment_id from crm.segments where key = 'teste')`;
    await sql!`update crm.automations set active = true`;
    await sql!`update crm.settings set value = '{"start_hour":8,"end_hour":21}' where key = 'send_window'`;
    await sql!`update crm.settings set value = '3' where key = 'max_actions_per_customer_per_day'`;
    await sql?.end();
  });

  test("the Teste segment is a manual list", async () => {
    const segs = await call<any[]>("crm_list_segments");
    const t = segs.find((s) => s.key === "teste");
    assert.equal(t?.kind, "manual");
    assert.equal(segs[0]!.kind, "manual"); // manual lists come first
  });

  test("adding contacts creates test customers once; bad input is refused", async () => {
    const a = await call("crm_add_test_contact", {
      p_name: "Felipe Teste",
      p_email: " Felipe.Teste@Example.com ",
      p_phone: "(11) 91111-2222",
      p_actor: "op@x.com",
    });
    assert.equal(a.created, true);
    const again = await call("crm_add_test_contact", {
      p_name: "Outro nome",
      p_email: "felipe.teste@example.com",
      p_phone: "",
    });
    assert.deepEqual([again.customer_id, again.created], [a.customer_id, false]);
    const byPhone = await call("crm_add_test_contact", {
      p_name: null,
      p_email: null,
      p_phone: "+55 11 91111-2222",
    });
    assert.equal(byPhone.customer_id, a.customer_id);
    await call("crm_add_test_contact", {
      p_name: "Rodrigo Teste",
      p_email: "rodrigo.teste@example.com",
      p_phone: "19 98888-0000",
    });

    const bad = await rpc("crm_add_test_contact", {
      p_name: "X",
      p_email: null,
      p_phone: "9999-0000",
    });
    assert.match(bad.error?.message ?? "", /Celular inválido/);
    const none = await rpc("crm_add_test_contact", { p_name: "X", p_email: "", p_phone: "" });
    assert.match(none.error?.message ?? "", /e-mail ou celular/);
    const rule = await rpc("crm_add_test_contact", {
      p_name: "X",
      p_email: "x@example.com",
      p_phone: null,
      p_segment: "customer_active",
    });
    assert.match(rule.error?.message ?? "", /segmento manual/);

    const members = await call<any[]>("crm_segment_contacts", { p_segment: "teste" });
    assert.equal(members.length, 2);
    assert.deepEqual(
      members.map((m) => [m.email, m.phone, m.is_test]),
      [
        ["felipe.teste@example.com", "11911112222", true],
        ["rodrigo.teste@example.com", "19988880000", true],
      ],
    );
    const [c] =
      await sql!`select is_test, current_customer_type from crm.customers where customer_id = ${a.customer_id}`;
    assert.equal(c!["is_test"], true);
    const audit =
      await sql!`select count(*)::int as n from crm.audit_logs where entity = 'segments' and entity_id = 'teste'
                              and field = 'member_added' and actor = 'user:op@x.com'`;
    assert.equal(audit[0]!["n"], 1);
  });

  test("the rule engine never empties a manual segment", async () => {
    const [c] =
      await sql!`select customer_id from crm.customers where email = 'felipe.teste@example.com'`;
    await sql!`select crm.refresh_customer(${c!["customer_id"]})`;
    await sql!`select crm.rebuild_segment(segment_id) from crm.segments where key = 'teste'`;
    const members = await call<any[]>("crm_segment_contacts", { p_segment: "teste" });
    assert.equal(members.length, 2);
    // is_test is a rule field too (e.g. a flow entry rule while testing)
    const p = await call("crm_preview_rule", { p_rule: { field: "is_test", op: "is_true" } });
    assert.equal(p.matches, 2);
  });

  test("firing an unpublished flow sends to the test contacts now, skipping waits", async () => {
    const f = fakeFetch();
    const launch = await call("crm_launch_flow_test", {
      p_key: "tl_fluxo",
      p_segment: "teste",
      p_skip_waits: true,
      p_actor: "op@x.com",
    });
    assert.deepEqual([launch.enrolled, launch.already_in_flow, launch.version], [2, 0, -1]);
    // not live yet: real customers would get a simulation, a test goes out for real
    await runFlows(rpc, pushfy(f.impl, false));

    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map((c) => c.body.messages[0].destinations[0].to).sort(), [
      "5511911112222",
      "5519988880000",
    ]);
    assert.equal(f.calls[0]!.body.messages[0].text.startsWith("Kakauma: oi "), true);

    const rows = await sql!`select e.status, e.is_test, m.channel, m.status as msg, m.skip_reason
                              from crm.flow_enrollments e join crm.flows f using (flow_id)
                              join crm.messages m using (enrollment_id)
                             where f.key = 'tl_fluxo' order by m.channel, e.entered_at`;
    // SMS sent, then the e-mail of the timeout path (no e-mail channel: simulation)
    assert.deepEqual(
      rows.map((r) => [r["status"], r["is_test"], r["channel"], r["msg"]]),
      [
        ["COMPLETED", true, "email", "DRY_RUN"],
        ["COMPLETED", true, "email", "DRY_RUN"],
        ["COMPLETED", true, "sms", "SENT"],
        ["COMPLETED", true, "sms", "SENT"],
      ],
    );
    const steps = await sql!`select distinct s.node_id, s.outcome from crm.flow_steps s
                               join crm.flow_enrollments e using (enrollment_id) join crm.flows f using (flow_id)
                              where f.key = 'tl_fluxo' order by 1`;
    assert.deepEqual(
      steps.map((s) => `${s["node_id"]}:${s["outcome"]}`),
      ["ev:timeout", "mail:queued", "sms:queued", "start:entered", "w:test_skipped"],
    );

    // the flow's own numbers ignore tests; the test list shows what happened
    const stats = await call("crm_flow_stats", { p_key: "tl_fluxo" });
    assert.equal(stats.enrollments.total, 0);
    assert.equal(stats.messages.sent, 0);
    assert.equal(stats.tests.length, 2);
    assert.deepEqual(
      stats.tests[0].messages.map((m: any) => [m.channel, m.status]),
      [
        ["sms", "SENT"],
        ["email", "DRY_RUN"],
      ],
    );
    const list = await call<any[]>("crm_list_flows");
    const row = list.find((x) => x.key === "tl_fluxo");
    assert.deepEqual(
      [Number(row.completed), Number(row.messages_30d), row.status],
      [0, 0, "DRAFT"],
    );
  });

  test("without skipping waits the test stops at the wait like a real customer", async () => {
    const f = fakeFetch();
    const launch = await call("crm_launch_flow_test", {
      p_key: "tl_fluxo",
      p_skip_waits: false,
    });
    assert.equal(launch.enrolled, 2);
    await runFlows(rpc, pushfy(f.impl, false));
    assert.equal(f.calls.length, 0);
    const live =
      await sql!`select e.status, e.version, e.next_run_at > now() + interval '1 day' as later
                              from crm.flow_enrollments e join crm.flows f using (flow_id)
                             where f.key = 'tl_fluxo' and e.status in ('ACTIVE','WAITING')`;
    assert.deepEqual(
      live.map((r) => [r["status"], r["version"], r["later"]]),
      [
        ["ACTIVE", -2, true],
        ["ACTIVE", -2, true],
      ],
    );
    // firing again replaces the previous test
    const again = await call("crm_launch_flow_test", { p_key: "tl_fluxo" });
    assert.equal(again.enrolled, 2);
    const ended = await sql!`select count(*)::int as n from crm.flow_enrollments
                              where exit_reason = 'test_relaunched'`;
    assert.equal(ended[0]!["n"], 2);
    await runFlows(rpc, pushfy(f.impl, false));
    assert.equal(f.calls.length, 2);
  });

  test("opt-out still applies to a test", async () => {
    const [c] =
      await sql!`select customer_id from crm.customers where email = 'rodrigo.teste@example.com'`;
    await call("crm_set_optout", {
      p_customer_id: c!["customer_id"],
      p_channel: "sms",
      p_opt_out: true,
    });
    const f = fakeFetch();
    await call("crm_launch_flow_test", { p_key: "tl_fluxo" });
    await runFlows(rpc, pushfy(f.impl, true));
    assert.equal(f.calls.length, 1);
    const [m] =
      await sql!`select m.status, m.skip_reason from crm.messages m join crm.flow_enrollments e using (enrollment_id)
                            where e.customer_id = ${c!["customer_id"]} and m.channel = 'sms'
                            order by m.created_at desc limit 1`;
    assert.deepEqual([m!["status"], m!["skip_reason"]], ["SKIPPED", "opt_out"]);
  });

  test("tests only go to manual segments, never to an empty one or a broken flow", async () => {
    const rule = await rpc("crm_launch_flow_test", {
      p_key: "tl_fluxo",
      p_segment: "customer_active",
    });
    assert.match(rule.error?.message ?? "", /segmento manual/);
    await sql!`insert into crm.segments (key, name, category, definition, kind)
               values ('tl_vazio', 'Vazio', 'test', '{}', 'manual') on conflict do nothing`;
    const empty = await rpc("crm_launch_flow_test", { p_key: "tl_fluxo", p_segment: "tl_vazio" });
    assert.match(empty.error?.message ?? "", /está vazio/);
    await sql!`delete from crm.segments where key = 'tl_vazio'`;
    await call("crm_save_flow", {
      p_key: "tl_quebrado",
      p_name: "Quebrado",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "s", type: "send", config: {} },
        ],
        edges: [{ source: "start", target: "s", handle: "next" }],
      },
    });
    const broken = await rpc("crm_launch_flow_test", { p_key: "tl_quebrado" });
    assert.match(broken.error?.message ?? "", /Corrija o fluxo/);
  });

  test("removing a contact takes it out of the list", async () => {
    const [c] =
      await sql!`select customer_id from crm.customers where email = 'rodrigo.teste@example.com'`;
    assert.equal(
      await call("crm_remove_segment_contact", {
        p_segment: "teste",
        p_customer_id: c!["customer_id"],
      }),
      true,
    );
    const members = await call<any[]>("crm_segment_contacts", { p_segment: "teste" });
    assert.deepEqual(
      members.map((m) => m.email),
      ["felipe.teste@example.com"],
    );
  });
});
