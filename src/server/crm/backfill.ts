import { CURRENT_SCHEMA_VERSION, normalize } from "./normalize/index.ts";
import { redactCardData } from "./redact.ts";
import type { Rpc } from "./pipeline.ts";

/**
 * History import (webhooks from before the CRM existed, e.g. a JSONL export).
 *
 * Each line is a webhook payload, or { received_at, payload } to keep the time it originally
 * arrived. Payloads go through the same steps as a live webhook (card data removed, raw store,
 * normalizer, engine) with two differences: received_at is the original one, and processing
 * runs as "backfill" — flows and automations ignore those facts, so customers get no message.
 * Idempotent: the same payload imported twice is stored and counted once.
 */

export interface BackfillItem {
  payload: unknown;
  received_at?: string | null;
}

export interface BackfillSummary {
  received: number;
  counts: Record<string, number>;
  errors: { line: number; error: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** One JSONL line → the item (bare payload or the { received_at, payload } envelope). */
export function parseBackfillLine(line: string): BackfillItem | null {
  const t = line.trim();
  if (!t) return null;
  const v = JSON.parse(t) as unknown;
  if (isObj(v) && isObj(v["payload"]) && !("event_name" in v))
    return {
      payload: v["payload"],
      received_at: typeof v["received_at"] === "string" ? v["received_at"] : null,
    };
  return { payload: v };
}

/** When the original arrival time is unknown: the payload's own last update / creation time. */
function guessReceivedAt(payload: unknown): string | null {
  if (!isObj(payload)) return null;
  for (const k of ["updated_at", "paid_at", "created_at"]) {
    const v = payload[k];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return null;
}

function sourceEventId(payload: unknown): string | null {
  if (!isObj(payload)) return null;
  for (const k of ["event_id", "webhook_id", "notification_id"]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

export async function importBackfill(
  rpc: Rpc,
  source: string,
  items: BackfillItem[],
  firstLine = 1,
): Promise<BackfillSummary> {
  const counts: Record<string, number> = {};
  const errors: BackfillSummary["errors"] = [];
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  for (const [i, item] of items.entries()) {
    const line = firstLine + i;
    if (!isObj(item.payload)) {
      bump("inválido");
      errors.push({ line, error: "linha sem um objeto JSON" });
      continue;
    }
    const { payload, redacted } = redactCardData(item.payload);
    const p = payload as Record<string, unknown>;
    const receivedAt =
      item.received_at && !Number.isNaN(Date.parse(item.received_at))
        ? new Date(item.received_at).toISOString()
        : guessReceivedAt(p);
    const stored = await rpc("crm_ingest_backfill", {
      p_source: source,
      p_event_name: typeof p["event_name"] === "string" ? p["event_name"] : null,
      p_source_event_id: sourceEventId(p),
      p_payload: p,
      p_redacted: redacted,
      p_received_at: receivedAt,
    });
    if (stored.error) throw new Error(stored.error.message); // database unreachable: stop, retry later
    const row = (
      stored.data as { id: string; duplicate: boolean; processing_status: string }[] | null
    )?.[0];
    if (!row) throw new Error("não gravou o evento");
    if (row.duplicate && ["PROCESSED", "IGNORED", "DEAD_LETTER"].includes(row.processing_status)) {
      bump("já existia");
      continue;
    }
    // lock it like the worker does, then process as backfill
    const claimed = await rpc("crm_claim_events", { p_limit: 1, p_id: row.id });
    if (claimed.error) throw new Error(claimed.error.message);
    const ev = (
      (claimed.data ?? []) as {
        id: string;
        source: string;
        schema_version: string;
        payload: unknown;
        received_at: string;
      }[]
    )[0];
    if (!ev) {
      bump("termina sozinho"); // being processed by an interrupted call: the worker finishes it (marked)
      continue;
    }
    const n = normalize(
      ev.source,
      ev.schema_version ?? CURRENT_SCHEMA_VERSION[source] ?? "v1",
      ev.payload,
      ev.received_at,
    );
    if (!n.ok) {
      const message = n.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
      await rpc("crm_fail_event", { p_raw_event_id: ev.id, p_error: message, p_fatal: true });
      bump("não reconhecido");
      errors.push({ line, error: message });
      continue;
    }
    const res = await rpc("crm_process_event_backfill", {
      p_raw_event_id: ev.id,
      p_normalized: n.event,
    });
    if (res.error) throw new Error(res.error.message);
    const r = (res.data ?? {}) as { status?: string; error?: string };
    let status = r.status ?? "UNKNOWN";
    // a failure goes to the error queue (Operação → Fila de erros), never to the automatic
    // retry, which would process it outside the backfill
    if (status === "FAILED") {
      await rpc("crm_fail_event", {
        p_raw_event_id: ev.id,
        p_error: r.error ?? "falha",
        p_fatal: true,
      });
      status = "DEAD_LETTER";
    }
    bump(
      status === "PROCESSED"
        ? "importado"
        : status === "IGNORED"
          ? "ignorado"
          : status === "FAILED" || status === "DEAD_LETTER"
            ? "erro"
            : status,
    );
    if (r.error) errors.push({ line, error: r.error });
  }
  return { received: items.length, counts, errors };
}
