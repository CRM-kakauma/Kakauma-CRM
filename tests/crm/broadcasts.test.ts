/** Disparos: scheduled flows for a segment (once / daily; once in life / once per journey). */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
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
const GRAPH = {
  nodes: [
    { id: "start", type: "trigger", config: {} },
    { id: "w", type: "wait", config: { amount: 1, unit: "days" } },
  ],
  edges: [{ source: "start", target: "w", handle: "next" }],
};
type Run = { audience: number; enrolled: number; already_received: number; still_in_flow: number };
const due = async (key: string, ago = "1 minute") => {
  await sql!`update crm.flows set next_run_at = now() - ${ago}::interval where key = ${key}`;
  return (await call("crm_run_due_broadcasts")) as (Run & { flow: string; missed?: string })[];
};
const entries = async (key: string) =>
  (
    await sql!`select count(*)::int as n from crm.flow_enrollments e join crm.flows f using (flow_id) where f.key = ${key}`
  )[0]!["n"];

describe("Disparos", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  let ana = "";
  let bia = "";
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'bc_%')`;
    await sql!`delete from crm.flows where key like 'bc_%'`;
    await sql!`delete from crm.segments where key = 'bc_seg'`;
    await sql!`insert into crm.segments (key, name, kind, definition) values ('bc_seg', 'Seg disparo', 'manual', '{}')`;
    const add = async (name: string) =>
      String(
        (
          await sql!`insert into crm.customers (full_name, email) values (${name}, ${name + "@example.com"}) returning customer_id`
        )[0]!["customer_id"],
      );
    ana = await add("ana");
    bia = await add("bia");
    await sql!`insert into crm.segment_members (segment_id, customer_id)
               select segment_id, c from crm.segments, unnest(${[ana, bia]}::uuid[]) c where key = 'bc_seg'`;
    for (const k of ["bc_once", "bc_journey"]) {
      await call("crm_save_flow", {
        p_key: k,
        p_name: k,
        p_trigger_fact: "BROADCAST",
        p_graph: GRAPH,
      });
      await call("crm_publish_flow", { p_key: k });
    }
    await call("crm_save_flow", {
      p_key: "bc_jornada",
      p_name: "Jornada",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: GRAPH,
    });
    await call("crm_publish_flow", { p_key: "bc_jornada" });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'bc_%'`;
    await sql?.end();
  });

  test("schedule: once at a date, every day, some weekdays", async () => {
    const next = async (schedule: object, after: string) =>
      (
        await sql!`select crm.broadcast_next_run(${sql!.json(schedule as never)}, ${after}::timestamptz) as t`
      )[0]!["t"] as Date | null;
    // Brasília is UTC-3
    assert.equal(
      (await next({ mode: "once", at: "2026-12-01T10:00" }, "2026-11-30T00:00Z"))!.toISOString(),
      "2026-12-01T13:00:00.000Z",
    );
    assert.equal(await next({ mode: "once", at: "2026-12-01T10:00" }, "2026-12-02T00:00Z"), null);
    assert.equal(
      (await next({ mode: "daily", time: "09:30" }, "2026-11-24T13:00Z"))!.toISOString(),
      "2026-11-25T12:30:00.000Z",
    );
    // 2026-11-24 is a Tuesday (2); only Fridays (5)
    assert.equal(
      (await next({ mode: "daily", time: "09:30", days: [5] }, "2026-11-24T13:00Z"))!.toISOString(),
      "2026-11-27T12:30:00.000Z",
    );
  });

  test("once in life: the segment enters once, never again", async () => {
    const r = (await call("crm_set_broadcast", {
      p_key: "bc_once",
      p_segment: "bc_seg",
      p_schedule: { mode: "daily", time: "10:00" },
      p_audience: "once_ever",
    })) as { next_run_at: string };
    assert.ok(r.next_run_at);
    const [first] = await due("bc_once");
    assert.deepEqual([first!.audience, first!.enrolled], [2, 2]);
    assert.equal(await entries("bc_once"), 2);
    await sql!`update crm.flow_enrollments set status = 'COMPLETED', finished_at = now()
                where flow_id = (select flow_id from crm.flows where key = 'bc_once')`;
    const [second] = await due("bc_once");
    assert.deepEqual([second!.enrolled, second!.already_received], [0, 2]);
    const [n] = await sql!`select next_run_at from crm.flows where key = 'bc_once'`;
    assert.ok((n!["next_run_at"] as Date).getTime() > Date.now(), "next day scheduled");
  });

  test("once per journey: again only after starting a new journey", async () => {
    await call("crm_set_broadcast", {
      p_key: "bc_journey",
      p_segment: "bc_seg",
      p_schedule: { mode: "daily", time: "10:00" },
      p_audience: "once_per_journey",
    });
    await due("bc_journey");
    assert.equal(await entries("bc_journey"), 2);
    await sql!`update crm.flow_enrollments set status = 'COMPLETED', finished_at = now()
                where flow_id = (select flow_id from crm.flows where key = 'bc_journey')`;
    let [r] = await due("bc_journey");
    assert.equal(r!.enrolled, 0, "same journey: not again");
    // Ana starts a new journey
    await sql!`insert into crm.flow_enrollments (flow_id, version, customer_id, current_node)
               select flow_id, version, ${ana}, 'start' from crm.flows where key = 'bc_jornada'`;
    [r] = await due("bc_journey");
    assert.deepEqual([r!.enrolled, r!.already_received], [1, 1]);
  });

  test("a run too late is not fired; a once disparo stops", async () => {
    await call("crm_save_flow", {
      p_key: "bc_late",
      p_name: "Atrasado",
      p_trigger_fact: "BROADCAST",
      p_graph: GRAPH,
    });
    await call("crm_publish_flow", { p_key: "bc_late" });
    await call("crm_set_broadcast", {
      p_key: "bc_late",
      p_segment: "bc_seg",
      p_schedule: { mode: "once", at: "2030-01-01T10:00" },
      p_audience: "once_ever",
    });
    // the platform was down: the date (5 hours ago) passed without the run
    await sql!`update crm.flows set broadcast = jsonb_set(broadcast, '{schedule,at}',
                 to_jsonb(to_char((now() - interval '5 hours') at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI')))
                where key = 'bc_late'`;
    const [r] = await due("bc_late", "5 hours");
    assert.ok(r!.missed);
    assert.equal(await entries("bc_late"), 0);
    const [n] = await sql!`select next_run_at from crm.flows where key = 'bc_late'`;
    assert.equal(n!["next_run_at"], null);
  });

  test("a journey does not become a disparo; disparar agora", async () => {
    const { error } = await rpc("crm_save_flow", {
      p_key: "bc_jornada",
      p_name: "Jornada",
      p_trigger_fact: "BROADCAST",
      p_graph: GRAPH,
    });
    assert.match(error!.message, /não vira disparo/);
    const { error: e2 } = await rpc("crm_set_broadcast", {
      p_key: "bc_once",
      p_segment: "nao_existe",
      p_schedule: { mode: "daily", time: "10:00" },
      p_audience: "once_ever",
    });
    assert.match(e2!.message, /segmento/);
    const now = (await call("crm_run_broadcast_now", { p_key: "bc_once" })) as Run;
    assert.equal(now.already_received, 2);
    const runs = (await call("crm_broadcast_runs", { p_key: "bc_once" })) as { manual: boolean }[];
    assert.equal(runs[0]!.manual, true);
    const list = (await call("crm_list_flows")) as { key: string; segment_name: string | null }[];
    assert.equal(list.find((f) => f.key === "bc_once")!.segment_name, "Seg disparo");
  });
});
