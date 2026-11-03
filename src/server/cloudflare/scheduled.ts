import { definePlugin } from "nitro";

/**
 * Cloudflare Cron Trigger (every 5 minutes, set in the Worker's config by vite.config.ts): runs
 * the same worker as /api/cron/crm-process, inside the Worker. Unlike an external caller
 * (cron-job.org gives up after 30 s, and a request the caller drops is cut short on Workers),
 * a scheduled run is not tied to anyone waiting for the answer.
 * Only in the Cloudflare build (Workers Builds); Lovable and Vercel do not load this file.
 */
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("cloudflare:scheduled", async () => {
    const secret = process.env["CRON_SECRET"] ?? process.env["LOVABLE_CRON_SECRET"];
    if (!secret) {
      console.error("[crm] cron trigger: CRON_SECRET not set");
      return;
    }
    const res = await nitroApp.fetch(
      new Request("https://cron.internal/api/cron/crm-process", {
        headers: { authorization: `Bearer ${secret}`, "x-crm-trigger": "cloudflare-cron" },
      }),
    );
    const body = await res.text();
    if (res.ok) console.log("[crm] cron trigger ok", body.slice(0, 300));
    else console.error("[crm] cron trigger failed", res.status, body.slice(0, 500));
  });
});
