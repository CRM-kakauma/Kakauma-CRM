import { redirect } from "@tanstack/react-router";

/**
 * The old analytics screens read the legacy Lovable Supabase (VITE_SUPABASE_*,
 * set at build time). Where it is not configured (e.g. the Vercel deploy of
 * the CRM), those screens are hidden and their URLs open the CRM instead.
 */
export const LEGACY_ENABLED = Boolean(
  import.meta.env["VITE_SUPABASE_URL"] && import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"],
);

export function legacyGuard() {
  if (!LEGACY_ENABLED) throw redirect({ to: "/crm" });
}
