import { describe, expect, it } from "vitest";
import {
  useMarketTerminalStore,
  quoteFieldsDiffer,
  verdictFieldsDiffer,
  type LiveVerdict,
} from "@/store/useMarketTerminalStore";
import type { MarketQuote } from "@/services/api";

/** Build a quote snapshot; only the fields under test need to differ. */
const q = (over: Partial<MarketQuote> & { symbol: string }): MarketQuote => ({
  name: over.symbol,
  type: "forex",
  assetSubType: "major",
  label: over.symbol,
  digits: 5,
  payout: 85,
  price: 1.1,
  bid: 1.0995,
  ask: 1.1005,
  spread: 1,
  tickCount: 1,
  lastTickAt: null,
  ageMs: 0,
  ...over,
});

describe("quote structural sharing", () => {
  it("treats a snapshot with identical render fields as unchanged", () => {
    expect(quoteFieldsDiffer(q({ symbol: "EURUSD" }), q({ symbol: "EURUSD" }))).toBe(false);
  });

  it("ignores ageMs, which advances every frame by construction", () => {
    expect(
      quoteFieldsDiffer(
        q({ symbol: "EURUSD", ageMs: 0 }),
        q({ symbol: "EURUSD", ageMs: 412 }),
      ),
    ).toBe(false);
  });

  it("detects a price move", () => {
    expect(
      quoteFieldsDiffer(q({ symbol: "EURUSD", price: 1.1 }), q({ symbol: "EURUSD", price: 1.2 })),
    ).toBe(true);
  });

  it("detects a tickCount move (which implies a price move)", () => {
    expect(
      quoteFieldsDiffer(q({ symbol: "EURUSD", tickCount: 1 }), q({ symbol: "EURUSD", tickCount: 2 })),
    ).toBe(true);
  });

  it("keeps object identity for an unchanged symbol across repeated 1Hz frames", () => {
    const store = useMarketTerminalStore.getState();
    store.setQuotes([q({ symbol: "EURUSD", price: 1.1 })]);
    const first = useMarketTerminalStore.getState().quotes["EURUSD"];

    // Simulate five idle frames with fresh-but-identical payloads.
    for (let i = 0; i < 5; i++) {
      useMarketTerminalStore.getState().setQuotes([q({ symbol: "EURUSD", price: 1.1, ageMs: i })]);
    }
    const after = useMarketTerminalStore.getState().quotes["EURUSD"];
    expect(after).toBe(first);
  });

  it("bumps _quoteVersion only when a symbol actually changes", () => {
    const store = useMarketTerminalStore.getState();
    store.setQuotes([q({ symbol: "EURUSD", price: 1.1 })]);
    const idle = useMarketTerminalStore.getState()._quoteVersion;

    useMarketTerminalStore.getState().setQuotes([q({ symbol: "EURUSD", price: 1.1 })]);
    expect(useMarketTerminalStore.getState()._quoteVersion).toBe(idle);

    useMarketTerminalStore.getState().setQuotes([q({ symbol: "EURUSD", price: 1.25 })]);
    expect(useMarketTerminalStore.getState()._quoteVersion).toBe(idle + 1);
  });

  it("only replaces the moved symbol and leaves siblings identical", () => {
    const store = useMarketTerminalStore.getState();
    store.setQuotes([q({ symbol: "EURUSD" }), q({ symbol: "GBPJPY", price: 190 })]);
    const siblingBefore = useMarketTerminalStore.getState().quotes["GBPJPY"];

    useMarketTerminalStore.getState().setQuotes([q({ symbol: "EURUSD", price: 1.5 }), q({ symbol: "GBPJPY", price: 190 })]);

    expect(useMarketTerminalStore.getState().quotes["GBPJPY"]).toBe(siblingBefore);
    expect(useMarketTerminalStore.getState().quotes["EURUSD"].price).toBe(1.5);
  });

  it("addQuote is a no-op for an unchanged snapshot", () => {
    useMarketTerminalStore.getState().setQuotes([q({ symbol: "EURUSD" })]);
    const before = useMarketTerminalStore.getState()._quoteVersion;
    const obj = useMarketTerminalStore.getState().quotes["EURUSD"];

    useMarketTerminalStore.getState().addQuote(q({ symbol: "EURUSD", ageMs: 999 }));
    expect(useMarketTerminalStore.getState()._quoteVersion).toBe(before);
    expect(useMarketTerminalStore.getState().quotes["EURUSD"]).toBe(obj);
  });
});

describe("markPredictionsPending batching", () => {
  it("marks a whole batch in one pass and normalises symbol casing", () => {
    const store = useMarketTerminalStore.getState();
    store.markPredictionsPending(["eurusd", "GBPJPY"]);
    const preds = useMarketTerminalStore.getState().predictions;
    expect(preds["EURUSD"]?.status).toBe("pending");
    expect(preds["GBPJPY"]?.status).toBe("pending");
    expect(preds["EURUSD"]?.data).toBeNull();
  });

  it("preserves every other field of the pending record", () => {
    useMarketTerminalStore.getState().markPredictionsPending(["EURUSD"]);
    const p = useMarketTerminalStore.getState().predictions["EURUSD"];
    expect(p?.direction).toBeNull();
    expect(p?.confidence).toBeNull();
    expect(p?.market_waiting).toBe(false);
    expect(p?.waiting_reason).toBeNull();
  });

  it("keeps object identity for symbols already pending (idle refresh loop)", () => {
    useMarketTerminalStore.getState().markPredictionsPending(["EURUSD"]);
    const first = useMarketTerminalStore.getState().predictions["EURUSD"];

    useMarketTerminalStore.getState().markPredictionsPending(["EURUSD"]);
    expect(useMarketTerminalStore.getState().predictions["EURUSD"]).toBe(first);
  });

  it("skips a symbol that already carries a real prediction", () => {
    useMarketTerminalStore.getState().markPredictionsPending(["EURUSD"]);
    const pending = useMarketTerminalStore.getState().predictions["EURUSD"];

    useMarketTerminalStore.getState().markPredictionsPending(["EURUSD"]);
    expect(useMarketTerminalStore.getState().predictions["EURUSD"]).toBe(pending);
  });

  it("ignores blank / non-symbol entries", () => {
    // The store is a module-level singleton, so assert on the entries this
    // call adds rather than on the whole record.
    useMarketTerminalStore.getState().markPredictionsPending(["", "   ", "AUDUSD"]);
    const keys = Object.keys(useMarketTerminalStore.getState().predictions);
    expect(keys).toContain("AUDUSD");
    expect(keys).not.toContain("");
    expect(keys).not.toContain("   ");
  });
});

const v = (over: Partial<LiveVerdict> = {}): LiveVerdict & { symbol: string } => ({
  symbol: "GBP/USD",
  direction: "BUY",
  confidence: 71.2,
  current_price: 1.27,
  target_price: 1.271,
  market_waiting: false,
  waiting_reason: null,
  waiting_detail: null,
  book_confluence: 70.5,
  tier: "T4",
  tier_label: "LOW",
  dispatchable: true,
  scored_only: false,
  executable: true,
  timestamp: "2026-11-01T10:00:00.000Z",
  ...over,
});

describe("verdict structural sharing", () => {
  it("treats timestamp / diagnostic price advances as unchanged", () => {
    expect(
      verdictFieldsDiffer(
        v(),
        v({
          timestamp: "2026-11-01T10:00:01.000Z",
          current_price: 1.2701,
          target_price: 1.2711,
        }),
      ),
    ).toBe(false);
  });

  it("detects a direction or confidence change", () => {
    expect(verdictFieldsDiffer(v(), v({ direction: "SELL" }))).toBe(true);
    expect(verdictFieldsDiffer(v(), v({ confidence: 72.2 }))).toBe(true);
    expect(verdictFieldsDiffer(v(), v({ executable: false }))).toBe(true);
  });

  it("keeps object identity across repeated 1Hz frames", () => {
    useMarketTerminalStore.getState().ingestVerdict(v());
    const first = useMarketTerminalStore.getState().verdicts["GBP/USD"];

    for (let i = 0; i < 5; i++) {
      useMarketTerminalStore.getState().ingestVerdict(
        v({
          timestamp: `2026-11-01T10:00:0${i}.000Z`,
          current_price: 1.27 + i / 10000,
        }),
      );
    }

    expect(useMarketTerminalStore.getState().verdicts["GBP/USD"]).toBe(first);
  });

  it("bumps _verdictVersion only when the verdict actually changes", () => {
    useMarketTerminalStore.getState().ingestVerdict(v({ confidence: 80 }));
    const idle = useMarketTerminalStore.getState()._verdictVersion;

    useMarketTerminalStore.getState().ingestVerdict(
      v({ confidence: 80, timestamp: "2026-11-01T10:00:09.000Z" }),
    );
    expect(useMarketTerminalStore.getState()._verdictVersion).toBe(idle);

    useMarketTerminalStore.getState().ingestVerdict(v({ confidence: 81 }));
    expect(useMarketTerminalStore.getState()._verdictVersion).toBe(idle + 1);
  });
});
