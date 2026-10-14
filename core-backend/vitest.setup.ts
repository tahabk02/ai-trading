/**
 * vitest.setup.ts — PART 49 [516] HERMETIC TEST ENVIRONMENT
 *
 * Supplies an in-memory fallback configuration so the whole core-backend suite
 * runs with **no `.env` file on disk and no system environment variables**.
 *
 * Runs as a vitest `setupFiles` entry, i.e. BEFORE any test module is imported,
 * so module-scope reads are hermetic too: `config/secrets.ts` calls
 * `loadServiceEnv()` at import time, and `env.ts` loads files with
 * `override: false` — a value present here therefore wins over any `.env` that
 * happens to exist, making the test env deterministic regardless of the host.
 *
 * `failFast.test.ts` is unaffected: it boots `secrets.ts` in CHILD processes
 * with a pristine, explicitly-controlled env and `CORE_BACKEND_SKIP_ENV_FILES`,
 * so none of these values leak into its "missing config must fail" cases.
 *
 * These are obvious, non-secret TEST values. They are never used by production
 * (which sets `ALLOW_INSECURE_DEV_DEFAULTS` to anything but "true").
 */

const HERMETIC_FALLBACKS: Record<string, string> = {
  // The one deliberate opt-out from strict boot validation (see secrets.ts).
  ALLOW_INSECURE_DEV_DEFAULTS: "true",
  // A real Postgres URL — never the `file:./dev.db` SQLite fallback, so a test
  // that asserts "the configured DB is Postgres" is meaningful.
  DATABASE_URL: "postgresql://trading:trading@localhost:5433/trading_ai_test",
  // The confirmed bus URL for the "redis URL configured" contract.
  REDIS_URL: "redis://localhost:6379",
  // ≥32 chars so it clears the length guard as well as the placeholder guard.
  JWT_SECRET: "h516-hermetic-test-signing-secret-000000000000000000000000",
  AI_ENGINE_API_KEY: "h516-hermetic-ai-engine-test-key-0000000000000000000000",
};

for (const [key, value] of Object.entries(HERMETIC_FALLBACKS)) {
  const existing = (process.env[key] || "").trim();
  if (!existing) process.env[key] = value;
}
