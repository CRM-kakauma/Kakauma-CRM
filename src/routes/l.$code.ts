import { createFileRoute } from "@tanstack/react-router";

/** Short link: /l/<code> → the store link it stands for (with its UTMs). Counts the click. */
export const Route = createFileRoute("/l/$code")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const home = "https://kakauma.com.br/";
        const code = String(params.code ?? "");
        if (!/^[A-Za-z0-9]{4,12}$/.test(code)) return Response.redirect(home, 302);
        try {
          const { crmRpc } = await import("@/server/crm/supabase.server");
          const r = await crmRpc("crm_open_short_link", { p_code: code });
          const url = typeof r.data === "string" ? r.data : null;
          // only store links are ever stored; anything else goes to the home page
          const to =
            url && /^https:\/\/([a-z0-9-]+\.)*kakauma\.com\.br(\/|\?|#|$)/i.test(url) ? url : home;
          return new Response(null, {
            status: 302,
            headers: {
              location: to,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer-when-downgrade",
            },
          });
        } catch {
          return Response.redirect(home, 302);
        }
      },
    },
  },
});
