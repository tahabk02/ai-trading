/**
 * Regression guard for the dev/prod proxy split in next.config.js.
 *
 * Two independent failures are locked down here:
 *
 *  1. A PRODUCTION build must bake ZERO rewrites. `rewrites()` is evaluated
 *     once during `next build` and frozen into routes-manifest.json, so any
 *     destination added there is a build-time constant. That is exactly how
 *     `http://localhost:4000` ended up hard-wired into the production image
 *     and every proxied request looped back into client-app.
 *
 *  2. DEVELOPMENT must KEEP the localhost rewrites. `next dev` cannot boot
 *     server.js, so with no rewrites `/api`, `/socket.io` and `/ai` have no
 *     handler and the live feed 404s. `client-app/.env.local` ships every
 *     NEXT_PUBLIC_* commented out, so the browser falls back to the relative
 *     paths ("" , "/api/v1", "/ai") that REQUIRE these rewrites.
 *
 *  3. `skipTrailingSlashRedirect` is production-only. With it enabled in dev,
 *     path-to-regexp stops matching the `/socket.io/:path*` rewrite against the
 *     zero-segment / trailing-slash forms, and
 *     `/socket.io/?EIO=4&transport=polling` 404s — the feed never connects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
// __dirname = client-app/src/lib/__tests__  ->  client-app/next.config.js
const CONFIG_PATH = path.resolve(__dirname, "../../../next.config.js");

type Config = {
  assetPrefix?: string;
  skipTrailingSlashRedirect?: boolean;
  env?: Record<string, string | undefined>;
  headers?: () => Promise<unknown[]>;
  rewrites?: () => Promise<
    Array<{ source: string; destination: string }>
  >;
};

function loadConfig(nodeEnv: string): Config {
  // NOTE: rewrites()/headers() read process.env.NODE_ENV at CALL time, not at
  // require time. So NODE_ENV must still be correct when the test invokes
  // them — it is restored in afterEach, not here.
  // vi.stubEnv, not `process.env.X = ...`: @types/node types NODE_ENV as
  // read-only, and stubEnv also auto-restores in afterEach.
  vi.stubEnv("NODE_ENV", nodeEnv);
  // Bust the require cache so next.config.js re-evaluates against this NODE_ENV.
  delete require_.cache[require_.resolve(CONFIG_PATH)];
  return require_(CONFIG_PATH) as Config;
}

describe("next.config.js — dev vs prod proxy strategy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("production", () => {
    let cfg: Config;
    beforeEach(async () => {
      cfg = loadConfig("production");
    });

    it("bakes ZERO rewrites so upstreams stay runtime-resolved in server.js", async () => {
      const rules = await cfg.rewrites!();
      expect(rules).toEqual([]);
      expect(rules.some((r) => /localhost/.test(r.destination))).toBe(false);
    });

    it("enables skipTrailingSlashRedirect so engine.io keeps its real path", () => {
      expect(cfg.skipTrailingSlashRedirect).toBe(true);
    });

    it("still inlines the build-time NEXT_PUBLIC_* values (env block preserved)", () => {
      expect(Object.keys(cfg.env ?? {}).sort()).toEqual([
        "NEXT_PUBLIC_AI_ENGINE_URL",
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_SOCKET_URL",
        "NEXT_PUBLIC_WS_URL",
      ]);
    });

    it("keeps the caching/CSP headers block", async () => {
      const headers = (await cfg.headers!()) as Array<{
        headers: Array<{ key: string }>;
      }>;
      expect(headers.length).toBeGreaterThan(0);
      const keys = headers.flatMap((h) => h.headers.map((x) => x.key));
      expect(keys).toContain("Cache-Control");
    });
  });

  describe("development", () => {
    let cfg: Config;
    beforeEach(() => {
      cfg = loadConfig("development");
    });

    it("keeps the 4 localhost rewrites so next dev can proxy", async () => {
      const rules = await cfg.rewrites!();
      expect(rules).toHaveLength(4);
      const sources = rules.map((r) => r.source);
      expect(sources).toContain("/api/:path*");
      expect(sources).toContain("/socket.io/:path*");
      expect(sources).toContain("/ai/:path*");
      expect(sources).toContain("/health");
    });

    it("points every dev rewrite at localhost (never a container name)", async () => {
      const rules = await cfg.rewrites!();
      for (const r of rules) {
        expect(r.destination).toMatch(/^http:\/\/localhost:(4000|8000)/);
      }
    });

    it("DISABLES skipTrailingSlashRedirect (it breaks the /socket.io rewrite)", () => {
      // Regression: this used to be hardcoded `true`, which made
      // /socket.io/?EIO=4&transport=polling 404 in dev and killed the feed.
      expect(cfg.skipTrailingSlashRedirect).toBe(false);
    });
  });
});
