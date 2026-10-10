/**
 * marketSchedule.ts — PART 42.1 [420] FOREX-WEEK SCHEDULE
 *
 * The retail forex week runs from Sunday 17:00 to Friday 17:00 New York time.
 * This is DERIVED FROM THE IANA TIMEZONE DATABASE via `Intl.DateTimeFormat`
 * with `timeZone: "America/New_York"` — never a hard-coded UTC offset — so the
 * Friday/Sunday 17:00 boundary tracks US daylight-saving transitions
 * automatically (17:00 ET is 22:00 UTC in US winter, 21:00 UTC in US summer).
 *
 * Provider confirmation (the schedule must agree with the feeds we poll):
 *   • Yahoo Finance intraday forex (`YAHOO_CHART_BASE`) — the source behind the
 *     10 REAL pairs — prints its final 1-minute bar at the weekly close and
 *     resumes when the market reopens Sunday 17:00 ET.
 *   • Frankfurter / ECB reference rates publish on TARGET business days only —
 *     no Saturday or Sunday prints.
 *   • open.er-api.com refreshes once per day and its weekend quote is a
 *     carried-forward value, never a fresh weekend tick.
 * All three corroborate the Sun 17:00 → Fri 17:00 (New York) window below.
 *
 * SCOPE — REAL pairs only. This helper is symbol-agnostic on purpose; callers
 * must apply it ONLY to REAL instruments (assetSubType "forex"). OTC
 * instruments and crypto are broker-quoted 24/7 and are NEVER marked closed by
 * it. The authoritative classifier is `symbolRegistry.getAssetSubType`.
 *
 * Not modelled: exchange holidays / ad-hoc halts. Those are day-level gaps the
 * data providers surface as absent prints, not as an error loop — the caller's
 * held/"last close" path already covers them.
 *
 * PURE — no I/O, no clock reads. Every entry point takes the instant to test.
 */

export const FOREX_MARKET_TIME_ZONE = "America/New_York";

/** The weekly cycle opens Sunday 17:00 and closes Friday 17:00 (New York). */
export const FOREX_WEEK_OPEN_WEEKDAY = 0; // Sunday
export const FOREX_WEEK_OPEN_HOUR = 17;
export const FOREX_WEEK_CLOSE_WEEKDAY = 5; // Friday
export const FOREX_WEEK_CLOSE_HOUR = 17;

/** Sunday..Saturday, matching `Intl` weekday abbreviations. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// One formatter instance — `Intl` construction is the expensive part, and this
// runs on the 1 Hz-per-symbol poll path.
const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: FOREX_MARKET_TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface ForexWeekState {
  /** True when the REAL forex week is closed at the instant sampled. */
  closed: boolean;
  /** New York wall-clock weekday (0=Sun … 6=Sat), for diagnostics/tests. */
  nyWeekday: number;
  /** New York wall-clock hour (0–23). */
  nyHour: number;
  /** New York wall-clock minute (0–59). */
  nyMinute: number;
}

/** New York wall-clock weekday/hour/minute for an instant (DST-correct). */
export function newYorkForexParts(atMs: number): {
  weekday: number;
  hour: number;
  minute: number;
} {
  const parts = NY_PARTS.formatToParts(new Date(atMs));
  const value = (type: "weekday" | "hour" | "minute"): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAY_INDEX[value("weekday")] ?? 0,
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")) % 60,
  };
}

/** The forex-week state at `atMs`. This is the hot-path entry point. */
export function forexWeekState(atMs: number): ForexWeekState {
  const { weekday, hour, minute } = newYorkForexParts(atMs);
  const minutesOfDay = hour * 60 + minute;
  const openMinutes = FOREX_WEEK_OPEN_HOUR * 60;
  const closeMinutes = FOREX_WEEK_CLOSE_HOUR * 60;

  let closed = false;
  if (weekday === 6) {
    // Saturday — closed for the whole day.
    closed = true;
  } else if (weekday === FOREX_WEEK_OPEN_WEEKDAY && minutesOfDay < openMinutes) {
    // Sunday before 17:00 ET — still in the weekend gap.
    closed = true;
  } else if (weekday === FOREX_WEEK_CLOSE_WEEKDAY && minutesOfDay >= closeMinutes) {
    // Friday from 17:00 ET — the week has ended.
    closed = true;
  }

  return { closed, nyWeekday: weekday, nyHour: hour, nyMinute: minute };
}

/** True when the REAL forex market is closed at `atMs` (defaults to now). */
export function isForexMarketClosed(atMs: number = Date.now()): boolean {
  return forexWeekState(atMs).closed;
}

/** True when the REAL forex market is open at `atMs` (defaults to now). */
export function isForexMarketOpen(atMs: number = Date.now()): boolean {
  return !isForexMarketClosed(atMs);
}

/**
 * Epoch ms of the next re-open after `atMs` (or `atMs` itself when already
 * open). Minute-resolution forward scan — deliberately simple and exact against
 * the same predicate; it is NOT on the poll hot path (only used for logs/tests).
 */
export function nextForexMarketOpenMs(atMs: number): number {
  if (isForexMarketOpen(atMs)) return atMs;
  // Start at the next whole minute so a boundary instant is never skipped.
  let t = (Math.floor(atMs / 60_000) + 1) * 60_000;
  const maxMinutes = 8 * 24 * 60; // bounded scan (weekend + margin)
  for (let i = 0; i < maxMinutes; i += 1) {
    if (!forexWeekState(t).closed) return t;
    t += 60_000;
  }
  return t;
}
