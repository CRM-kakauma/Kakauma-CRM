/** Pushfy webhook batches: thousands of reports saved in a few database calls; repeats ignored. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { savePushfyEvents } from "../../src/server/crm/pushfy.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const base: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
/** counts database calls per function */
const counting = () => {
  const calls: Record<string, number> = {};
  const rpc: Rpc = (fn, args) => {
    calls[fn] = (calls[fn] ?? 0) + 1;
    return base(fn, args);
  };
  return { rpc, calls };
};
const report = (i: number) => ({
  id: 900000 + i,
  phone: `55119${String(i).padStart(8, "0")}`,
  status: "Delivered",
  ext_id: `not-a-message-${i}`,
  date_dlr: "2026-11-03 12:00:00",
});

describe("Pushfy webhook batches", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.provider_events where provider = 'pushfy'`;
  });
  after(async () => {
    await sql?.end();
  });

  test("1,200 reports in 3 calls; the same batch again is all duplicates", async () => {
    const batch = Array.from({ length: 1200 }, (_, i) => report(i));
    const c = counting();
    const r = await savePushfyEvents(c.rpc, batch);
    assert.deepEqual(r, { saved: 1200, matched: 0 });
    assert.deepEqual(c.calls, { crm_pushfy_events: 3 });
    const [n] =
      await sql!`select count(*)::int as n from crm.provider_events where provider = 'pushfy'`;
    assert.equal(n!["n"], 1200);
    const again = await base("crm_pushfy_events", { p_payloads: batch.slice(0, 10) });
    assert.equal((again.data as { duplicates: number }).duplicates, 10);
  });

  test("without the database update: one call per report, as before", async () => {
    const calls: Record<string, number> = {};
    const old: Rpc = (fn, args) => {
      calls[fn] = (calls[fn] ?? 0) + 1;
      if (fn === "crm_pushfy_events")
        return Promise.resolve({
          data: null,
          error: {
            message: "function public.crm_pushfy_events(p_payloads => jsonb) does not exist",
          },
        });
      return base(fn, args);
    };
    const r = await savePushfyEvents(old, [report(5000), report(5001)]);
    assert.deepEqual(r, { saved: 2, matched: 0 });
    assert.deepEqual(calls, { crm_pushfy_events: 1, crm_pushfy_event: 2 });
  });

  test("other database errors are not hidden (Pushfy retries later)", async () => {
    const broken: Rpc = () =>
      Promise.resolve({ data: null, error: { message: "connection refused" } });
    await assert.rejects(savePushfyEvents(broken, [report(1)]), /connection refused/);
  });
});
