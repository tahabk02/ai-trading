/**
 * env.ts — the single, explicit, cwd-independent environment loader.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS REPLACES
 * ════════════════════════════════════════════════════════════════════════════
 * `secrets.ts` used to do:
 *
 *     dotenv.config({ path: "../../.env" });
 *     dotenv.config({ path: "../.env" });
 *     dotenv.config();
 *
 * Every one of those is resolved against `process.cwd()`, NOT against this
 * module. With the normal `cwd = <repo>/core-backend` that means:
 *
 *     "../../.env" -> C:/Users/<you>/.env          (outside the repo; usually absent)
 *     "../.env"    -> <repo>/.env                  ← THE PARENT SERVICE-AGNOSTIC FILE
 *     (default)    -> <repo>/core-backend/.env     ← the file that was actually wanted
 *
 * and because dotenv defaults to `override: false`, the FIRST file to define a
 * key wins. The parent `<repo>/.env` was therefore authoritative for all seven
 * keys it shares with core-backend — `DATABASE_URL`, `JWT_SECRET`,
 * `AI_ENGINE_API_KEY` and the Alpaca credentials — and core-backend's own
 * `DATABASE_URL` (Postgres) was silently discarded in favour of the parent's
 * `file:./dev.db`. That is what failed `quickfix.test.ts`.
 *
 * It was also *cwd-dependent*, so the resolution changed with the working
 * directory: running `node core-backend/dist/index.js` from the repo root
 * loaded a different set of files than `npm run dev` inside core-backend. A
 * service whose configuration depends on where you launched it from is a
 * deployment landmine — the same image behaves differently under `docker run`,
 * systemd, and a developer's shell.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT
 * ════════════════════════════════════════════════════════════════════════════
 *  1. RESOLVED FROM THE MODULE, NEVER FROM cwd. The service root is derived
 *     from `__dirname`, so behaviour is identical from any directory.
 *  2. NEVER WALK UP. Only files inside this service's own directory are read.
 *     A parent `.env` is a different service's configuration and must not leak.
 *  3. REAL ENVIRONMENT WINS. Docker/compose/CI/systemd inject the truth; a file
 *     on disk may only supply what is genuinely absent.
 *
 * PRECEDENCE (highest first):
 *     1. real process environment      (container / CI / operator injected)
 *     2. <service>/.env.local          (gitignored developer override, dev only)
 *     3. <service>/.env.<NODE_ENV>     (per-environment, when present)
 *     4. <service>/.env                (committed template, gitignored values)
 *
 * Implemented by loading HIGHEST-first with `override: false`: a key already
 * present in `process.env` is never rewritten, so a real injected variable (or
 * an earlier, higher-priority file) always wins, and a lower-priority file can
 * never clobber it.
 */

import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

/**
 * `<repo>/core-backend` — derived from this file's location
 * (`<service>/src/config/env.ts`), so it is correct under ts-node, the compiled
 * `dist/config/env.js`, vitest, and a packaged container image alike.
 */
export const SERVICE_ROOT = path.resolve(__dirname, "..", "..");
export const SERVICE_NAME = path.basename(SERVICE_ROOT);

/** Names of the files this service is allowed to read, in precedence order. */
function candidateFiles(): { file: string; exists: boolean }[] {
  const nodeEnv = process.env.NODE_ENV || "development";
  const names = [
    // Highest priority first. `.env.local` is developer-only and gitignored.
    ".env.local",
    // Only when it actually exists, so a stale `.env.production` cannot bleed
    // into a development run.
    `.env.${nodeEnv}`,
    ".env",
  ];
  return names.map((n) => {
    const file = path.join(SERVICE_ROOT, n);
    return { file, exists: fs.existsSync(file) };
  });
}

let loaded = false;

/** Absolute paths actually loaded — exposed for diagnostics and tests. */
export const loadedEnvFiles: string[] = [];

/**
 * Warn when a parent `.env` exists that the old code would have consumed.
 * Purely advisory: the loader never reads it.
 *
 * Fires at most once per process — a module-level flag would reset under
 * `vi.resetModules()`, so the sentinel lives on `globalThis`.
 */
function warnAboutParentDotenv(): void {
  if (process.env.CORE_BACKEND_ALLOW_PARENT_DOTENV === "true") return;
  const g = globalThis as { __coreBackendParentDotenvWarned?: boolean };
  if (g.__coreBackendParentDotenvWarned) return;
  g.__coreBackendParentDotenvWarned = true;

  const parent = path.resolve(SERVICE_ROOT, "..", ".env");
  if (!fs.existsSync(parent)) return;
  // Never print contents — only the path and the key names we now ignore.
  let keys: string[] = [];
  try {
    keys = Object.keys(dotenv.parse(fs.readFileSync(parent)));
  } catch {
    /* unreadable parent is not our problem to solve */
  }
  const relevant = keys.filter(
    (k) =>
      /^(DATABASE_URL|JWT_SECRET|AI_ENGINE_|REDIS_|APCA_|ALPACA_|NODE_ENV|PORT)$/.test(k) ||
      k.startsWith("AI_ENGINE_"),
  );
  if (relevant.length === 0) return;
  console.warn(
    `[env] ${SERVICE_NAME}: ignoring parent ${parent} ` +
      `(it defines ${relevant.length} key(s) this service would otherwise ` +
      `inherit by accident: ${relevant.join(", ")}). ` +
      `Set the value in ${path.join(SERVICE_ROOT, ".env")} or the real environment.`,
  );
}

/**
 * Load this service's environment. Idempotent, and safe to call from anywhere.
 *
 * Must run before any module reads `process.env` — `secrets.ts` calls it at
 * module scope, which is imported before anything else in the app.
 *
 * Set `CORE_BACKEND_SKIP_ENV_FILES=true` to ignore every env file and use the
 * real environment alone. Intended for a container or CI job that injects a
 * complete configuration through compose/systemd, where a stale file baked
 * into the image would otherwise quietly fill any gap.
 *
 * @returns the absolute paths actually loaded (empty on repeat calls, on
 *          skip, or when nothing on disk supplied a value). Returned rather
 *          than only kept in module state so callers and tests can assert on it.
 */
export function loadServiceEnv(): string[] {
  if (loaded) return [...loadedEnvFiles];
  loaded = true;

  if (process.env.CORE_BACKEND_SKIP_ENV_FILES === "true") {
    console.warn(
      "[env] core-backend: CORE_BACKEND_SKIP_ENV_FILES=true — ignoring all env " +
        "files and using the real environment only. If a variable is unset here, " +
        "it is genuinely unset.",
    );
    return [];
  }

  warnAboutParentDotenv();

  for (const { file, exists } of candidateFiles()) {
    if (!exists) continue;
    // `override: false` is the whole precedence mechanism — see the header.
    dotenv.config({ path: file, override: false, quiet: true });
    loadedEnvFiles.push(file);
  }
  return [...loadedEnvFiles];
}

/**
 * True when a required variable is missing, empty, or still a placeholder.
 * Placeholder detection is what stops `JWT_SECRET="change-me"` from being
 * treated as configured.
 */
const PLACEHOLDER = /^(change[-_ ]?me|your[-_ ]|placeholder|example|dummy|test[-_ ]?only|xxx+|todo)/i;

export function isConfigured(value: string | undefined): boolean {
  const v = (value || "").trim();
  if (v === "") return false;
  if (PLACEHOLDER.test(v)) return false;
  if (/^postgres(ql)?:\/\//i.test(v)) return true;
  if (/^file:/.test(v)) return false; // SQLite dev fallback — never "configured"
  if (/^rediss?:\/\//i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  return true;
}

/** Absolute path of a service-local env file, for error messages. */
export function describeEnvSources(): string {
  return loadedEnvFiles.length
    ? loadedEnvFiles.map((f) => path.basename(f)).join(", ")
    : "(none — relying on the real environment)";
}
