import type { NormalizeResult } from "../types.ts";
import { normalizeB4you } from "./b4you.ts";

type Normalizer = (raw: unknown, opts: { receivedAt: string }) => NormalizeResult;

/**
 * Normalizers by source and schema version. Old versions stay registered so
 * stored events keep being replayable; a new payload format gets a new entry
 * instead of changing an existing one.
 */
const NORMALIZERS: Record<string, Record<string, Normalizer>> = {
  b4you: { v1: normalizeB4you },
};

export const CURRENT_SCHEMA_VERSION: Record<string, string> = { b4you: "v1" };

export function normalize(
  source: string,
  schemaVersion: string,
  raw: unknown,
  receivedAt: string,
): NormalizeResult {
  const fn = NORMALIZERS[source]?.[schemaVersion];
  if (!fn) {
    return {
      ok: false,
      fatal: true,
      errors: [{ code: "invalid_event", message: `no normalizer for ${source} ${schemaVersion}` }],
      event: null,
    };
  }
  return fn(raw, { receivedAt });
}
