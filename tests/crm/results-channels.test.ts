/** Resultados → Por canal: the channel that actually went out, deliveries at the operator's time. */
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
type Row = { channel: string; sent: number; delivered: number };

describe("Resultados por canal", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  let customer = "";
  const msg = async (channel: string, opts: { sentAs?: string; sentAgo?: string } = {}) => {
    const [m] = await sql!`
      insert into crm.messages (customer_id, channel, template_key, status, executed_at, result)
      values (${customer}, ${channel}, 'rc_tpl', 'SENT', now() - ${opts.sentAgo ?? "1 hour"}::interval,
              ${sql!.json(opts.sentAs ? { sent_as: opts.sentAs } : {})})
      returning message_id`;
    return String(m!["message_id"]);
  };
  const dlr = (id: string, status: string, date: string) =>
    call("crm_pushfy_event", {
      p_payload: { id: Math.floor(Math.random() * 1e9), ext_id: id, status, date_dlr: date },
    });
  const byChannel = async (from: string, to: string) => {
    const r = (await call("crm_results", { p_from: from, p_to: to, p_window_days: 7 })) as {
      by_channel: Row[];
    };
    return Object.fromEntries(r.by_channel.map((c) => [c.channel, [c.sent, c.delivered]]));
  };
  const brt = (d: Date) =>
    new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 19).replace("T", " ");

  before(async () => {
    await resetCrm(sql!);
    const [c] =
      await sql!`insert into crm.customers (full_name, phone) values ('Rita', '11999990000')
                            returning customer_id`;
    customer = String(c!["customer_id"]);
  });
  after(async () => {
    await sql?.end();
  });

  test("RCS replaced by its SMS counts as SMS; delivered never passes sent", async () => {
    const now = new Date();
    const rcs = await msg("rcs");
    const rcsAsSms = await msg("rcs", { sentAs: "sms_fallback" });
    const sms = await msg("sms");
    const old = await msg("sms", { sentAgo: "3 days" }); // sent before the period
    await dlr(rcs, "Delivered", brt(now));
    await dlr(rcsAsSms, "Delivered", brt(now));
    await dlr(sms, "DELIVERED", brt(now)); // any case
    await dlr(old, "Delivered", brt(now)); // delivered inside the period, sent before it

    const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const to = new Date(now.getTime() + 3600_000).toISOString();
    assert.deepEqual(await byChannel(from, to), { rcs: [1, 1], sms: [2, 2] });
  });

  test("delivery at the operator's time (date_dlr), not when the report arrived", async () => {
    const id = await msg("sms", { sentAgo: "2 days" });
    const deliveredAt = new Date(Date.now() - 47 * 3600_000); // an hour after the send
    await dlr(id, "Delivered", brt(deliveredAt));
    const [m] = await sql!`select delivered_at from crm.messages where message_id = ${id}`;
    const got = (m!["delivered_at"] as Date).getTime();
    assert.ok(Math.abs(got - deliveredAt.getTime()) < 2000, `${new Date(got).toISOString()}`);
  });

  test("a report dated before the send is kept at the send time", async () => {
    const id = await msg("rcs", { sentAgo: "10 minutes" });
    await dlr(id, "Read", "2020-01-01 00:00:00");
    const [m] =
      await sql!`select delivered_at, executed_at from crm.messages where message_id = ${id}`;
    assert.equal((m!["delivered_at"] as Date).getTime(), (m!["executed_at"] as Date).getTime());
  });
});
