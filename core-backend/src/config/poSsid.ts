/**
 * poSsid.ts — CENTRAL Pocket Option SSID RESOLVER (single source of truth)
 *
 * WHY THIS EXISTS
 * The SSID lives canonically in the *bridge's* own configuration —
 * `pocket-bridge/.env` (`POCKET_OPTION_SSID=...`) and, once a browser session is
 * captured, `pocket-bridge/session/po_session.json` (the `ssid` cookie). Each
 * service reads only its OWN `.env` (see `config/env.ts` and the pocket-bridge
 * `_pocket_bridge_env_files()` contract — a parent/root `.env` is deliberately
 * never consulted). So without this resolver the SSID had to be hand-copied into
 * `core-backend/.env` as well, purely so the backend could forward it.
 *
 * Worse, the auto-spawn used to pass `POCKET_OPTION_SSID: <value> || ""` — an
 * EMPTY STRING is still a present key, and `python-dotenv`'s `override=False`
 * never fills an already-present key. So an unset backend value actively
 * SHADOWED the bridge's own `.env`, leaving the bridge stuck `awaiting_ssid`
 * even though a valid SSID was sitting in `pocket-bridge/.env`.
 *
 * WHAT THIS DOES
 * Resolves the SSID from the central sources, highest precedence first:
 *   1. the real process environment          (operator / compose injection)
 *   2. `pocket-bridge/.env`                  (the bridge's central config)
 *   3. `pocket-bridge/session/po_session.json` (captured session `ssid` cookie)
 *
 * The caller injects the result into the bridge child env, and MUST NOT set an
 * empty `POCKET_OPTION_SSID` when the resolution is empty (that is the shadowing
 * bug). Never log the value — only the source and a masked length.
 */

import { existsSync, readFileSync } from "fs";

export type PoSsidSource = "env" | "bridge_env" | "session_file" | "none";

export interface ResolvedPoSsid {
  /** The resolved SSID value (raw `.env` string or session cookie). "" = none. */
  value: string;
  /** Where the value came from — safe to log; the value itself is not. */
  source: PoSsidSource;
}

/** Strip a single matching pair of wrapping single/double quotes. */
export function unwrapQuotes(value: string): string {
  const v = (value || "").trim();
  if (
    v.length >= 2 &&
    ((v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"')))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Read `POCKET_OPTION_SSID` from an `.env` file. Comments/blank lines are
 * skipped; the value keeps any interior characters (the SSID is a
 * `42["auth",{...}]` message) and only a wrapping quote pair is removed.
 * Returns "" when the file is absent/unreadable or the key is not set.
 */
export function readSsidFromEnvFile(envPath: string): string {
  if (!envPath || !existsSync(envPath)) return "";
  let text: string;
  try {
    text = readFileSync(envPath, "utf-8");
  } catch {
    return "";
  }
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    if (stripped.slice(0, eq).trim() !== "POCKET_OPTION_SSID") continue;
    return unwrapQuotes(stripped.slice(eq + 1));
  }
  return "";
}

/**
 * Extract the `ssid` cookie value from a captured `po_session.json`. Returns ""
 * when the file is absent/unreadable, is not a plaintext JSON session (an
 * encrypted `FERNET:` payload is handled by the Python bridge, not here), or has
 * no non-empty `ssid` cookie.
 */
export function readSsidFromSessionFile(sessionPath: string): string {
  if (!sessionPath || !existsSync(sessionPath)) return "";
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf-8");
  } catch {
    return "";
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!data || typeof data !== "object") return "";
  const cookies = (data as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return "";
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object") continue;
    const c = cookie as { name?: unknown; value?: unknown };
    if (c.name !== "ssid") continue;
    if (typeof c.value === "string" && c.value.trim()) return c.value.trim();
  }
  return "";
}

export interface ResolvePoSsidOptions {
  /** Real environment value (highest precedence). */
  envValue?: string;
  /** Absolute path to `pocket-bridge/.env`. */
  bridgeEnvPath?: string;
  /** Absolute path to `pocket-bridge/session/po_session.json`. */
  sessionPath?: string;
}

/**
 * Resolve the SSID from the central sources with documented precedence. Pure
 * (only reads the given file paths) so it is trivially testable and never
 * touches `process.env` itself.
 */
export function resolvePoSsid(opts: ResolvePoSsidOptions = {}): ResolvedPoSsid {
  const envValue = (opts.envValue ?? "").trim();
  if (envValue) return { value: envValue, source: "env" };

  if (opts.bridgeEnvPath) {
    const fromEnvFile = readSsidFromEnvFile(opts.bridgeEnvPath);
    if (fromEnvFile) return { value: fromEnvFile, source: "bridge_env" };
  }

  if (opts.sessionPath) {
    const fromSession = readSsidFromSessionFile(opts.sessionPath);
    if (fromSession) return { value: fromSession, source: "session_file" };
  }

  return { value: "", source: "none" };
}

/**
 * Apply a resolved SSID to a child env object, honouring the shadowing rule:
 *   • non-empty → set the key so the child goes live immediately;
 *   • empty     → DELETE the key so the child's own `python-dotenv` can still
 *                 load `pocket-bridge/.env` (a present-but-empty key would
 *                 block it — the original bug).
 * Mutates and returns `env`.
 */
export function applySsidToEnv(
  env: Record<string, string | undefined>,
  resolved: ResolvedPoSsid,
): Record<string, string | undefined> {
  if (resolved.value) {
    env.POCKET_OPTION_SSID = resolved.value;
  } else {
    delete env.POCKET_OPTION_SSID;
  }
  return env;
}
