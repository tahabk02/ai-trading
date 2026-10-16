import { describe, it, expect } from "vitest";
import {
  JOURNAL_MEANINGFUL_MIN_N,
  JOURNAL_NO_BROKER_NOTICE,
  JournalError,
  applySettlement,
  computeJournalStats,
  isLivePoTick,
  journalEnabled,
  journalEntriesToCsv,
  journalGateState,
  journalMarkerGeometry,
  openJournalEntry,
  resolveSettlementTick,
  settleEntry,
  wilsonInterval,
  type JournalEntry,
  type JournalGateSnapshot,
  type JournalTick,
} from "@/lib/tradeJournal";

// ── PART 50 — TRADE TRACKER ──
// A local paper journal. These tests pin the honesty rules: a live PO tick is
// the only precondition, entry settles on the last pre-expiry PO print, the
// first tick after expiry is never used, ties refund, and the marker never
// implies a signal.

const GATE_WITHHELD: JournalGateSnapshot = {
  regimeGate: "pending_high_precision",
  tier: "T5",
  executable: false,
  suppressedReason: "no_directional_signal",
  bookAgreement: { aligned: 4, active: 6 },
  signal: null,
};

const GATE_TRADABLE: JournalGateSnapshot = {
  regimeGate: "tradable",
  tier: "T2",
  executable: true,
  suppressedReason: null,
  bookAgreement: { aligned: 6, active: 6 },
  signal: "BUY",
};

const PO_TICK = (tsMs: number, price = 1.0850): JournalTick => ({
  symbol: "EUR/USD",
  price,
  tsMs,
  source: "pocket_option_ssot:live",
});

function open(
  over: Partial<Parameters<typeof openJournalEntry>[0]> = {},
): JournalEntry {
  return openJournalEntry({
    tick: PO_TICK(1_000_000),
    side: "CALL",
    durationSec: 60,
    gate: GATE_WITHHELD,
    nowMs: 1_000_100,
    id: "j1",
    ...over,
  });
}

describe("PART 50 [535] — the recorder is live-PO-tick gated, gate-independent", () => {
  it("enables on a fresh PO tick regardless of the AI gate", () => {
    // A deliberately WITHHELD gate must not matter: journal != signal.
    expect(journalEnabled(PO_TICK(1_000_000), 1_000_100)).toBe(true);
  });

  it("disables with no tick, a stale latch, or a non-PO proxy source", () => {
    expect(journalEnabled(null, 1_000_100)).toBe(false);
    expect(
      journalEnabled({ ...PO_TICK(1_000_000), stale: true }, 1_000_100),
    ).toBe(false);
    expect(
      journalEnabled(
        { ...PO_TICK(1_000_000), source: "frankfurter" },
        1_000_100,
      ),
    ).toBe(false);
  });

  it("disables once the PO tick ages past the freshness bound", () => {
    expect(isLivePoTick(PO_TICK(1_000_000), 1_001_000)).toBe(true);
    expect(isLivePoTick(PO_TICK(1_000_000), 1_050_000)).toBe(false);
  });

  it("ships the no-broker notice verbatim", () => {
    expect(JOURNAL_NO_BROKER_NOTICE).toBe(
      "Journal — nothing is sent to Pocket Option.",
    );
  });
});

describe("PART 50 [536] — entry records the broker clock + last PO tick", () => {
  it("stamps entryTs/entryPrice/expiry from the live tick and duration", () => {
    const e = open({ side: "PUT" });
    expect(e.entryTs).toBe(1_000_000);
    expect(e.entryPrice).toBe(1.085);
    expect(e.durationSec).toBe(60);
    expect(e.expiryTs).toBe(1_000_000 + 60_000);
    expect(e.status).toBe("OPEN");
    expect(e.gate).toEqual(GATE_WITHHELD);
    expect(e.provenance.entrySource).toBe("pocket_option_ssot:live");
  });

  it("[540] never implies a signal existed", () => {
    expect(open().impliesSignal).toBe(false);
  });
});

describe("PART 50 [539a] — MUTATION: entry price from a non-PO tick must FAIL", () => {
  it("throws ENTRY_PRICE_NOT_PO instead of recording a proxy price", () => {
    expect(() =>
      open({ tick: { ...PO_TICK(1_000_000), source: "open_er_api" } }),
    ).toThrowError(JournalError);
    try {
      open({ tick: { ...PO_TICK(1_000_000), source: "open_er_api" } });
    } catch (err) {
      expect((err as JournalError).code).toBe("ENTRY_PRICE_NOT_PO");
    }
  });

  it("throws NO_LIVE_PO_TICK when the PO tick is stale", () => {
    try {
      open({ tick: { ...PO_TICK(1_000_000), stale: true } });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as JournalError).code).toBe("NO_LIVE_PO_TICK");
    }
  });
});

describe("PART 50 [537] — settlement uses the LAST tick at/before expiry", () => {
  const entry = open(); // expiry at 1_060_000

  it("picks the newest PO print whose ts <= expiry", () => {
    const ticks: JournalTick[] = [
      PO_TICK(1_020_000, 1.086),
      PO_TICK(1_059_000, 1.087),
      PO_TICK(1_061_000, 1.2), // after expiry — must be ignored
    ];
    const s = settleEntry(entry, ticks, 1_070_000);
    expect(resolveSettlementTick(entry, ticks)?.tsMs).toBe(1_059_000);
    expect(s.settlementPrice).toBe(1.087);
    expect(s.status).toBe("WIN"); // CALL, settle 1.087 > entry 1.085
  });

  it("stays OPEN before expiry even with ticks available", () => {
    const s = settleEntry(entry, [PO_TICK(1_030_000, 1.09)], 1_030_500);
    expect(s.status).toBe("OPEN");
  });

  it("refunds on an exact tie (VOID, excluded from the win rate)", () => {
    const s = settleEntry(entry, [PO_TICK(1_059_000, 1.085)], 1_070_000);
    expect(s.status).toBe("VOID");
    expect(s.voidReason).toBe("tie");
  });

  it("resolves PUT correctly", () => {
    const put = open({ side: "PUT" });
    const s = settleEntry(put, [PO_TICK(1_059_000, 1.084)], 1_070_000);
    expect(s.status).toBe("WIN");
  });
});

describe("PART 50 [539b] — MUTATION: settlement from the FIRST tick after expiry must FAIL", () => {
  const entry = open(); // expiry 1_060_000

  it("VOIDs when the only tick is AFTER expiry (never settles on the next print)", () => {
    const ticks = [PO_TICK(1_061_000, 1.09)];
    const s = settleEntry(entry, ticks, 1_070_000);
    expect(s.status).toBe("VOID");
    expect(s.voidReason).toBe("no_settlement_tick");
    // A mutated implementation that grabs ticks[0] after expiry would report
    // WIN here — this assertion is the mutation guard.
    expect(s.settlementPrice).toBeNull();
  });

  it("filters to PO ticks only, even inside the window", () => {
    const entry2 = open();
    const ticks: JournalTick[] = [
      { ...PO_TICK(1_059_000, 1.5), source: "held_stale_real" },
      PO_TICK(1_040_000, 1.086),
    ];
    expect(resolveSettlementTick(entry2, ticks)?.price).toBe(1.086);
  });
});

describe("PART 50 [536]/[539c] — marker geometry + MUTATION: off-by-one expiry candle", () => {
  const entry = open(); // entry 1_000_000, expiry 1_060_000
  const bucketMs = 60_000;
  // Candles start at 960_000: [960k,1020k) [1020k,1080k) [1080k,1140k)
  const candles = [
    { timestamp: 960_000 },
    { timestamp: 1_020_000 },
    { timestamp: 1_080_000 },
  ];

  it("locates entry and expiry in their CONTAINING candles", () => {
    const g = journalMarkerGeometry(entry, candles, bucketMs, 1_030_000, 1.09);
    expect(g.entryCandleIndex).toBe(0); // 1_000_000 ∈ [960k, 1020k)
    // expiry 1_060_000 ∈ [1020k, 1080k) → index 1, NOT the next candle (2).
    expect(g.expiryCandleIndex).toBe(1);
    expect(g.strikePrice).toBe(1.085);
    expect(g.aboveStrike).toBe(true);
    expect(g.countdownSec).toBeCloseTo(30, 5);
  });

  it("draws independent of the gate ([540]) — marker on a withheld tape", () => {
    const g = journalMarkerGeometry(entry, candles, bucketMs, 1_030_000, 1.0);
    expect(g.aboveStrike).toBe(false);
    // Geometry is always produced; no target-gate dependency whatsoever.
    expect(g.entryCandleIndex).toBeGreaterThanOrEqual(0);
  });

  it("returns -1 (not 0) for an instant outside the candle window", () => {
    const g = journalMarkerGeometry(
      { ...entry, entryTs: 500_000, expiryTs: 560_000 },
      candles,
      bucketMs,
      1_000_000,
      1.09,
    );
    expect(g.entryCandleIndex).toBe(-1);
    expect(g.expiryCandleIndex).toBe(-1);
  });
});

describe("PART 50 [538] — stats: Wilson interval, gate split, n<30 guard", () => {
  const settled = (
    id: string,
    status: "WIN" | "LOSS" | "VOID",
    gate: JournalGateSnapshot,
  ): JournalEntry => ({
    ...open({ gate, id }),
    status,
  });

  it("Wilson interval is 0..1 and narrows with n", () => {
    const wide = wilsonInterval(5, 10);
    const narrow = wilsonInterval(500, 1000);
    expect(wide.low).toBeGreaterThan(0);
    expect(wide.high).toBeLessThan(1);
    expect(narrow.high - narrow.low).toBeLessThan(wide.high - wide.low);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it("splits by gate state and excludes voids from the win rate", () => {
    const entries = [
      settled("a", "WIN", GATE_TRADABLE),
      settled("b", "LOSS", GATE_TRADABLE),
      settled("c", "WIN", GATE_WITHHELD),
      settled("d", "VOID", GATE_WITHHELD),
    ];
    const s = computeJournalStats(entries);
    expect(s.total).toBe(4);
    expect(s.resolved).toBe(3);
    expect(s.voids).toBe(1);
    expect(s.byGateState.tradable.resolved).toBe(2);
    expect(s.byGateState.tradable.winRate).toBe(0.5);
    expect(s.byGateState.withheld.resolved).toBe(1);
    expect(s.byGateState.withheld.winRate).toBe(1);
  });

  it("flags n < 30 as not meaningful", () => {
    const few = [settled("a", "WIN", GATE_TRADABLE)];
    expect(computeJournalStats(few).meaningful).toBe(false);
    const many = Array.from({ length: JOURNAL_MEANINGFUL_MIN_N }, (_, i) =>
      settled(`w${i}`, "WIN", GATE_TRADABLE),
    );
    expect(computeJournalStats(many).meaningful).toBe(true);
  });

  it("classifies gate state from executable + tradable regime", () => {
    expect(journalGateState(open({ gate: GATE_TRADABLE }))).toBe("tradable");
    expect(journalGateState(open({ gate: GATE_WITHHELD }))).toBe("withheld");
  });
});

describe("PART 50 [538] — CSV export", () => {
  it("emits a header + one quoted row per entry", () => {
    const csv = journalEntriesToCsv([
      { ...open(), status: "WIN", settlementPrice: 1.09, settlementTs: 1_059_000 },
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"entry_ts"');
    expect(lines[0]).toContain('"gate_state"');
    expect(lines[1]).toContain('"EUR/USD"');
    expect(lines[1]).toContain('"withheld"');
    expect(lines[1]).toContain('"WIN"');
  });

  it("applies settlement immutably", () => {
    const e = open();
    const settledE = applySettlement(e, [PO_TICK(1_059_000, 1.09)], 1_070_000);
    expect(e.status).toBe("OPEN"); // original untouched
    expect(settledE.status).toBe("WIN");
    expect(settledE.provenance.settlementSource).toBe("pocket_option_ssot:live");
  });
});
