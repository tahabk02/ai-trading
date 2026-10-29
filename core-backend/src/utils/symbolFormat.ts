/**
 * Broker/UI symbol canonicalization.
 *
 * Pocket Option returns asset names in several spellings for the SAME
 * instrument (`EURUSD_otc`, `EURUSD-OTC`, `EUR/USD OTC`, `EURUSD.OTC`). The
 * canonical key must collapse all of them to `EUR/USD`, otherwise a live tick
 * is written under a different key than the chart/room reads and the bridge
 * subscription is rejected as an unknown asset.
 */

const OTC_SUFFIX = /(?:[_\-\s.]?OTC)$/i;

/** True when the raw symbol carries an OTC venue suffix in any spelling. */
export function isOtcSymbol(raw: unknown): boolean {
  return typeof raw === "string" && OTC_SUFFIX.test(raw.trim());
}

/**
 * Map any backend/UI/broker symbol variant onto the canonical `BASE/QUOTE`
 * form. Non-strings and blanks return `""` — never a fabricated key.
 */
export function canonicalizeSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "";

  let s = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .toUpperCase();

  // Strip the OTC venue suffix INCLUDING its separator first: stripping only
  // the letters leaves a dangling "_" that becomes a trailing "/" after
  // separator normalization.
  s = s.replace(OTC_SUFFIX, "");
  s = s.replace(/=X$/, "");
  s = s.replace(/\.(FX|FOREX|CS|TO)$/, "");
  s = s.replace(/[\-_.\s]+/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/^\/+|\/+$/g, "");

  if (s.includes("/")) return s;
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
    return `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  return s;
}

/**
 * Build the exact Pocket Option asset name for a canonical symbol.
 *
 * Used as a deterministic fallback when the bridge's authoritative registry
 * is not available yet. `preferOtc` must come from the symbol's classified
 * `assetSubType`, never guessed from the canonical pair.
 */
export function toBrokerAssetSymbol(raw: unknown, preferOtc = false): string {
  const canonical = canonicalizeSymbol(raw);
  if (!canonical || !canonical.includes("/")) return "";
  const compact = canonical.replace(/\//g, "");
  return preferOtc ? `${compact}_otc` : compact;
}
