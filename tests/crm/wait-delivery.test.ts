/** "Aguardar entrega" and the RCS → "SMS alternativo" fallback: immediate failures, operator reports, timeout. */
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

/** Pushfy stand-in: RCS answers with `rcs`, SMS always accepted. */
function pushfy(rcs: { status: number; body: unknown }) {
  const calls: { path: string; to: string }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ path, to: body.messages?.[0]?.destinations?.[0]?.to });
    const r = path === "/webapi" ? { status: 200, body: { accepted: 1, queued: 1 } } : rcs;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, opts: { pushfy: { token: "t", fetchImpl: impl, live: true } } };
}
const RCS_OK = { status: 200, body: [{ id: 1 }] };

const graph = (onTimeout = "delivered") => ({
  nodes: [
    { id: "start", type: "trigger", config: {} },
    { id: "rcs", type: "send", config: { template_key: "wd_rcs" } },
    { id: "wd", type: "wait_delivery", config: { timeout_hours: 6, on_timeout: onTimeout } },
    { id: "sms", type: "send", config: { template_key: "wd_sms" } },
    { id: "ok", type: "exit", config: {} },
  ],
  edges: [
    { source: "start", target: "rcs", handle: "next" },
    { source: "rcs", target: "wd", handle: "next" },
    { source: "wd", target: "sms", handle: "failed" },
    { source: "wd", target: "ok", handle: "delivered" },
  ],
});

const state = async () =>
  // the latest enrollment only (each test fires the flow again)
  sql!`select e.status, e.current_node, e.wait_fact, m.channel, m.status as msg, m.provider_status
         from crm.flow_enrollments e left join crm.messages m using (enrollment_id)
        where e.enrollment_id = (select x.enrollment_id from crm.flow_enrollments x join crm.flows f using (flow_id)
                                  where f.key = 'wd_flow' order by x.entered_at desc limit 1)
        order by m.channel nulls first`;

describe(
  "Aguardar entrega (wait_delivery)",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await resetCrm(sql!);
      await sql!`delete from crm.provider_events`;
      await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'wd_%')`;
      await sql!`delete from crm.flows where key like 'wd_%'`;
      await sql!`delete from crm.message_templates where key like 'wd_%'`;
      await sql!`update crm.automations set active = false`;
      await call("crm_upsert_template", {
        p_key: "wd_rcs",
        p_name: "RCS",
        p_channel: "rcs",
        p_purpose: "transactional",
        p_content: { kind: "text", text: "Oi {{first_name}}", fallback_sms: "Oi" },
      });
      await call("crm_upsert_template", {
        p_key: "wd_sms",
        p_name: "SMS",
        p_channel: "sms",
        p_purpose: "transactional",
        p_content: { text: "Kakauma: oi {{first_name}}" },
      });
      await call("crm_save_flow", {
        p_key: "wd_flow",
        p_name: "RCS com reserva",
        p_trigger_fact: "PURCHASE_PAID",
        p_graph: graph(),
      });
      await call("crm_add_test_contact", {
        p_name: "Ana",
        p_email: null,
        p_phone: "11 98888-0001",
      });
    });
    after(async () => {
      await sql!`update crm.flows set status = 'ARCHIVED' where key like 'wd_%'`;
      await sql!`delete from crm.segment_members where segment_id = (select segment_id from crm.segments where key = 'teste')`;
      await sql!`update crm.automations set active = true`;
      await sql?.end();
    });

    test("the step is validated: deadline 1 h to 7 days, two outputs", async () => {
      const bad = await call<string[]>("crm_flow_graph_errors", {
        p_graph: {
          ...graph(),
          nodes: graph().nodes.map((n) =>
            n.id === "wd" ? { ...n, config: { timeout_hours: 500, on_timeout: "x" } } : n,
          ),
        },
      });
      assert.ok(bad.some((e) => /prazo entre 1 hora e 7 dias/.test(e)));
      assert.ok(bad.some((e) => /sem confirmação/.test(e)));
      assert.deepEqual(await call("crm_flow_graph_errors", { p_graph: graph() }), []);
    });

    test("RCS refused by Pushfy → its own SMS alternativo goes at once, no branch needed", async () => {
      const f = pushfy({ status: 400, body: { error: "rcs_campaign_not_found" } });
      await call("crm_launch_flow_test", { p_key: "wd_flow" });
      await runFlows(rpc, f.opts);
      assert.deepEqual(
        f.calls.map((c) => c.path),
        ["/apircsbasic", "/webapi"],
      );
      const rows = await state();
      assert.deepEqual(
        rows.map((r) => [r["channel"], r["msg"]]),
        [["rcs", "SENT"]],
      );
      const [m] =
        await sql!`select m.result ->> 'sent_as' as sent_as, m.result #>> '{fallback,status}' as fb
                               from crm.messages m join crm.flows f using (flow_id)
                              where f.key = 'wd_flow' order by m.created_at desc limit 1`;
      assert.deepEqual([m!["sent_as"], m!["fb"]], ["sms_fallback", "SENT"]);
    });

    test("RCS accepted, then the operator reports Undelivered → SMS alternativo once (+ the branch, if kept)", async () => {
      const f = pushfy(RCS_OK);
      await call("crm_launch_flow_test", { p_key: "wd_flow" });
      await runFlows(rpc, f.opts);
      assert.deepEqual(
        f.calls.map((c) => c.path),
        ["/apircsbasic"],
      );
      let rows = await state();
      assert.deepEqual(
        [rows[0]!["status"], rows[0]!["current_node"], rows[0]!["wait_fact"]],
        ["ACTIVE", "wd", "__delivery"],
      );
      const [m] =
        await sql!`select m.message_id from crm.messages m join crm.flows f using (flow_id)
                           join crm.flow_enrollments e using (enrollment_id)
                           where f.key = 'wd_flow' and m.channel = 'rcs' and e.status = 'ACTIVE'`;
      await call("crm_pushfy_event", {
        p_payload: {
          id: 77,
          status: "Undelivered",
          ext_id: m!["message_id"],
          date_dlr: "2026-10-14 10:00:00",
        },
      });
      await runFlows(rpc, f.opts);
      // the RCS's own SMS alternativo, then the "Não entregue" branch of this test flow
      assert.deepEqual(
        f.calls.map((c) => c.path),
        ["/apircsbasic", "/webapi", "/webapi"],
      );
      rows = await state();
      assert.deepEqual(
        rows.map((r) => [r["channel"], r["msg"], r["provider_status"]]),
        [
          ["rcs", "SENT", "Undelivered"],
          ["sms", "SENT", null],
        ],
      );
      // another report or run never sends the fallback again
      await call("crm_pushfy_event", {
        p_payload: {
          id: 77,
          status: "Expired",
          ext_id: m!["message_id"],
          date_dlr: "2026-10-14 11:00:00",
        },
      });
      await runFlows(rpc, f.opts);
      assert.equal(f.calls.length, 3);
      const [r] =
        await sql!`select result ->> 'sent_as' as sent_as from crm.messages where message_id = ${m!["message_id"]}`;
      assert.equal(r!["sent_as"], "sms_fallback");
    });

    test("a fallback for a real customer is only simulated while Pushfy is not live", async () => {
      const [m] =
        await sql!`select m.message_id from crm.messages m join crm.flows f using (flow_id)
                              where f.key = 'wd_flow' and m.channel = 'rcs' order by m.created_at limit 1`;
      await sql!`update crm.flow_enrollments set is_test = false
                  where enrollment_id = (select enrollment_id from crm.messages where message_id = ${m!["message_id"]})`;
      await sql!`update crm.messages set status = 'SENT', provider_status = 'Rejected', provider_status_at = now(),
                        result = coalesce(result, '{}') - 'fallback' where message_id = ${m!["message_id"]}`;
      const f = pushfy(RCS_OK);
      await runFlows(rpc, { pushfy: { ...f.opts.pushfy, live: false } });
      assert.equal(f.calls.length, 0);
      const [r] =
        await sql!`select result #>> '{fallback,status}' as fb from crm.messages where message_id = ${m!["message_id"]}`;
      assert.equal(r!["fb"], "DRY_RUN");
    });

    test("Delivered → the delivered path, no SMS", async () => {
      const f = pushfy(RCS_OK);
      await call("crm_launch_flow_test", { p_key: "wd_flow" });
      await runFlows(rpc, f.opts);
      const [m] =
        await sql!`select m.message_id from crm.messages m join crm.flow_enrollments e using (enrollment_id)
                           join crm.flows f on f.flow_id = e.flow_id
                           where f.key = 'wd_flow' and m.channel = 'rcs' and e.status = 'ACTIVE'`;
      await call("crm_pushfy_event", {
        p_payload: {
          id: 78,
          status: "Delivered",
          ext_id: m!["message_id"],
          date_dlr: "2026-10-14 10:01:00",
        },
      });
      await runFlows(rpc, f.opts);
      assert.deepEqual(
        f.calls.map((c) => c.path),
        ["/apircsbasic"],
      );
      const rows = await state();
      assert.equal(rows[0]!["status"], "EXITED"); // the "ok" exit step
      assert.equal(rows.filter((r) => r["channel"] === "sms").length, 0);
    });

    test("no report within the deadline follows the chosen path", async () => {
      for (const [onTimeout, expectSms] of [
        ["delivered", false],
        ["failed", true],
      ] as const) {
        await call("crm_save_flow", {
          p_key: "wd_flow",
          p_name: "RCS com reserva",
          p_trigger_fact: "PURCHASE_PAID",
          p_graph: graph(onTimeout),
        });
        const f = pushfy(RCS_OK);
        await call("crm_launch_flow_test", { p_key: "wd_flow" });
        await runFlows(rpc, f.opts);
        await sql!`update crm.flow_enrollments set wait_started_at = now() - interval '7 hours', next_run_at = now()
                 where wait_fact = '__delivery' and status = 'ACTIVE'`;
        await runFlows(rpc, f.opts);
        assert.equal(
          f.calls.some((c) => c.path === "/webapi"),
          expectSms,
          onTimeout,
        );
      }
    });

    test("simulation follows delivered, or failed with “E se não for entregue”", async () => {
      const [c] = await sql!`select customer_id from crm.customers limit 1`;
      const sim = (events: string[]) =>
        call("crm_simulate_flow", {
          p_customer_id: c!["customer_id"],
          p_graph: graph(),
          p_events: events,
        });
      const ok = await sim([]);
      assert.deepEqual(
        ok.path.map((s: any) => `${s.node_id}:${s.outcome}`),
        ["start:next", "rcs:next", "wd:delivered", "ok:next"],
      );
      const ko = await sim(["DELIVERY_FAILED"]);
      assert.deepEqual(
        ko.path.map((s: any) => `${s.node_id}:${s.outcome}`),
        ["start:next", "rcs:next", "wd:failed", "sms:next"],
      );
    });
  },
);
