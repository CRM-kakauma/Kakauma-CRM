import { z } from "zod";
import { EVENT_TYPES } from "@/lib/events";

export const eventPayloadSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.enum(EVENT_TYPES),
  user_id: z.string().min(1),
  transaction_id: z.string().min(1).nullable().optional(),
  subscription_id: z.string().min(1).nullable().optional(),
  product_id: z.string().nullable().optional(),
  value: z.number().nonnegative().nullable().optional(),
  net_value: z.number().nonnegative().nullable().optional(),
  affiliate_value: z.number().nonnegative().nullable().optional(),
  currency: z.string().default("BRL"),
  timestamp: z.string().datetime({ offset: true }).optional(),
  source: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  payment_method: z.string().nullable().optional(),
});


export type EventPayload = z.infer<typeof eventPayloadSchema>;

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Single ingestion path for every incoming event.
 * EVENTS are the source of truth: transactions/subscriptions/users are
 * derived from them, and event_id guarantees idempotency.
 */
export async function ingestEvent(raw: unknown): Promise<IngestResult> {
  let input = raw;
  let provider: string | null = null;

  // Accept B4you native webhooks by translating them first.
  const { isB4youPayload, mapB4youPayload } = await import("@/lib/b4you.server");
  if (isB4youPayload(raw)) {
    provider = "b4you";
    const mapped = mapB4youPayload(raw);
    if (!mapped.ok || !mapped.payload) {
      return {
        status: mapped.error === "unsupported_event_name" ? 202 : 422,
        body: { ok: true, ignored: true, provider, error: mapped.error, event_name: mapped.event_name },
      };
    }
    input = mapped.payload;
  }

  const parsed = eventPayloadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 422,
      body: { ok: false, error: "invalid_payload", provider, issues: parsed.error.issues },
    };
  }
  // Always keep the full original payload so nothing is ever lost.
  if (!("raw_payload" in parsed.data.metadata)) {
    parsed.data.metadata = { ...parsed.data.metadata, raw_payload: raw };
  }
  const p = parsed.data;

  const ts = p.timestamp ?? new Date().toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // 1. Idempotency — same event_id is never processed twice.
  const { data: existing } = await supabaseAdmin
    .from("events")
    .select("id")
    .eq("event_id", p.event_id)
    .maybeSingle();

  if (existing) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, event_id: p.event_id, id: existing.id },
    };
  }

  // 2. User — identity is unified by email first (providers may send different
  // external ids for the same person: email on cart abandon, uuid on payment).
  let user: { id: string; first_seen_at: string | null } | null = null;

  if (p.email) {
    const { data: byEmail } = await supabaseAdmin
      .from("users")
      .select("id, first_seen_at")
      .ilike("email", p.email)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (byEmail) {
      user = byEmail;
      await supabaseAdmin
        .from("users")
        .update({
          ...(p.name ? { name: p.name } : {}),
          last_seen_at: ts,
        })
        .eq("id", byEmail.id);
    }
  }

  if (!user) {
    const { data: upserted, error: userError } = await supabaseAdmin
      .from("users")
      .upsert(
        {
          external_user_id: p.user_id,
          ...(p.name ? { name: p.name } : {}),
          ...(p.email ? { email: p.email } : {}),
          first_seen_at: ts,
          last_seen_at: ts,
        },
        { onConflict: "external_user_id", ignoreDuplicates: false },
      )
      .select("id, first_seen_at")
      .single();

    if (userError || !upserted) {
      return { status: 500, body: { ok: false, error: userError?.message ?? "user_upsert_failed" } };
    }
    user = upserted;
  }

  // 3. Transaction
  let transactionUuid: string | null = null;
  if (p.transaction_id) {
    const { data: tx } = await supabaseAdmin
      .from("transactions")
      .upsert(
        {
          external_transaction_id: p.transaction_id,
          user_id: user.id,
          product_id: p.product_id ?? null,
          value: p.value ?? 0,
          currency: p.currency,
          status: "pending",
          created_at: ts,
        },
        { onConflict: "external_transaction_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (tx?.id) {
      transactionUuid = tx.id;
    } else {
      const { data: found } = await supabaseAdmin
        .from("transactions")
        .select("id")
        .eq("external_transaction_id", p.transaction_id)
        .maybeSingle();
      transactionUuid = found?.id ?? null;
    }

    if (transactionUuid) {
      const patch: Record<string, unknown> = {};
      if (p.payment_method) patch["payment_method"] = p.payment_method;
      switch (p.event_type) {

        case "PIX_GENERATED":
          patch["payment_method"] = "pix";
          break;
        case "BOLETO_GENERATED":
          patch["payment_method"] = "boleto";
          break;
        case "PURCHASE_APPROVED":
          patch["status"] = "approved";
          patch["approved_at"] = ts;
          if (p.value != null) patch["value"] = p.value;
          if (p.net_value != null) patch["net_value"] = p.net_value;
          if (p.affiliate_value != null) patch["affiliate_value"] = p.affiliate_value;
          break;
        case "PURCHASE_DECLINED":
          patch["status"] = "declined";
          break;
        case "PIX_EXPIRED":
          patch["status"] = "expired";
          break;
        case "REFUND":
          patch["status"] = "refunded";
          patch["refunded_at"] = ts;
          break;
        case "CHARGEBACK":
          patch["status"] = "chargeback";
          patch["chargeback_at"] = ts;
          break;
        default:
          break;
      }
      if (Object.keys(patch).length > 0) {
        await supabaseAdmin.from("transactions").update(patch as never).eq("id", transactionUuid);
      }
    }
  }

  // 4. Subscription
  let subscriptionUuid: string | null = null;
  if (p.subscription_id) {
    await supabaseAdmin.from("subscriptions").upsert(
      {
        external_subscription_id: p.subscription_id,
        user_id: user.id,
        product_id: p.product_id ?? null,
        status: "active",
        started_at: ts,
      },
      { onConflict: "external_subscription_id", ignoreDuplicates: true },
    );

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("id")
      .eq("external_subscription_id", p.subscription_id)
      .maybeSingle();
    subscriptionUuid = sub?.id ?? null;

    if (subscriptionUuid) {
      const patch: Record<string, unknown> = {};
      if (p.event_type === "SUBSCRIPTION_RENEWED") {
        patch["status"] = "active";
        patch["renewed_at"] = ts;
      }
      if (p.event_type === "SUBSCRIPTION_OVERDUE") patch["status"] = "overdue";
      if (p.event_type === "SUBSCRIPTION_CANCELLED") {
        patch["status"] = "cancelled";
        patch["cancelled_at"] = ts;
      }
      if (Object.keys(patch).length > 0) {
        await supabaseAdmin.from("subscriptions").update(patch as never).eq("id", subscriptionUuid);
      }
    }
  }

  // 5. Event (source of truth)
  const { data: inserted, error: eventError } = await supabaseAdmin
    .from("events")
    .insert({
      event_id: p.event_id,
      user_id: user.id,
      event_type: p.event_type,
      timestamp: ts,
      transaction_id: transactionUuid,
      subscription_id: subscriptionUuid,
      product_id: p.product_id ?? null,
      value: p.value ?? null,
      currency: p.currency,
      source: p.source ?? null,
      metadata: p.metadata as never,
    })
    .select("id")
    .single();

  if (eventError) {
    if (eventError.code === "23505" || eventError.message.includes("duplicate key")) {
      return { status: 200, body: { ok: true, duplicate: true, event_id: p.event_id } };
    }
    return { status: 500, body: { ok: false, error: eventError.message } };
  }

  await supabaseAdmin.from("users").update({ last_seen_at: ts }).eq("id", user.id);

  return {
    status: 201,
    body: {
      ok: true,
      duplicate: false,
      id: inserted?.id,
      event_id: p.event_id,
      user_id: user.id,
      transaction_id: transactionUuid,
      subscription_id: subscriptionUuid,
    },
  };
}
