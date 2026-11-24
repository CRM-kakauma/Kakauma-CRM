import { useEffect, useState } from "react";

/** Text search helpers: ignore case and accents (same rule as crm.fold in the database). */

export const fold = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The part of `text` around the first match of `query`, split to highlight the match. */
export function snippet(
  text: string,
  query: string,
  around = 60,
): { before: string; hit: string; after: string } | null {
  const q = fold(query.trim());
  if (!q) return null;
  // NFD + removing marks keeps one char per letter for Portuguese text, so indexes line up
  const plain = text.normalize("NFC");
  const i = fold(plain).indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - around);
  const end = Math.min(plain.length, i + q.length + around);
  return {
    before: (start > 0 ? "…" : "") + plain.slice(start, i),
    hit: plain.slice(i, i + q.length),
    after: plain.slice(i + q.length, end) + (end < plain.length ? "…" : ""),
  };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
