/**
 * format.ts — Safe, locale-agnostic number formatting utilities.
 *
 * WHY THIS FILE EXISTS:
 * The original code relied on `.toLocaleString()` which:
 * 1. Uses the BROWSER locale (e.g. "de-DE" produces "1.742,13" instead of "1,742.13")
 * 2. Throws on non-finite values (NaN, Infinity)
 * 3. Concatenates arrays when accidentally passed an array ("624 697 751 877,13")
 *
 * These utilities safely coerce ANY input type to a clean number string,
 * always using "en-US" locale for consistent currency/decimals.
 *
 * OTC FOREX: Pair-aware formatting helpers (`formatPairPrice`, `getPairDigits`)
 * are bound to the strict OTC whitelist in @/constants/symbols so the exact
 * decimal precision per pair is always respected (JPY crosses = 3, others = 5).
 */
import { getPriceDigits } from "@/constants/symbols";

// ── Type Helpers ──

type SafeNumber = number | string | null | undefined | unknown;

// ── Core Coercion ──

/**
 * Safely coerces an unknown value to a finite number.
 * - Strings: parsed as float
 * - Arrays: takes first element recursively
 * - Objects: returns 0
 * - NaN / Infinity / null / undefined: returns 0
 */
function toFinite(value: SafeNumber, fallback = 0): number {
  if (value === null || value === undefined) return fallback;

  let raw = value;

  // Unwrap arrays: if we get ["624", "697", ...] from concatenated JSON
  if (Array.isArray(raw)) {
    raw = raw.length > 0 ? raw[0] : fallback;
  }

  const type = typeof raw;

  if (type === "number") {
    return Number.isFinite(raw as number) ? (raw as number) : fallback;
  }

  if (type === "string") {
    const trimmed = (raw as string).trim();
    // Handle comma-as-decimal (European format) by replacing last comma with dot
    // e.g. "1.742,13" → "1742.13"
    const normalized = trimmed
      .replace(/\s+/g, "") // Remove spaces
      .replace(/\.(?=.*\.)/g, "") // Remove all dots except the last one
      .replace(",", "."); // Replace comma with dot

    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

/**
 * Format a number with "en-US" locale for consistent comma-separated thousands.
 * This NEVER uses the user's browser locale, preventing "1.742,13" style output.
 */
function enUSFormat(value: number, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat("en-US", options).format(value);
  } catch {
    // Absolute fallback — should never happen
    return value.toFixed(2);
  }
}

// ── Public API ──

/**
 * Format a number with comma-separated thousands and fixed decimals.
 *
 * @param value - The raw value (number, string, array, null, etc.)
 * @param decimals - Number of decimal places (default: 2)
 * @param fallback - Fallback string if value is invalid (default: "--")
 *
 * ✅ Examples:
 *   formatNumber(1742.13)        → "1,742.13"
 *   formatNumber("1742.13")      → "1,742.13"
 *   formatNumber(null)           → "--"
 *   formatNumber("624 697 751")  → "624,697,751.00"
 *   formatNumber([1742.13])      → "1,742.13"
 */
export function formatNumber(
  value: SafeNumber,
  decimals = 2,
  fallback = "--",
): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  return enUSFormat(num, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a number as USD currency with $ prefix and commas.
 *
 * ✅ Examples:
 *   formatCurrency(1742.13)     → "$1,742.13"
 *   formatCurrency("1,742.13")  → "$1,742.13"
 *   formatCurrency(null)         → "--"
 *   formatCurrency([624, 697])   → "$624.00" (first element)
 */
export function formatCurrency(value: SafeNumber, fallback = "--"): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  return enUSFormat(num, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * PAIR-AWARE CURRENCY FORMATTER — uses the pair's quote currency and decimal precision.
 * For OTC forex pairs, this ensures correct decimal places (3 for JPY, 5 for others)
 * and the correct currency symbol/ISO code.
 *
 * @param value - The raw price value
 * @param symbol - OTC pair symbol (e.g. "AUD/CAD", "CAD/JPY")
 * @param fallback - Fallback string if value is invalid (default: "--")
 *
 * ✅ Examples:
 *   formatPairCurrency(1.3456789, "AUD/CAD") → "1.34568"
 *   formatPairCurrency(97.12345, "CAD/JPY")  → "97.123"
 *   formatPairCurrency(0.0078, "KES/USD")    → "0.00780"
 */
export function formatPairCurrency(
  value: SafeNumber,
  symbol?: string | null,
  fallback = "--",
): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  const digits = getPairDigits(symbol ?? "");
  return num.toFixed(digits);
}

/**
 * Format a number with compact notation (K / M / B).
 *
 * ✅ Examples:
 *   formatCompact(1_742_130)  → "$1.74M"
 *   formatCompact(1742)       → "$1.74K"
 *   formatCompact(null)       → "--"
 */
export function formatCompact(value: SafeNumber, fallback = "--"): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  return enUSFormat(num, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    notation: "compact",
    compactDisplay: "short",
  });
}

/**
 * Format a percentage value (multiply by 100 automatically if in decimal).
 *
 * ✅ Examples:
 *   formatPercent(0.8562)    → "85.6%"
 *   formatPercent(85.62)     → "85.6%"  (auto-detects > 1)
 *   formatPercent(null)      → "--"
 */
export function formatPercent(
  value: SafeNumber,
  decimals = 1,
  fallback = "--",
): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;

  // If value > 1, assume it's already a percentage (e.g. 85.6 vs 0.856)
  const pct = num > 1 ? num : num * 100;
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Safely format an integer (removes all decimals).
 *
 * ✅ Examples:
 *   formatInteger(1742.99) → "1,742"
 *   formatInteger("1742")  → "1,742"
 *   formatInteger(null)    → "--"
 */
export function formatInteger(value: SafeNumber, fallback = "--"): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  return enUSFormat(Math.round(num), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/**
 * Safely convert a value to fixed decimal string (no commas, no $).
 * Useful for raw display or in inputs.
 *
 * ✅ Examples:
 *   safeToFixed(1742.136, 2)  → "1742.14"
 *   safeToFixed(null, 2)      → "--"
 *   safeToFixed("abc", 2)     → "--"
 */
export function safeToFixed(
  value: SafeNumber,
  decimals = 2,
  fallback = "--",
): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  return num.toFixed(decimals);
}

/**
 * GLOBAL CONFIDENCE OVERFLOW EXTERMINATOR — 0 DEMO.
 * Normalizes ANY confidence value to a [0, 100] percentage string.
 *
 * Handles all scale variants:
 *   rawConf > 1000 → /100 (extreme overflow like 8493 → 84.93)
 *   rawConf in (100, 1000] → keep (already percentage scale)
 *   rawConf ≤ 100 → ×100 (promotes [0,1] scale)
 * Hard clamp [0, 100]. Returns "0.0" for invalid input.
 *
 * ✅ Examples:
 *   sanitizeConfidence(84.93)   → "84.9"
 *   sanitizeConfidence(0.8493)  → "84.9"
 *   sanitizeConfidence(8493)    → "84.9"
 *   sanitizeConfidence(null)    → "0.0"
 */
export function sanitizeConfidence(val: any): string {
  const num = Number(val) || 0;
  // Scale detection:
  //   num > 1000 → extreme overflow (e.g. 6590), divide by 100
  //   num > 1    → already in [0,100] percentage scale, keep as-is
  //   num ≤ 1    → in [0,1] decimal scale, multiply by 100
  const norm = num > 1000 ? num / 100 : num > 1 ? num : num * 100;
  return Math.min(Math.max(norm, 0), 100).toFixed(1);
}

// ════════════════════════════════════════════════════════════════════
// OTC FOREX PAIR-AWARE FORMATTING — STRICT WHITELIST BOUND
// ════════════════════════════════════════════════════════════════════

/**
 * Get the decimal precision for a whitelisted OTC pair.
 * Delegates to the single source of truth `getPriceDigits()` in
 * @/constants/symbols (JPY crosses = 3, others = 5).
 *
 * @param symbol - e.g. "AUD/USD", "CAD/JPY"
 * @returns digit precision (defaults to 5 for unknown symbols — never throws)
 */
export function getPairDigits(symbol?: string | null): number {
  try {
    return getPriceDigits(symbol ?? "");
  } catch {
    return 5;
  }
}

/**
 * Format an OTC forex price with the whitelisted pair's exact precision.
 * Handles any safe input (number/string/null). Never shows more decimals
 * than the pair supports — e.g. AUD/CAD → 1.34567, CAD/JPY → 97.123.
 *
 * ✅ Examples:
 *   formatPairPrice(1.3456789, "AUD/CAD") → "1.34568"
 *   formatPairPrice(97.12345, "CAD/JPY")  → "97.123"
 *   formatPairPrice(null, "AUD/USD")      → "--"
 *
 * @param value - The raw price value
 * @param symbol - OTC pair symbol used to resolve decimal precision
 * @param fallback - Fallback string if value is invalid (default: "--")
 */
export function formatPairPrice(
  value: SafeNumber,
  symbol?: string | null,
  fallback = "--",
): string {
  const num = toFinite(value);
  if (num === 0 && value !== 0 && value !== "0") return fallback;
  const digits = getPairDigits(symbol ?? "");
  return num.toFixed(digits);
}

// ════════════════════════════════════════════════════════════════════
// LOCAL-TIMEZONE TIMESTAMP FORMATTING (GMT+1 / any system zone)
// ════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS:
//  • `.toLocaleTimeString()` / `.toLocaleString()` vary with the BROWSER
//    locale (12h vs 24h, "08:20:11" vs "8:20:11 AM") → non-deterministic
//    markup and a latent hydration hazard.
//  • lightweight-charts and the backend speak UTC — rendering raw epoch
//    strings showed 07:20 while the operator's GMT+1 clock read 08:20.
//
// These helpers render the user's LOCAL SYSTEM timezone (auto-detected from
// the OS — e.g. GMT+1 Casablanca) with a fixed deterministic 24-hour
// "HH:MM:SS" layout. Locale-free, zero external deps, always aligned with
// the system clock. Use inside ClientOnly / post-mount boundaries.

function toSafeDate(
  value: Date | string | number | null | undefined,
): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Local wall-clock time — deterministic 24h "HH:MM:SS" in the system timezone.
 * NEVER uses UTC and NEVER varies with browser locale.
 *
 * ✅ Examples (system TZ = GMT+1, input = 07:20:11 UTC):
 *   formatLocalTime("2026-08-28T07:20:11Z") → "08:20:11"
 *   formatLocalTime(null)                   → "--"
 */
export function formatLocalTime(
  value: Date | string | number | null | undefined,
  fallback = "--",
): string {
  const d = toSafeDate(value);
  if (!d) return fallback;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Local date + time — deterministic "DD/MM HH:MM:SS" in the system timezone.
 * NEVER uses UTC and NEVER varies with browser locale.
 *
 * ✅ Examples (system TZ = GMT+1):
 *   formatLocalDateTime("2026-08-28T07:20:11Z") → "28/08 08:20:11"
 *   formatLocalDateTime("garbage")              → "--"
 */
export function formatLocalDateTime(
  value: Date | string | number | null | undefined,
  fallback = "--",
): string {
  const d = toSafeDate(value);
  if (!d) return fallback;
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mo} ${formatLocalTime(d)}`;
}
