import { isPocketOptionSource } from "./quoteProvenance";

/**
 * tradeJournal.ts — PART 50 TRADE TRACKER (Pocket-style start/end).
 *
 * A LOCAL paper journal, not an execution path. The two recorder buttons let
 * an operator say "I took CALL/PUT on PO at this instant" and nothing is ever
 * sent to Pocket Option ([535]): no broker call, no order, no websocket
 * command. It is a stopwatch + a scoreboard.
 *
 * The whole module is PURE (no React, no I/O) so the honesty rules that make
 * the tracker trustworthy are unit-testable:
 *
 *   • [535] the buttons are enabled iff a LIVE PO tick exists — never a stale
 *     print, never a market proxy, and INDEPENDENT of the AI gate.
 *   • [536] an entry is recorded on the BROKER/TICK clock, its price is the
 *     last PO tick, and it snapshots the gate for provenance only.
 *   • [537] settlement is the last PO tick with `ts <= expiry`; the first tick
 *     AFTER expiry is NEVER used. An exact tie refunds (VOID).
 *   • [538] stats carry a Wilson interval and an "n < 30: not meaningful"
 *     guard, split by gate state.
 *   • [540] the tracker is a journal, not a signal: `impliesSignal` is
 *     hard-coded false and marker geometry is computed without consulting the
 *     target gate.
 */

export type JournalSide = "CALL" | "PUT";
export type JournalStatus = "OPEN" | "WIN" | "LOSS" | "VOID";

/** A genuine broker/tick print. `tsMs` is the BROKER/tick clock, not wall time. */
export interface JournalTick {
  symbol: string;
  price: number;
  tsMs: number;
  /** Authoring feed, e.g. "pocket_option_ssot:live". */
  source: string;
  /** Backend latch: a held/carried print that is not a current market price. */
  stale?: boolean;
}

/** Gate context captured at press time — CONTEXT, never a claim of a signal. */
export interface JournalGateSnapshot {
  regimeGate: string | null;
  tier: string | null;
  executable: boolean;
  suppressedReason: string | null;
  bookAgreement: { aligned: number; active: number } | null;
  signal: "BUY" | "SELL" | null;
}

export interface JournalEntry {
  id: string;
  symbol: string;
  side: JournalSide;
  /** Entry instant on the broker/tick clock (ms epoch of the PO tick). */
  entryTs: number;
  /** Last live PO tick price at press time. */
  entryPrice: number;
  durationSec: number;
  /** entryTs + durationSec * 1000 — the expiry boundary. */
  expiryTs: number;
  gate: JournalGateSnapshot;
  status: JournalStatus;
  settlementPrice: number | null;
  settlementTs: number | null;
  /** Why a settlement is VOID (no tick, tie, …), else null. */
  voidReason: string | null;
  provenance: {
    entrySource: string;
    settlementSource: string | null;
  };
  /** [540] HARD-CODED false: a journal entry never implies a signal existed. */
  impliesSignal: false;
}

export const JOURNAL_NO_BROKER_NOTICE =
  "Journal — nothing is sent to Pocket Option.";

/** A PO tick older than this (in broker/tick clock terms) is not live. */
export const JOURNAL_MAX_TICK_AGE_MS = 2_000;

/** Minimum resolved sample before a win rate means anything ([538]). */
export const JOURNAL_MEANINGFUL_MIN_N = 30;

export type JournalErrorCode =
  | "NO_LIVE_PO_TICK"
  | "ENTRY_PRICE_NOT_PO"
  | "INVALID_DURATION"
  | "INVALID_SIDE";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * A tick is a live PO tick iff it is a genuine Pocket Option print, not a
 * held/stale latch, carries a real positive price + finite tick-clock stamp,
 * and its age is inside the freshness bound.
 */
export function isLivePoTick(
  tick: JournalTick | null | undefined,
  nowMs: number,
  maxAgeMs: number = JOURNAL_MAX_TICK_AGE_MS,
): boolean {
  if (!tick) return false;
  if (!isPocketOptionSource(tick.source)) return false;
  if (tick.stale === true) return false;
  if (!isFinitePositive(tick.price)) return false;
  if (!Number.isFinite(tick.tsMs) || tick.tsMs <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - tick.tsMs;
  // Small negative ages are tolerated (clock skew between feed and browser);
  // a large negative age means the ts is in the future — not a live print.
  return ageMs >= -1_000 && ageMs <= maxAgeMs;
}

/**
 * [535] Journal recorder gate. Independent of the AI gate/regime/tier: a live
 * PO tick is the ONLY precondition, so an operator can journal a trade the
 * engine withheld (and the stats split by gate state keeps that honest).
 */
export function journalEnabled(
  tick: JournalTick | null | undefined,
  nowMs: number,
  maxAgeMs: number = JOURNAL_MAX_TICK_AGE_MS,
): boolean {
  return isLivePoTick(tick, nowMs, maxAgeMs);
}

export interface OpenJournalInput {
  tick: JournalTick | null | undefined;
  side: JournalSide;
  durationSec: number;
  gate: JournalGateSnapshot;
  nowMs: number;
  maxAgeMs?: number;
  /** Injectable id (tests); defaults to a deterministic tick-clock id. */
  id?: string;
}

/**
 * [535]/[536] Record an entry. Throws `JournalError` when the precondition is
 * violated — a non-PO / stale tick can never become an entry price, which is
 * the mutation guard [539] pins.
 */
export function openJournalEntry(input: OpenJournalInput): JournalEntry {
  const { tick, side, durationSec, gate, nowMs } = input;
  if (side !== "CALL" && side !== "PUT") {
    throw new JournalError("INVALID_SIDE", `Invalid side: ${String(side)}`);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new JournalError(
      "INVALID_DURATION",
      `Invalid duration: ${String(durationSec)}`,
    );
  }
  if (!isLivePoTick(tick, nowMs, input.maxAgeMs)) {
    // Distinguish a non-PO tick from the generic "no live tick" so the
    // mutation test [539] names the exact failure.
    if (tick && !isPocketOptionSource(tick.source)) {
      throw new JournalError(
        "ENTRY_PRICE_NOT_PO",
        "Entry price must come from a live Pocket Option tick.",
      );
    }
    throw new JournalError(
      "NO_LIVE_PO_TICK",
      "No live Pocket Option tick — journal recorder disabled.",
    );
  }
  const live = tick as JournalTick;
  const entryTs = live.tsMs;
  return {
    id: input.id ?? `journal_${entryTs}_${side}`,
    symbol: live.symbol,
    side,
    entryTs,
    entryPrice: live.price,
    durationSec,
    expiryTs: entryTs + Math.round(durationSec * 1000),
    gate,
    status: "OPEN",
    settlementPrice: null,
    settlementTs: null,
    voidReason: null,
    provenance: { entrySource: live.source, settlementSource: null },
    impliesSignal: false,
  };
}

/**
 * [537] Pick the settlement tick: the LAST PO tick whose broker-clock stamp is
 * at or before expiry. The tick that lands first AFTER expiry is deliberately
 * invisible to this function — using it is the "settle on the next print" bug
 * the mutation suite [539] rejects.
 */
export function resolveSettlementTick(
  entry: Pick<JournalEntry, "expiryTs">,
  ticks: readonly JournalTick[],
): JournalTick | null {
  let best: JournalTick | null = null;
  for (const t of ticks) {
    if (!isPocketOptionSource(t.source)) continue;
    if (t.stale === true) continue;
    if (!Number.isFinite(t.price) || t.price <= 0) continue;
    if (!Number.isFinite(t.tsMs)) continue;
    if (t.tsMs > entry.expiryTs) continue; // never the first tick after expiry
    if (best === null || t.tsMs > best.tsMs) best = t;
  }
  return best;
}

export interface JournalSettlement {
  status: JournalStatus;
  settlementPrice: number | null;
  settlementTs: number | null;
  settlementSource: string | null;
  voidReason: string | null;
}

/**
 * [537] Settle an entry.
 *
 *   • now < expiry                 → remains OPEN (nothing to settle yet).
 *   • now >= expiry, no tick ≤ exp → VOID("no_settlement_tick").
 *   • exact tie (settle == entry)  → VOID("tie") — the stake is returned and
 *     the result is excluded from the win rate (the tie rule, stated).
 *   • otherwise WIN/LOSS by side.
 */
export function settleEntry(
  entry: JournalEntry,
  ticks: readonly JournalTick[],
  nowMs: number,
): JournalSettlement {
  if (nowMs < entry.expiryTs) {
    return {
      status: "OPEN",
      settlementPrice: null,
      settlementTs: null,
      settlementSource: null,
      voidReason: null,
    };
  }
  const tick = resolveSettlementTick(entry, ticks);
  if (!tick) {
    return {
      status: "VOID",
      settlementPrice: null,
      settlementTs: null,
      settlementSource: null,
      voidReason: "no_settlement_tick",
    };
  }
  if (tick.price === entry.entryPrice) {
    return {
      status: "VOID",
      settlementPrice: tick.price,
      settlementTs: tick.tsMs,
      settlementSource: tick.source,
      voidReason: "tie",
    };
  }
  const above = tick.price > entry.entryPrice;
  const won = entry.side === "CALL" ? above : !above;
  return {
    status: won ? "WIN" : "LOSS",
    settlementPrice: tick.price,
    settlementTs: tick.tsMs,
    settlementSource: tick.source,
    voidReason: null,
  };
}

/** Apply a settlement to an entry, producing the settled row (immutably). */
export function applySettlement(
  entry: JournalEntry,
  ticks: readonly JournalTick[],
  nowMs: number,
): JournalEntry {
  const s = settleEntry(entry, ticks, nowMs);
  if (s.status === "OPEN" && entry.status !== "OPEN") return entry;
  return {
    ...entry,
    status: s.status,
    settlementPrice: s.settlementPrice,
    settlementTs: s.settlementTs,
    voidReason: s.voidReason,
    provenance: {
      ...entry.provenance,
      settlementSource: s.settlementSource,
    },
  };
}

// ── Marker geometry ([536]/[540]) ─────────────────────────────────────────

export interface JournalMarkerGeometry {
  entryTs: number;
  strikePrice: number;
  expiryTs: number;
  /** Candle index containing the entry instant, or -1 when off-chart. */
  entryCandleIndex: number;
  /**
   * Candle index containing the expiry boundary. The candle whose half-open
   * interval [start, start+bucket) contains expiry — NOT the candle after it.
   */
  expiryCandleIndex: number;
  /** Seconds until expiry (0 once elapsed). */
  countdownSec: number;
  /** Live above/below strike — null before any live price is supplied. */
  aboveStrike: boolean | null;
}

/** Index of the candle whose [start, start+bucket) window contains tsMs. */
export function candleIndexFor(
  candles: readonly { timestamp: number }[],
  bucketMs: number,
  tsMs: number,
): number {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return -1;
  for (let i = 0; i < candles.length; i++) {
    const start = candles[i].timestamp;
    if (tsMs >= start && tsMs < start + bucketMs) return i;
  }
  return -1;
}

/**
 * [536] Geometry for the ENTRY dot, STRIKE line and EXPIRY vertical line.
 *
 * `[540]` computed from the entry + candles ALONE: it never reads
 * `targetZoneEnabled`, so a tracker marker draws exactly as well on a
 * withheld tape as on a tradable one — and it can never imply a signal.
 */
export function journalMarkerGeometry(
  entry: JournalEntry,
  candles: readonly { timestamp: number }[],
  bucketMs: number,
  nowMs: number,
  livePrice?: number | null,
): JournalMarkerGeometry {
  const countdownSec = Math.max(0, (entry.expiryTs - nowMs) / 1000);
  return {
    entryTs: entry.entryTs,
    strikePrice: entry.entryPrice,
    expiryTs: entry.expiryTs,
    entryCandleIndex: candleIndexFor(candles, bucketMs, entry.entryTs),
    expiryCandleIndex: candleIndexFor(candles, bucketMs, entry.expiryTs),
    countdownSec,
    aboveStrike:
      typeof livePrice === "number" && Number.isFinite(livePrice)
        ? livePrice > entry.entryPrice
        : null,
  };
}

// ── Statistics ([538]) ────────────────────────────────────────────────────

export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion at the given z (default
 * 1.96 ≈ 95%). Returns [0,0] for an empty sample.
 */
export function wilsonInterval(
  wins: number,
  n: number,
  z = 1.96,
): WilsonInterval {
  if (!Number.isFinite(n) || n <= 0) return { low: 0, high: 0 };
  const w = Math.max(0, Math.min(n, wins));
  const phat = w / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const low = (center - margin) / denom;
  const high = (center + margin) / denom;
  return {
    low: Math.max(0, Math.round(low * 10_000) / 10_000),
    high: Math.min(1, Math.round(high * 10_000) / 10_000),
  };
}

export interface JournalBucketStats {
  total: number;
  resolved: number;
  wins: number;
  losses: number;
  voids: number;
  open: number;
  winRate: number | null;
  wilson: WilsonInterval;
  /** [538] false until at least JOURNAL_MEANINGFUL_MIN_N resolved rows. */
  meaningful: boolean;
}

export interface JournalStats {
  total: number;
  resolved: number;
  wins: number;
  losses: number;
  voids: number;
  open: number;
  winRate: number | null;
  wilson: WilsonInterval;
  meaningful: boolean;
  byGateState: { tradable: JournalBucketStats; withheld: JournalBucketStats };
}

function emptyBucket(): JournalBucketStats {
  return {
    total: 0,
    resolved: 0,
    wins: 0,
    losses: 0,
    voids: 0,
    open: 0,
    winRate: null,
    wilson: { low: 0, high: 0 },
    meaningful: false,
  };
}

function tallyBucket(entries: readonly JournalEntry[]): JournalBucketStats {
  const bucket = emptyBucket();
  bucket.total = entries.length;
  for (const e of entries) {
    if (e.status === "WIN") bucket.wins += 1;
    else if (e.status === "LOSS") bucket.losses += 1;
    else if (e.status === "VOID") bucket.voids += 1;
    else bucket.open += 1;
  }
  // Ties/voids are excluded from the win rate denominator: a refund is not a
  // loss, and counting it as one would libel the track record.
  bucket.resolved = bucket.wins + bucket.losses;
  bucket.winRate =
    bucket.resolved > 0 ? bucket.wins / bucket.resolved : null;
  bucket.wilson = wilsonInterval(bucket.wins, bucket.resolved);
  bucket.meaningful = bucket.resolved >= JOURNAL_MEANINGFUL_MIN_N;
  return bucket;
}

/** Gate state of an entry: tradable only when the engine cleared it. */
export function journalGateState(
  entry: JournalEntry,
): "tradable" | "withheld" {
  return entry.gate.executable && entry.gate.regimeGate === "tradable"
    ? "tradable"
    : "withheld";
}

/**
 * [538] Count, win rate with a Wilson interval, split by gate state (withheld
 * vs tradable). `meaningful` is false until 30 resolved rows in a bucket.
 */
export function computeJournalStats(
  entries: readonly JournalEntry[],
): JournalStats {
  const overall = tallyBucket(entries);
  const tradable = tallyBucket(
    entries.filter((e) => journalGateState(e) === "tradable"),
  );
  const withheld = tallyBucket(
    entries.filter((e) => journalGateState(e) === "withheld"),
  );
  return {
    total: overall.total,
    resolved: overall.resolved,
    wins: overall.wins,
    losses: overall.losses,
    voids: overall.voids,
    open: overall.open,
    winRate: overall.winRate,
    wilson: overall.wilson,
    meaningful: overall.meaningful,
    byGateState: { tradable, withheld },
  };
}

// ── CSV export ([538]) ────────────────────────────────────────────────────

const CSV_HEADER = [
  "id",
  "symbol",
  "side",
  "entry_ts",
  "entry_price",
  "duration_sec",
  "expiry_ts",
  "status",
  "settlement_price",
  "settlement_ts",
  "gate_state",
  "regime_gate",
  "tier",
  "executable",
  "suppressed_reason",
  "book_agreement",
  "signal",
  "entry_source",
  "settlement_source",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** [538] Pure CSV serialization of the journal (RFC-4180 quoting). */
export function journalEntriesToCsv(entries: readonly JournalEntry[]): string {
  const rows = entries.map((e) =>
    [
      e.id,
      e.symbol,
      e.side,
      new Date(e.entryTs).toISOString(),
      e.entryPrice,
      e.durationSec,
      new Date(e.expiryTs).toISOString(),
      e.status,
      e.settlementPrice,
      e.settlementTs === null ? null : new Date(e.settlementTs).toISOString(),
      journalGateState(e),
      e.gate.regimeGate,
      e.gate.tier,
      e.gate.executable,
      e.gate.suppressedReason,
      e.gate.bookAgreement
        ? `${e.gate.bookAgreement.aligned}/${e.gate.bookAgreement.active}`
        : null,
      e.gate.signal,
      e.provenance.entrySource,
      e.provenance.settlementSource,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_HEADER.map(csvCell).join(","), ...rows].join("\r\n");
}
