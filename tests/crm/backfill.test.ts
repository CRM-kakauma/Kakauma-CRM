/** History import (old webhooks from a file): same processing, original arrival time, no messages. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, processPending, type Rpc } from "../../src/server/crm/pipeline.ts";
import { importBackfill, parseBackfillLine } from "../../src/server/crm/backfill.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

describe("history file lines", () => {
  test("bare payload or { received_at, payload }; blank lines skipped", () => {
    assert.deepEqual(parseBackfillLine('{"event_name":"refund"}'), {
      payload: { event_name: "refund" },
    });
    assert.deepEqual(
      parseBackfillLine('{"received_at":"2026-08-09T18:03:31Z","payload":{"event_name":"x"}}'),
      { payload: { event_name: "x" }, received_at: "2026-08-09T18:03:31Z" },
    );
    assert.equal(parseBackfillLine("   "), null);
    assert.throws(() => parseBackfillLine("{oops"));
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async <T = unknown>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const enrolled = async () =>
  Number(
    (
      await sql!`select count(*) as n from crm.flow_enrollments e join crm.flows f using (flow_id)
                  where f.key = 'bf_flow'`
    )[0]!["n"],
  );

describe("History import", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'bf_%')`;
    await sql!`delete from crm.flows where key like 'bf_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = true, max_trigger_age_hours = 100000`;
    // a flow that would take purchases up to ~10 years old
    await call("crm_save_flow", {
      p_key: "bf_flow",
      p_name: "Compra aprovada",
      p_trigger_fact: "PURCHASE_PAID",
      p_max_trigger_age_hours: 87600,
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "w", type: "wait", config: { amount: 1, unit: "days" } },
        ],
        edges: [{ source: "start", target: "w", handle: "next" }],
      },
    });
    await call("crm_publish_flow", { p_key: "bf_flow" });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'bf_%'`;
    await sql!`update crm.automations set max_trigger_age_hours = 72`;
    await sql?.end();
  });

  const old = (sale: string, at: string) =>
    b4("approved-payment", {
      customer: { id: `cus_${sale}`, full_name: "Bia F", email: `${sale}@example.com` },
      sale_id: sale,
      payment_method: "pix",
      created_at: at,
      updated_at: at,
      paid_at: at,
      charges: [{ id: `CH-${sale}`, amount: 100 }],
      card_details: { number: "4111111111111111", cvv: "123" },
    });

  test("imported with its original time; no flow, automation or message; card data removed", async () => {
    const r = await importBackfill(rpc, "b4you", [
      { payload: old("BF1", "2026-08-10T12:00:00Z"), received_at: "2026-08-10T12:00:05Z" },
      { payload: old("BF2", "2026-08-11T12:00:00Z") }, // no arrival time: the payload's own
    ]);
    assert.deepEqual(r.counts, { importado: 2 });
    const ev =
      await sql!`select sale_id, received_at, payload::text as p from crm.events order by received_at`;
    assert.equal(ev[0]!["received_at"].toISOString(), "2026-08-10T12:00:05.000Z");
    assert.equal(ev[1]!["received_at"].toISOString(), "2026-08-11T12:00:00.000Z");
    assert.ok(!String(ev[0]!["p"]).includes("4111111111111111"));
    const [paid] = await sql!`select count(*)::int as n from crm.orders where status = 'PAID'`;
    assert.equal(paid!["n"], 2);
    assert.equal(await enrolled(), 0);
    const [runs] = await sql!`select (select count(*)::int from crm.automation_runs) as runs,
                                     (select count(*)::int from crm.messages) as msgs`;
    assert.deepEqual([runs!["runs"], runs!["msgs"]], [0, 0]);
  });

  test("an import interrupted mid-event: the worker finishes it, still without flows", async () => {
    // stored by the import, then the call died before processing (platform time limit)
    await call("crm_ingest_backfill", {
      p_source: "b4you",
      p_event_name: "approved-payment",
      p_source_event_id: null,
      p_payload: old("BF9", "2026-08-12T12:00:00Z"),
      p_redacted: [],
      p_received_at: "2026-08-12T12:00:01Z",
    });
    const [ev] = await sql!`select backfill, processing_status from crm.events where sale_id is null
                             and payload->>'sale_id' = 'BF9'`;
    assert.deepEqual([ev!["backfill"], ev!["processing_status"]], [true, "RECEIVED"]);
    await processPending(rpc, { limit: 10 }); // the automatic worker (no import transaction)
    const [done] =
      await sql!`select processing_status from crm.events where payload->>'sale_id' = 'BF9'`;
    assert.equal(done!["processing_status"], "PROCESSED");
    assert.equal(await enrolled(), 0);
  });

  test("importing again changes nothing", async () => {
    const r = await importBackfill(rpc, "b4you", [
      { payload: old("BF1", "2026-08-10T12:00:00Z"), received_at: "2026-08-10T12:00:05Z" },
    ]);
    assert.deepEqual(r.counts, { "já existia": 1 });
  });

  test("a live webhook after the import still starts flows (the guard does not leak)", async () => {
    const now = new Date().toISOString();
    await ingestWebhook(rpc, "b4you", JSON.stringify(old("BF3", now)));
    assert.equal(await enrolled(), 1);
  });

  test("an event the CRM does not use is kept as ignored, never retried", async () => {
    const r = await importBackfill(rpc, "b4you", [{ payload: { event_name: "algo-novo" } }], 7);
    assert.deepEqual(r.counts, { ignorado: 1 });
    const [e] = await sql!`select processing_status from crm.events where event_name = 'algo-novo'`;
    assert.equal(e!["processing_status"], "IGNORED");
  });
});
