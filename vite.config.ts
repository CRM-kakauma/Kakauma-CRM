// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig, type LovableViteTanstackOptions } from "@lovable.dev/vite-tanstack-config";

// Cloudflare Workers Builds only (it sets WORKERS_CI):
//   - keep_vars: a deploy keeps the variables set in the dashboard (without it, `wrangler deploy`
//     deletes every plain-text variable that is not in this config; only secrets survived);
//   - the Worker's name comes from CF_WORKER_NAME (a build variable), so the address can be short,
//     e.g. https://kakauma.<account>.workers.dev. Without it Nitro names the Worker after the repo.
// Lovable and Vercel builds are untouched.
const workersCi = !!process.env["WORKERS_CI"];
const workerName = workersCi ? process.env["CF_WORKER_NAME"]?.trim() : undefined;

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // the Lovable wrapper forwards these to Nitro; its types only list a few keys
  ...(workersCi
    ? {
        nitro: {
          cloudflare: {
            wrangler: { keep_vars: true, ...(workerName ? { name: workerName } : {}) },
          },
        } as unknown as NonNullable<LovableViteTanstackOptions["nitro"]>,
      }
    : {}),
});
