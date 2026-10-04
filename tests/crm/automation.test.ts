/** Phase 3: segmentation + automation engine (no real channel → DRY_RUN; webhook connector mocked). */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { renderTemplate, runAutomations } from "../../src/server/crm/automation.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const send = async (p: unknown) => {
  const r = await ingestWebhook(rpc, "b4you", JSON.stringify(p));
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
let n = 0;
const person = (name: string) => ({
  id: `cus_${name}`,
  full_name: `${name} Teste`,
  email: `${name.toLowerCase()}@example.com`,
  whatsapp: `1198${String(++n).padStart(7, "0")}`,
  address: { city: "São Paulo", state: "SP" },
});
const cid = async (name: string) =>
  (
    await sql!`select customer_id from crm.customers where external_customer_id = ${"cus_" + name}`
  )[0]!["customer_id"] as string;
const runs = async (name: string) =>
  sql!`select a.key, r.status, r.skip_reason, r.rendered_message, r.scheduled_for
         from crm.automation_runs r join crm.automations a using (automation_id)
        where r.customer_id = ${await cid(name)} order by r.created_at, a.key`;
const makeDue = () =>
  sql!`update crm.automation_runs set scheduled_for = now() where status = 'QUEUED'`;
const segments = async (name: string) =>
  (
    await sql!`select s.key from crm.segment_members m join crm.segments s using (segment_id) where m.customer_id = ${await cid(name)} order by 1`
  ).map((r) => r["key"] as string);

describe(
  "CRM segmentation + automation (phase 3)",
  { skip: !sql && "CRM_TEST_DATABASE_URL not set" },
  () => {
    before(async () => {
      await resetCrm(sql!);
      await sql!`update crm.automations set active = true`;
      await sql!`delete from crm.segments where not is_system`;
      await sql!`update crm.settings set value = '3' where key = 'max_actions_per_customer_per_day'`;
    });
    after(() => sql?.end());

    test("templates render customer fields and pt-BR numbers", () => {
      assert.equal(
        renderTemplate("Oi {{first_name}}, LTV {{net_ltv}} {{missing}}!", {
          first_name: "Ana",
          net_ltv: "1234.5",
        }),
        "Oi Ana, LTV 1.234,5 !",
      );
    });

    test("segments follow customer state and emit ENTERED facts", async () => {
      const p = person("Ana");
      await send(
        b4("abandoned-cart", {
          customer: p,
          updated_at: ago(0),
          tracking_parameters: { utm_source: "Facebook" },
        }),
      );
      assert.deepEqual(await segments("Ana"), ["acq_facebook"]);

      await send(
        b4("approved-payment", {
          customer: p,
          sale_id: "SA1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CA1", amount: 600 }],
        }),
      );
      assert.deepEqual(await segments("Ana"), [
        "acq_facebook",
        "behavior_one_time",
        "customer_active",
        "customer_new",
        "product_one_shot",
        "value_high",
      ]);
      const facts =
        await sql!`select data->>'segment' s from crm.customer_events where fact_type = 'SEGMENT_ENTERED' and customer_id = ${await cid("Ana")}`;
      assert.ok(facts.some((f) => f["s"] === "value_high"));
    });

    test("rules are validated; custom segments are built on save", async () => {
      await assert.rejects(
        sql!`select public.crm_upsert_segment('bad', 'Bad', '{"field":"senha","op":"=","value":1}'::jsonb)`,
        /unknown rule field "senha"/,
      );
      const r =
        await sql!`select public.crm_upsert_segment('sp_high', 'SP alto valor', '{"all":[{"field":"value_tier","op":"=","value":"high"},{"field":"state","op":"=","value":"SP"}]}'::jsonb)`;
      assert.equal(Number(r[0]!["crm_upsert_segment"]), 1); // Ana (fixture address is SP)
    });

    test("abandoned cart: queued with delay; skipped if the customer buys first", async () => {
      const p = person("Bia");
      await send(b4("abandoned-cart", { customer: p, updated_at: ago(0) }));
      let r = await runs("Bia");
      assert.equal(r[0]!["key"], "checkout_recovery");
      assert.equal(r[0]!["status"], "QUEUED");
      assert.ok(new Date(r[0]!["scheduled_for"] as string).getTime() > Date.now() + 50 * 60_000);

      await send(
        b4("approved-payment", {
          customer: p,
          sale_id: "SB1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CB1", amount: 100 }],
        }),
      );
      await makeDue();
      await runAutomations(rpc);
      r = await runs("Bia");
      const byKey = Object.fromEntries(r.map((x) => [x["key"], x]));
      assert.equal(byKey["checkout_recovery"]!["status"], "SKIPPED");
      assert.equal(byKey["checkout_recovery"]!["skip_reason"], "conditions_not_met");
      assert.equal(byKey["onboarding_purchase"]!["status"], "DRY_RUN");
      assert.match(
        String(byKey["onboarding_purchase"]!["rendered_message"]),
        /^Oi Bia! Seu pedido foi confirmado/,
      );
    });

    test("abandoned cart still open → DRY_RUN message; cooldown blocks a repeat", async () => {
      const p = person("Caio");
      await send(b4("abandoned-cart", { customer: p, updated_at: ago(0), offer: { id: "off_1" } }));
      await makeDue();
      await runAutomations(rpc);
      await send(
        b4("abandoned-cart", {
          customer: p,
          updated_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
          offer: { id: "off_2" },
        }),
      );
      await makeDue();
      await runAutomations(rpc);
      const r = await runs("Caio");
      assert.deepEqual(
        r.map((x) => `${x["status"]}:${x["skip_reason"] ?? ""}`),
        ["DRY_RUN:", "SKIPPED:cooldown"],
      );
      assert.match(String(r[0]!["rendered_message"]), /Oi Caio, vi que você não finalizou/);
    });

    test("old facts (e.g. backfill) never trigger actions", async () => {
      await send(b4("abandoned-cart", { customer: person("Dani"), updated_at: ago(10) }));
      assert.equal((await runs("Dani")).length, 0);
    });

    test("late payment: high value goes to the team, others get the recovery message", async () => {
      const hv = person("Edu");
      const sub = (id: string) => ({ id, status: "active", next_charge: ago(-20) });
      await send(
        b4("approved-payment", {
          customer: hv,
          sale_id: "SE1",
          payment_method: "card",
          paid_at: ago(40),
          charges: [{ id: "CE1", amount: 300 }],
          subscription: sub("SUB-E"),
        }),
      );
      await send(
        b4("renewed-subscription", {
          customer: hv,
          sale_id: "SE2",
          payment_method: "card",
          paid_at: ago(10),
          charges: [{ id: "CE2", amount: 300 }],
          subscription: sub("SUB-E"),
        }),
      );
      await send(
        b4("late-subscription", { customer: hv, updated_at: ago(0), subscription: sub("SUB-E") }),
      );

      const lv = person("Fabi");
      await send(
        b4("approved-payment", {
          customer: lv,
          sale_id: "SF1",
          payment_method: "card",
          paid_at: ago(40),
          charges: [{ id: "CF1", amount: 90 }],
          subscription: sub("SUB-F"),
        }),
      );
      await send(
        b4("late-subscription", { customer: lv, updated_at: ago(0), subscription: sub("SUB-F") }),
      );

      await makeDue();
      await runAutomations(rpc);
      const edu = (await runs("Edu")).filter((x) => x["status"] !== "SKIPPED").map((x) => x["key"]);
      assert.ok(edu.includes("high_value_recovery"));
      assert.ok(edu.includes("high_value_risk_alert"));
      assert.ok(!edu.includes("payment_recovery"));
      const fabi = (await runs("Fabi"))
        .filter((x) => x["status"] !== "SKIPPED")
        .map((x) => x["key"]);
      assert.ok(fabi.includes("payment_recovery"));
      assert.ok(!fabi.includes("high_value_recovery"));
    });

    test("cancellation request: cycle ≥ 3 gets the retention offer", async () => {
      const p = person("Gui");
      const sub = { id: "SUB-G", status: "active", next_charge: ago(-20) };
      for (let i = 0; i < 3; i++) {
        await send(
          b4(i ? "renewed-subscription" : "approved-payment", {
            customer: p,
            sale_id: `SG${i}`,
            payment_method: "pix",
            paid_at: ago(90 - i * 30),
            charges: [{ id: `CG${i}`, amount: 50 }],
            subscription: sub,
          }),
        );
      }
      await send(
        b4("canceled-subscription", { customer: p, updated_at: ago(0), subscription: sub }),
      );
      await makeDue();
      await runAutomations(rpc);
      const r = (await runs("Gui")).filter(
        (x) => x["key"] !== "loyalty_renewed" && x["key"] !== "onboarding_purchase",
      );
      const byKey = Object.fromEntries(r.map((x) => [x["key"], x]));
      assert.equal(byKey["retention_offer"]!["status"], "DRY_RUN");
      assert.match(String(byKey["retention_offer"]!["rendered_message"]), /há 3 ciclos/);
      assert.equal(byKey["retention_journey"]!["skip_reason"], "conditions_not_met");
    });

    test("daily cap limits actions per customer", async () => {
      await sql!`update crm.settings set value = '1' where key = 'max_actions_per_customer_per_day'`;
      const p = person("Hel");
      await send(
        b4("approved-payment", {
          customer: p,
          sale_id: "SH1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CH1", amount: 40 }],
        }),
      );
      await send(
        b4("tracking", {
          customer: p,
          sale_id: "SH1",
          updated_at: ago(0),
          tracking: { code: "TH1", status: "delivered" },
        }),
      );
      await makeDue();
      await runAutomations(rpc);
      const r = await runs("Hel");
      assert.deepEqual(r.map((x) => x["skip_reason"] ?? x["status"]).sort(), [
        "DRY_RUN",
        "daily_cap",
      ]);
      await sql!`update crm.settings set value = '3' where key = 'max_actions_per_customer_per_day'`;
    });

    test("webhook connector: signed POST → SENT; failure → retried later", async () => {
      const p = person("Ivo");
      await send(
        b4("approved-payment", {
          customer: p,
          sale_id: "SI1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CI1", amount: 70 }],
        }),
      );
      await makeDue();
      const calls: { body: string; sig: string | null }[] = [];
      const okFetch = (async (_url: string, init: RequestInit) => {
        calls.push({
          body: String(init.body),
          sig: (init.headers as Record<string, string>)["x-kakauma-signature"] ?? null,
        });
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch;
      const res = await runAutomations(rpc, {
        webhookUrl: "https://hooks.example/crm",
        webhookSecret: "s3cret",
        fetchImpl: okFetch,
      });
      assert.equal(res.results.find((x) => x.automation === "onboarding_purchase")?.status, "SENT");
      const sent = JSON.parse(calls[0]!.body);
      assert.equal(sent.to.whatsapp, p.whatsapp);
      assert.equal(
        calls[0]!.sig,
        `sha256=${createHmac("sha256", "s3cret").update(calls[0]!.body).digest("hex")}`,
      );

      const q = person("Juca");
      await send(
        b4("approved-payment", {
          customer: q,
          sale_id: "SJ1",
          payment_method: "pix",
          paid_at: ago(0),
          charges: [{ id: "CJ1", amount: 70 }],
        }),
      );
      await makeDue();
      const badFetch = (async () =>
        new Response("down", { status: 503 })) as unknown as typeof fetch;
      const res2 = await runAutomations(rpc, {
        webhookUrl: "https://hooks.example/crm",
        fetchImpl: badFetch,
      });
      assert.equal(res2.results[0]?.status, "QUEUED");
      const r = await runs("Juca");
      assert.ok(new Date(r[0]!["scheduled_for"] as string).getTime() > Date.now());
    });

    test("deactivated automation: no new runs and queued ones are skipped", async () => {
      const p = person("Kel");
      await send(b4("abandoned-cart", { customer: p, updated_at: ago(0) }));
      await sql!`select public.crm_set_automation_active('checkout_recovery', false)`;
      await send(
        b4("abandoned-cart", {
          customer: p,
          updated_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
          offer: { id: "off_9" },
        }),
      );
      await makeDue();
      await runAutomations(rpc);
      const r = await runs("Kel");
      assert.deepEqual(
        r.map((x) => `${x["key"]}:${x["skip_reason"]}`),
        ["checkout_recovery:automation_inactive"],
      );
      await sql!`select public.crm_set_automation_active('checkout_recovery', true)`;
    });

    test("Customer 360 lists segments, automations and communications", async () => {
      const c = (await rpc("crm_customer_360", { p_customer_id: await cid("Bia") })).data as Record<
        string,
        any
      >;
      assert.ok(c["crm"]["segments"].some((s: { key: string }) => s.key === "behavior_one_time"));
      assert.ok(
        c["crm"]["automations"].some(
          (a: { automation: string }) => a.automation === "checkout_recovery",
        ),
      );
      assert.equal(c["crm"]["communications"][0]["automation"], "onboarding_purchase");
      const stats = (await rpc("crm_list_automations", {})).data as {
        key: string;
        dry_run: number;
      }[];
      assert.ok(Number(stats.find((s) => s.key === "onboarding_purchase")!.dry_run) >= 1);
    });
  },
);
