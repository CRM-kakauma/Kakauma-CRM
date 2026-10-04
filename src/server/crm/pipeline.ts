import { CURRENT_SCHEMA_VERSION, normalize } from "./normalize/index.ts";
import { redactCardData } from "./redact.ts";

/**
 * Webhook → raw store → normalize → engine.
 *
 * The raw payload is persisted first; only then is it processed. If processing
 * fails, the event stays stored and the cron worker retries it with backoff
 * (crm.fail_event), ending in the dead-letter queue after 5 attempts.
 */

/** Calls a public.crm_* database function (Supabase RPC in the app, a direct connection in tests). */
export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

interface ClaimedEvent {
  id: string;
  event_id: string;
  source: string;
  event_name: string | null;
  payload: unknown;
  schema_version: string;
  retry_count: number;
  received_at: string;
}

export interface IngestResponse {
  status: number;
  body: Record<string, unknown>;
}

function sourceEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  for (const k of ["event_id", "webhook_id", "notification_id"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

export async function ingestWebhook(
  rpc: Rpc,
  source: string,
  rawBody: string,
): Promise<IngestResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    await rpc("crm_dead_letter_request", {
      p_source: source,
      p_reason: "invalid_json",
      p_error: (e as Error).message,
      p_raw_body: rawBody,
    });
    // Accepted so the provider does not retry forever; kept in the dead-letter queue.
    return { status: 202, body: { ok: false, error: "invalid_json", dead_letter: true } };
  }

  const { payload, redacted } = redactCardData(parsed);
  const eventName =
    payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>)["event_name"] ?? null)
      : null;

  const { data, error } = await rpc("crm_ingest_event", {
    p_source: source,
    p_event_name: typeof eventName === "string" ? eventName : null,
    p_source_event_id: sourceEventId(payload),
    p_payload: payload,
    p_schema_version: CURRENT_SCHEMA_VERSION[source] ?? "v1",
    p_redacted: redacted,
  });
  if (error) {
    // Nothing was stored: fail loudly so the provider retries the webhook.
    return { status: 500, body: { ok: false, error: "store_failed", message: error.message } };
  }
  const row = (
    data as { id: string; event_id: string; duplicate: boolean; processing_status: string }[]
  )[0];
  if (!row) return { status: 500, body: { ok: false, error: "store_failed" } };

  if (row.duplicate && ["PROCESSED", "IGNORED", "DEAD_LETTER"].includes(row.processing_status)) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, event_id: row.event_id, status: row.processing_status },
    };
  }

  const processed = await processPending(rpc, { id: row.id, limit: 1 });
  return {
    status: 200,
    body: {
      ok: true,
      duplicate: row.duplicate,
      event_id: row.event_id,
      status: processed.results[0]?.status ?? row.processing_status,
    },
  };
}

export interface ProcessSummary {
  claimed: number;
  results: { event_id: string; status: string; error?: string }[];
}

/** Processes stored events (a specific one, or the next batch due for (re)processing). */
export async function processPending(
  rpc: Rpc,
  opts: { limit?: number; id?: string } = {},
): Promise<ProcessSummary> {
  const { data, error } = await rpc("crm_claim_events", {
    p_limit: opts.limit ?? 50,
    p_id: opts.id ?? null,
  });
  if (error) throw new Error(error.message);
  const events = (data ?? []) as ClaimedEvent[];
  const results: ProcessSummary["results"] = [];

  for (const ev of events) {
    const n = normalize(ev.source, ev.schema_version, ev.payload, ev.received_at);
    if (!n.ok) {
      const message = n.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
      const { data: status } = await rpc("crm_fail_event", {
        p_raw_event_id: ev.id,
        p_error: message,
        p_fatal: true,
      });
      results.push({
        event_id: ev.event_id,
        status: String(status ?? "DEAD_LETTER"),
        error: message,
      });
      continue;
    }
    const { data: res, error: procError } = await rpc("crm_process_event", {
      p_raw_event_id: ev.id,
      p_normalized: n.event,
    });
    if (procError) {
      // Database unreachable mid-batch: the claim expires and the event is retried.
      results.push({ event_id: ev.event_id, status: "FAILED", error: procError.message });
      continue;
    }
    const r = (res ?? {}) as { status?: string; error?: string };
    results.push({
      event_id: ev.event_id,
      status: r.status ?? "UNKNOWN",
      ...(r.error ? { error: r.error } : {}),
    });
  }
  return { claimed: events.length, results };
}

/** Copies B4you payloads already captured by the legacy analytics store into the raw event store. */
export async function backfillFromLegacy(rpc: Rpc, limit = 5000): Promise<number> {
  const { data, error } = await rpc("crm_backfill_from_legacy", { p_limit: limit });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
