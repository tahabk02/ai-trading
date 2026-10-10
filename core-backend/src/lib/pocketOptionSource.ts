/**
 * pocketOptionSource.ts — SINGLE SOURCE-CLASSIFICATION HELPER (PART 43.5 [473])
 *
 * Quote provenance flows through several layers (the real-tick ring buffer, the
 * market-quotes snapshot, the history/proxy fallback cascade). "Is this print a
 * genuine Pocket Option tick?" must be answered identically everywhere, so it
 * lives here as one tiny, dependency-free predicate instead of a startswith
 * check copy-pasted into each service.
 *
 * A PO print is any tier whose source begins with `pocket_option` — the live
 * SSOT tier (`pocket_option_ssot`), a held handshake print (`pocket_option_held`,
 * `pocket_option_last_known`) and the HTTP-live stamp (`pocket_option_ssot:live`).
 * Every market-proxy feed (frankfurter / open_er_api / github_* / yahoo_* /
 * coingecko / last_known_real) is NOT a PO print.
 */

/** True when `raw` names a Pocket Option feed (any tier, held stamps included). */
export function isPocketOptionSource(
  raw: string | null | undefined,
): boolean {
  if (typeof raw !== "string") return false;
  const clean = raw.trim().toLowerCase();
  if (!clean) return false;
  // Strip an HTTP-live suffix (`pocket_option_ssot:live`) before matching.
  const base = clean.endsWith(":live")
    ? clean.slice(0, -":live".length)
    : clean;
  return base.startsWith("pocket_option");
}
