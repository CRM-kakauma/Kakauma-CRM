/** Resend webhooks: signature, delivered / opened / clicked / spam, and the results dashboard. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import { verifySvix } from "../../src/server/crm/svix.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const SECRET = `whsec_${Buffer.from("segredo-de-teste-123").toString("base64")}`;
const sign = (id: string, ts: string, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64")}`;

describe("Resend webhook signature (Svix)", () => {
  const now = Math.floor(Date.now() / 1000);
  const body = '{"type":"email.opened"}';
  test("a correct signature passes; a changed body, old time or other secret do not", () => {
    const ts = String(now);
    const h = { id: "msg_1", timestamp: ts, signature: `v1,xxx ${sign("msg_1", ts, body)}` };
    assert.equal(verifySvix(SECRET, h, body, now), true);
    assert.equal(verifySvix(SECRET, h, body + " ", now), false);
    assert.equal(verifySvix(SECRET, { ...h, timestamp: String(now - 600) }, body, now), false);
    assert.equal(
      verifySvix(`whsec_${Buffer.from("outro").toString("base64")}`, h, body, now),
      false,
    );
    assert.equal(verifySvix(SECRET, { ...h, signature: null }, body, now), false);
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
let sentBody: { tags?: { name: string; value: string }[] } = {};
const fakeResend = (async (_url: string, init: RequestInit = {}) => {
  sentBody = JSON.parse(String(init.body ?? "{}"));
  return new Response(JSON.stringify({ id: "re_email_123" }), { status: 200 });
}) as unknown as typeof fetch;

describe("Resend events in the CRM", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.short_links`; // manual short links of other tests
    await sql!`delete from crm.provider_events where provider = 'resend'`;
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'rw_%')`;
    await sql!`delete from crm.flows where key like 'rw_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_upsert_template", {
      p_key: "rw_mail",
      p_name: "Boas vindas",
      p_channel: "email",
      p_purpose: "transactional",
      p_content: {
        subject: "Oi",
        format: "html",
        html: '<a href="https://kakauma.com.br/">Loja</a>',
        blocks: [],
      },
    });
    await call("crm_save_flow", {
      p_key: "rw_flow",
      p_name: "Compra aprovada",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "rw_mail" } },
        ],
        edges: [{ source: "start", target: "m", handle: "next" }],
      },
    });
    assert.equal(await call("crm_publish_flow", { p_key: "rw_flow" }), 1);
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'rw_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("delivered, opened and clicked reach the message and Resultados; spam opts out", async () => {
    const now = new Date().toISOString();
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: { id: "cus_rw", full_name: "Rui W", email: "rui@example.com" },
          sale_id: "RW-1",
          payment_method: "pix",
          created_at: now,
          updated_at: now,
          paid_at: now,
          charges: [{ id: "CRW", amount: 50 }],
        }),
      ),
    );
    await runFlows(rpc, {
      resend: { apiKey: "k", from: "c@kakauma.com.br", live: true, fetchImpl: fakeResend },
    });
    const [m] =
      await sql!`select message_id, status from crm.messages where template_key = 'rw_mail'`;
    assert.equal(m!["status"], "SENT");
    // the e-mail carries its message id as a tag
    assert.deepEqual(sentBody.tags, [{ name: "message_id", value: m!["message_id"] }]);

    const ev = (type: string, id: string, data: Record<string, unknown> = {}) =>
      call<{ message_matched: boolean; status?: string; duplicate?: boolean }>("crm_resend_event", {
        p_event_id: id,
        p_payload: {
          type,
          created_at: new Date().toISOString(),
          data: { email_id: "re_email_123", ...data },
        },
      });
    assert.equal((await ev("email.delivered", "e1")).status, "Delivered");
    assert.equal((await ev("email.opened", "e2")).status, "Opened");
    // found by the tag too
    assert.equal(
      (await ev("email.clicked", "e3", { email_id: "x", tags: { message_id: m!["message_id"] } }))
        .status,
      "Clicked",
    );
    assert.equal((await ev("email.opened", "e3")).duplicate, true); // same Svix id: ignored
    await ev("email.opened", "e4"); // a later open does not hide the click
    const [row] =
      await sql!`select provider_status, delivered_at, opened_at, clicked_at from crm.messages where message_id = ${m!["message_id"]}`;
    assert.equal(row!["provider_status"], "Clicked");
    assert.ok(row!["delivered_at"] && row!["opened_at"] && row!["clicked_at"]);

    const r = await call<{
      totals: { delivered: number; opens: number; clicks: number };
      by_flow: { campaign: string; opens: number }[];
    }>("crm_results", {
      p_from: new Date(Date.now() - 86_400_000).toISOString(),
      p_to: new Date(Date.now() + 60_000).toISOString(),
      p_window_days: 7,
    });
    assert.deepEqual([r.totals.delivered, r.totals.opens, r.totals.clicks], [1, 1, 1]);
    assert.equal(r.by_flow.find((f) => f.campaign === "compra_aprovada")?.opens, 1);

    await ev("email.complained", "e5");
    const [o] =
      await sql!`select channel, source from crm.channel_optouts o join crm.customers c using (customer_id)
                            where c.email = 'rui@example.com'`;
    assert.deepEqual([o?.["channel"], o?.["source"]], ["email", "resend: marcado como spam"]);
    // unknown e-mails are accepted and ignored
    assert.equal(
      (await ev("email.opened", "e6", { email_id: "nao-existe" })).message_matched,
      false,
    );
  });
});
