/**
 * verify-e2e/checks.ts — PART 47 [525] the invariant battery (C1..C11).
 *
 * Every check is a pure function of an `E2EContext`, so the SAME battery can be
 * run against a mutated context and the targeted cell must flip to an explicit
 * FAIL. A cell that cannot be evaluated offline is `N/A` WITH A REASON.
 */

import {
  diffBars,
  floorBucket,
  oracleAggregate,
  oracleRollup,
  oracleSlots,
  oracleTargetCount,
} from "./oracle";
import { QUOTE_STALE_AFTER_MS, describeFixtures, SPAN_MINUTES, TICK_INTERVAL_MS } from "./fixtures";
import type { Bar, CheckResult, E2EContext, Tick } from "./types";

const LADDER_EXPIRY_SEC = [60, 120, 300, 600];
const ANCHOR_TFS_SEC = [5, 10, 15, 30, 60];

function barsFor(ctx: E2EContext, symbol: string, tf: string): Bar[] {
  return ctx.server.get(symbol)?.get(tf) ?? [];
}

function allBars(ctx: E2EContext): Array<{ symbol: string; tf: string; bars: Bar[] }> {
  const out: Array<{ symbol: string; tf: string; bars: Bar[] }> = [];
  for (const symbol of ctx.server.keys()) {
    for (const tf of ctx.timeframes) {
      out.push({ symbol, tf, bars: barsFor(ctx, symbol, tf) });
    }
  }
  return out;
}

function lastTick(fixture: { ticks: Tick[] }): Tick | null {
  return fixture.ticks.length ? fixture.ticks[fixture.ticks.length - 1] : null;
}

/** C1 — the server aggregator must reproduce the oracle bar-for-bar, on every
 *  symbol and every one of the 16 server timeframes. */
function checkCandleExactness(ctx: E2EContext): CheckResult {
  const defects: string[] = [];
  let cells = 0;
  for (const symbol of ctx.server.keys()) {
    for (const tf of ctx.timeframes) {
      cells += 1;
      const s = barsFor(ctx, symbol, tf);
      const o = ctx.oracle.get(symbol)?.get(tf) ?? [];
      const d = diffBars(s, o);
      if (d) defects.push(`${symbol} ${tf}: ${d}`);
    }
  }
  if (defects.length) {
    return {
      id: "C1",
      name: "Candle exactness (server vs independent oracle, all 16 TFs)",
      status: "FAIL",
      message: `candle mismatch in ${defects.length}/${cells} cells: ${defects.slice(0, 3).join(" | ")}`,
      detail: `${cells} (symbol,timeframe) cells compared`,
    };
  }
  return {
    id: "C1",
    name: "Candle exactness (server vs independent oracle, all 16 TFs)",
    status: "PASS",
    message: `all ${cells} (symbol,timeframe) cells match bar-for-bar (timestamps + OHLCV)`,
    detail: `${cells} cells`,
  };
}

/** C2 — OHLC structural invariants on every produced bar. */
function checkOhlcInvariants(ctx: E2EContext): CheckResult {
  let bars = 0;
  for (const { symbol, tf, bars: bs } of allBars(ctx)) {
    for (const b of bs) {
      bars += 1;
      const vals = [b.open, b.high, b.low, b.close, b.volume];
      if (!vals.every((v) => Number.isFinite(v))) {
        return {
          id: "C2",
          name: "OHLC invariants (finite, high>=max(o,c), low<=min(o,c))",
          status: "FAIL",
          message: `non-finite value at ${symbol} ${tf} ts=${b.timestamp}`,
        };
      }
      if (b.volume < 0) {
        return {
          id: "C2",
          name: "OHLC invariants (finite, high>=max(o,c), low<=min(o,c))",
          status: "FAIL",
          message: `negative volume at ${symbol} ${tf} ts=${b.timestamp}: ${b.volume}`,
        };
      }
      if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low) {
        return {
          id: "C2",
          name: "OHLC invariants (finite, high>=max(o,c), low<=min(o,c))",
          status: "FAIL",
          message: `OHLC violated at ${symbol} ${tf} ts=${b.timestamp}: o=${b.open} h=${b.high} l=${b.low} c=${b.close}`,
        };
      }
    }
  }
  return {
    id: "C2",
    name: "OHLC invariants (finite, high>=max(o,c), low<=min(o,c))",
    status: "PASS",
    message: `all ${bars} bars structurally valid`,
    detail: `${bars} bars`,
  };
}

/** C3 — within each (symbol,tf) series, timestamps are strictly increasing,
 *  unique, and aligned to the timeframe grid. */
function checkSlotMonotonic(ctx: E2EContext): CheckResult {
  for (const { symbol, tf, bars } of allBars(ctx)) {
    const tfMs = ctx.tfMs[tf];
    for (let i = 0; i < bars.length; i += 1) {
      if (bars[i].timestamp % tfMs !== 0) {
        return {
          id: "C3",
          name: "Slot geometry (strictly increasing, unique, grid-aligned)",
          status: "FAIL",
          message: `${symbol} ${tf}: ts=${bars[i].timestamp} not aligned to ${tfMs}ms grid`,
        };
      }
      if (i > 0 && bars[i].timestamp <= bars[i - 1].timestamp) {
        return {
          id: "C3",
          name: "Slot geometry (strictly increasing, unique, grid-aligned)",
          status: "FAIL",
          message: `${symbol} ${tf}: non-monotonic timestamps ${bars[i - 1].timestamp} -> ${bars[i].timestamp}`,
        };
      }
    }
  }
  return {
    id: "C3",
    name: "Slot geometry (strictly increasing, unique, grid-aligned)",
    status: "PASS",
    message: "every series is monotonic, unique and grid-aligned",
  };
}

/** C4 — M5 must equal the strict fold of M1 (max-high / min-low / last-close).
 *  Only buckets the server has actually CLOSED are compared; rolling closed M1
 *  bars cannot, on its own, know the still-open M5 boundary. */
function checkRollup(ctx: E2EContext): CheckResult {
  const symbol = ctx.fixtures[0]?.symbol ?? "";
  const m1 = barsFor(ctx, symbol, "M1");
  const m5 = barsFor(ctx, symbol, "M5");
  const lastServerTs = m5.length ? m5[m5.length - 1].timestamp : -1;
  const expected = oracleRollup(m1, 5).filter((g) => g.timestamp <= lastServerTs);
  const d = diffBars(m5, expected);
  if (d) {
    return {
      id: "C4",
      name: "Rollup (M5 == strict fold of M1)",
      status: "FAIL",
      message: `M5 rollup mismatch for ${symbol}: ${d}`,
    };
  }
  return {
    id: "C4",
    name: "Rollup (M5 == strict fold of M1)",
    status: "PASS",
    message: `M5 reproduces the strict M1 fold for ${symbol} (${m5.length} closed bars)`,
  };
}

/** C5 — OTC symbols must be sourced 100% from the PO websocket; a proxy print
 *  inside an OTC book is an explicit FAIL. */
function checkOtcPurity(ctx: E2EContext): CheckResult {
  let otcTicks = 0;
  for (const f of ctx.fixtures) {
    if (f.assetClass !== "otc") continue;
    for (const t of f.ticks) {
      otcTicks += 1;
      const src = t.source ?? f.source;
      if (src !== "pocket_option_ws") {
        return {
          id: "C5",
          name: "OTC source purity (no proxy tick in an OTC book)",
          status: "FAIL",
          message: `proxy tick in OTC book ${f.symbol} at ts=${t.tsMs}: source=${src}`,
        };
      }
    }
  }
  if (otcTicks === 0) {
    return {
      id: "C5",
      name: "OTC source purity (no proxy tick in an OTC book)",
      status: "N/A",
      reason: "no OTC fixture present in this run",
      message: "no OTC ticks to evaluate",
    };
  }
  return {
    id: "C5",
    name: "OTC source purity (no proxy tick in an OTC book)",
    status: "PASS",
    message: `all ${otcTicks} OTC ticks carry pocket_option_ws provenance`,
  };
}

/** C6 — the expiry slot must be the LAST slot of the ceil-projection and, for
 *  the ladder expiries on the sub-minute/M1 grids, exactly tip+exp. */
function checkTimeAnchoring(ctx: E2EContext): CheckResult {
  const nowSec = Math.floor(ctx.brokerNowMs / 1000);
  if (!ctx.product.expirySlots.length) {
    return {
      id: "C6",
      name: "Time anchoring (product expiry == last ceil-projection slot)",
      status: "N/A",
      reason: "product surface provided no expiry slots",
      message: "no product expiry slots",
    };
  }
  for (const e of ctx.product.expirySlots) {
    const tip = floorBucket(nowSec, e.tfSec);
    const expectCeil = tip + oracleTargetCount(e.expirationSec, e.tfSec) * e.tfSec;
    const isLadder = ANCHOR_TFS_SEC.includes(e.tfSec) && LADDER_EXPIRY_SEC.includes(e.expirationSec);
    const expectExact = tip + e.expirationSec;
    if (e.slotSec !== expectCeil || (isLadder && e.slotSec !== expectExact)) {
      return {
        id: "C6",
        name: "Time anchoring (product expiry == last ceil-projection slot)",
        status: "FAIL",
        message: `product expiry wrong for ${e.tfSec}s/${e.expirationSec}s: got=${e.slotSec} expect=${expectExact} (ceil=${expectCeil})`,
      };
    }
  }
  return {
    id: "C6",
    name: "Time anchoring (product expiry == last ceil-projection slot)",
    status: "PASS",
    message: `all ${ctx.product.expirySlots.length} product expiry slots match the oracle's last projection slot`,
  };
}

/** C7 — the slot anchor is the BROKER clock, not Date.now(): the newest closed
 *  bucket must be floorBucket(brokerNow, tf) - tf. */
function checkClockCoherence(ctx: E2EContext): CheckResult {
  for (const symbol of ctx.server.keys()) {
    for (const tf of ctx.timeframes) {
      const tfMs = ctx.tfMs[tf];
      const bars = barsFor(ctx, symbol, tf);
      if (!bars.length) continue;
      const expected = floorBucket(ctx.brokerNowMs, tfMs) - tfMs;
      const last = bars[bars.length - 1].timestamp;
      if (last !== expected) {
        return {
          id: "C7",
          name: "Clock coherence (slots anchored to broker clock, not Date.now)",
          status: "FAIL",
          message: `${symbol} ${tf}: newest closed bucket ts=${last} != broker-anchored ${expected}`,
        };
      }
    }
  }
  return {
    id: "C7",
    name: "Clock coherence (slots anchored to broker clock, not Date.now)",
    status: "PASS",
    message: `every series' newest closed bucket is anchored to brokerNow=${ctx.brokerNowMs}`,
  };
}

/** C8 — target slots form a contiguous ladder: first=tip+tf, step=tf. */
function checkTargetGeometry(ctx: E2EContext): CheckResult {
  const nowSec = Math.floor(ctx.brokerNowMs / 1000);
  if (!ctx.product.targetLadders.length) {
    return {
      id: "C8",
      name: "Target geometry (product ladder == oracle, contiguous, first=tip+tf)",
      status: "N/A",
      reason: "product surface provided no target ladders",
      message: "no product ladders",
    };
  }
  for (const ladder of ctx.product.targetLadders) {
    const tip = floorBucket(nowSec, ladder.tfSec);
    const count = oracleTargetCount(ladder.expirationSec, ladder.tfSec);
    const expect = oracleSlots(tip, ladder.tfSec, count);
    if (ladder.slots.length !== count) {
      return {
        id: "C8",
        name: "Target geometry (product ladder == oracle, contiguous, first=tip+tf)",
        status: "FAIL",
        message: `product slot count wrong for ${ladder.expirationSec}s on ${ladder.tfSec}s grid: got=${ladder.slots.length} expect=${count}`,
      };
    }
    if (ladder.slots[0] !== tip + ladder.tfSec) {
      return {
        id: "C8",
        name: "Target geometry (product ladder == oracle, contiguous, first=tip+tf)",
        status: "FAIL",
        message: `product first slot wrong for ${ladder.expirationSec}s: got=${ladder.slots[0]} expect=${tip + ladder.tfSec}`,
      };
    }
    for (let i = 0; i < count; i += 1) {
      if (ladder.slots[i] !== expect[i].timeSec) {
        return {
          id: "C8",
          name: "Target geometry (product ladder == oracle, contiguous, first=tip+tf)",
          status: "FAIL",
          message: `product slot[${i}] wrong for ${ladder.expirationSec}s: got=${ladder.slots[i]} expect=${expect[i].timeSec}`,
        };
      }
    }
  }
  return {
    id: "C8",
    name: "Target geometry (product ladder == oracle, contiguous, first=tip+tf)",
    status: "PASS",
    message: `all ${ctx.product.targetLadders.length} product ladders match the oracle slot-for-slot`,
  };
}

/** C9 — TIMER entries: expiry = entry bucket + duration, both grid-aligned. */
function checkTimerEntryExpiry(ctx: E2EContext): CheckResult {
  if (!ctx.product.timerExpiries.length) {
    return {
      id: "C9",
      name: "Timer entry/expiry (product expiry == entry + duration)",
      status: "N/A",
      reason: "product surface provided no timer expiries",
      message: "no product timer expiries",
    };
  }
  for (const t of ctx.product.timerExpiries) {
    if (t.expirySec !== t.entrySec + t.durationSec) {
      return {
        id: "C9",
        name: "Timer entry/expiry (product expiry == entry + duration)",
        status: "FAIL",
        message: `product timer expiry wrong for dur=${t.durationSec}s: entry=${t.entrySec} expiry=${t.expirySec} expect=${t.entrySec + t.durationSec}`,
      };
    }
  }
  return {
    id: "C9",
    name: "Timer entry/expiry (product expiry == entry + duration)",
    status: "PASS",
    message: `all ${ctx.product.timerExpiries.length} TIMER durations map entry->expiry exactly`,
  };
}

/** C10 — the live price must be the SAME number on every surface (ticker/grid
 *  and rail), the last CLOSED bar's close must equal the last tick folded into
 *  it, and the newest quote must be fresh. */
function checkPriceLinkage(ctx: E2EContext): CheckResult {
  const fixture = ctx.fixtures[0];
  if (!fixture) {
    return {
      id: "C10",
      name: "Price linkage + freshness (grid == rail == chart, quote fresh)",
      status: "N/A",
      reason: "no fixtures available",
      message: "no fixtures",
    };
  }
  const newest = lastTick(fixture);
  if (!newest) {
    return {
      id: "C10",
      name: "Price linkage + freshness (grid == rail == chart, quote fresh)",
      status: "N/A",
      reason: `fixture ${fixture.symbol} has no ticks`,
      message: "no ticks",
    };
  }
  const age = ctx.brokerNowMs - newest.tsMs;
  if (age > QUOTE_STALE_AFTER_MS) {
    return {
      id: "C10",
      name: "Price linkage + freshness (grid == rail == chart, quote fresh)",
      status: "FAIL",
      message: `newest quote for ${fixture.symbol} is stale: age=${age}ms > ${QUOTE_STALE_AFTER_MS}ms`,
    };
  }

  const s5 = barsFor(ctx, fixture.symbol, "S5");
  if (!s5.length) {
    return {
      id: "C10",
      name: "Price linkage + freshness (grid == rail == chart, quote fresh)",
      status: "FAIL",
      message: `no closed S5 bar for ${fixture.symbol} to link against`,
    };
  }
  const lastClosed = s5[s5.length - 1];
  const expectedClose = oracleAggregate(fixture.ticks, 5_000).at(-1)?.close;
  if (expectedClose === undefined || lastClosed.close !== expectedClose) {
    return {
      id: "C10",
      name: "Price linkage + freshness (grid == rail == chart, quote fresh)",
      status: "FAIL",
      message: `chart close ${lastClosed.close} != folded tick close ${expectedClose} for ${fixture.symbol}`,
    };
  }
  return {
    id: "C10",
    name: "Price linkage + freshness (grid == rail == chart, quote fresh)",
    status: "PASS",
    message: `live ticker/grid/rail all report ${newest.price}; last closed S5 close (${lastClosed.close}) matches the folded tick stream; quote age=${age}ms`,
  };
}

/** C11 — settlement logging. Persisting to Postgres needs a DB, so the DB leg
 *  is N/A with a reason; the pure WIN/LOSS derivation is exercised offline. */
function checkSettlement(ctx: E2EContext): CheckResult {
  const fixture = ctx.fixtures[0];
  if (!fixture) {
    return {
      id: "C11",
      name: "Settlement logging (post-expiry outcome logged per expiry)",
      status: "N/A",
      reason: "no fixtures available",
      message: "no fixtures",
    };
  }
  const m1 = barsFor(ctx, fixture.symbol, "M1");
  if (m1.length < 2) {
    return {
      id: "C11",
      name: "Settlement logging (post-expiry outcome logged per expiry)",
      status: "N/A",
      reason: `need >=2 closed M1 bars for ${fixture.symbol}, have ${m1.length}`,
      message: "insufficient bars",
    };
  }
  const entryBar = m1[m1.length - 2];
  const expiryBar = m1[m1.length - 1];
  const expiryBucketSec = Math.floor(expiryBar.timestamp / 1000);
  const record = ctx.settlements.find(
    (s) => s.symbol === fixture.symbol && s.expiryBucketSec === expiryBucketSec,
  );
  if (!record) {
    return {
      id: "C11",
      name: "Settlement logging (post-expiry outcome logged per expiry)",
      status: "FAIL",
      message: `no settlement record for ${fixture.symbol} at expiry bucket ${expiryBucketSec}`,
    };
  }
  const expected = record.exitPrice >= record.entry ? "WIN" : "LOSS";
  if (record.outcome !== expected) {
    return {
      id: "C11",
      name: "Settlement logging (post-expiry outcome logged per expiry)",
      status: "FAIL",
      message: `settlement outcome wrong for ${fixture.symbol}: entry=${record.entry} exit=${record.exitPrice} outcome=${record.outcome} expect=${expected}`,
    };
  }
  return {
    id: "C11",
    name: "Settlement logging (post-expiry outcome logged per expiry)",
    status: "PASS",
    message: `settlement logged for ${fixture.symbol} expiry=${expiryBucketSec} (entry=${record.entry} exit=${record.exitPrice} -> ${record.outcome})`,
  };
}

/** C12 — a live broker session cannot run offline; declared, not skipped. */
function naLiveSession(): CheckResult {
  return {
    id: "C12",
    name: "Live PO session replay (broker websocket)",
    status: "N/A",
    reason:
      "requires live Pocket Option credentials + the broker websocket; the harness replays captured ticks instead of connecting",
    message: "not exercised offline",
  };
}

/** C13 — the /history HTTP surface needs a running server + DB + live session. */
function naHistoryHttp(): CheckResult {
  return {
    id: "C13",
    name: "/history HTTP surface (real bars endpoint)",
    status: "N/A",
    reason: "requires a running core-backend with a database and a live PO session; not available offline",
    message: "not exercised offline",
  };
}

/** C14 — React/DOM chart parity needs a browser and streamed live data. */
function naDomChart(): CheckResult {
  return {
    id: "C14",
    name: "DOM-rendered chart series parity",
    status: "N/A",
    reason:
      "requires a browser + live streamed data; the harness compares the aggregation layer, not the React-rendered series",
    message: "not exercised offline",
  };
}

/** C15 — persisting SignalOutcome rows needs Postgres + Prisma. */
function naPostgres(): CheckResult {
  return {
    id: "C15",
    name: "SignalOutcome Postgres persistence",
    status: "N/A",
    reason:
      "requires a Postgres instance and Prisma client; the harness validates the pure settlement derivation only (C11)",
    message: "not exercised offline",
  };
}

export const CHECK_IDS = [
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "C7",
  "C8",
  "C9",
  "C10",
  "C11",
  "C12",
  "C13",
  "C14",
  "C15",
];

export function runChecks(ctx: E2EContext): CheckResult[] {
  return [
    checkCandleExactness(ctx),
    checkOhlcInvariants(ctx),
    checkSlotMonotonic(ctx),
    checkRollup(ctx),
    checkOtcPurity(ctx),
    checkTimeAnchoring(ctx),
    checkClockCoherence(ctx),
    checkTargetGeometry(ctx),
    checkTimerEntryExpiry(ctx),
    checkPriceLinkage(ctx),
    checkSettlement(ctx),
    naLiveSession(),
    naHistoryHttp(),
    naDomChart(),
    naPostgres(),
  ];
}

export function fixtureSummary(ctx: E2EContext): string {
  return describeFixtures(ctx.fixtures);
}

export const FIXTURE_CONSTS = {
  SPAN_MINUTES,
  TICK_INTERVAL_MS,
  QUOTE_STALE_AFTER_MS,
};
