/** E-mail status from the Resend API for e-mails the webhook did not report. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { syncResendStatus } from "../../src/server/crm/resend-sync.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });

const asked: string[] = [];
const LAST: Record<string, string> = {
  re_a: "opened",
  re_b: "clicked",
  re_c: "delivered",
  re_d: "sent",
};
const fakeResend = (async (url: string) => {
  const id = decodeURIComponent(url.split("/emails/")[1] ?? "");
  asked.push(id);
  return new Response(JSON.stringify({ id, last_event: LAST[id] }), { status: 200 });
}) as unknown as typeof fetch;
const cfg = { apiKey: "k", from: "c@kakauma.com.br", fetchImpl: fakeResend };

describe("Resend status sync", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.provider_events where provider = 'resend'`;
    const [c] =
      await sql!`insert into crm.customers (full_name, email) values ('Sync', 'sync@example.com') returning customer_id`;
    for (const [id, daysAgo] of [
      ["re_a", 1],
      ["re_b", 2],
      ["re_c", 3],
      ["re_d", 1],
      ["re_old", 30],
    ] as const)
      await sql!`insert into crm.messages (customer_id, channel, status, executed_at, result)
                 values (${c!["customer_id"]}, 'email', 'SENT', now() - make_interval(days => ${daysAgo}),
                         ${sql!.json({ provider: "resend", response: { id } })})`;
  });
  after(async () => {
    await sql?.end();
  });

  test("recent e-mails get their last state once; old ones are left alone", async () => {
    const r = await syncResendStatus(rpc, cfg, 20, 0);
    assert.deepEqual(r, { checked: 4, updated: 3 });
    assert.deepEqual(asked.sort(), ["re_a", "re_b", "re_c", "re_d"]); // not the 30-day-old one
    const rows =
      await sql!`select result #>> '{response,id}' as id, provider_status, opened_at is not null as opened,
                                   clicked_at is not null as clicked, delivered_at is not null as delivered
                              from crm.messages where channel = 'email' order by 1`;
    const by = Object.fromEntries(
      rows.map((x) => [x["id"], [x["provider_status"], x["delivered"], x["opened"], x["clicked"]]]),
    );
    assert.deepEqual(by["re_a"], ["Opened", true, true, false]);
    assert.deepEqual(by["re_b"], ["Clicked", true, true, true]);
    assert.deepEqual(by["re_c"], ["Delivered", true, false, false]);
    assert.deepEqual(by["re_d"], [null, false, false, false]);
    // checked a moment ago: nothing is asked again in the next run
    asked.length = 0;
    assert.deepEqual(await syncResendStatus(rpc, cfg, 20, 0), { checked: 0, updated: 0 });
  });
});
