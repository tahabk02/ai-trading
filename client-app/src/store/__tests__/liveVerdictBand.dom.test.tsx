/**
 * liveVerdictBand.dom.test.tsx — PART 38.1 [377]: THE STORE MUST NOT DROP THE
 * BAND THE SOCKET HAND IT.
 *
 * `LiveVerdict` has declared `tier` / `tier_label` / `dispatchable` /
 * `scored_only` / `executable` since the flexible-tier work, and
 * `useMarketTerminal.ts` `onLiveQuantSignal` passes all five into
 * `ingestVerdict` — the reducer simply never wrote them, so the declared
 * contract read `undefined` for every live verdict no matter what arrived.
 *
 * That is the same class of defect as PART 19.2's contract breaks: a type
 * promising fields a code path silently discards. These tests pin the write.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  useMarketTerminalStore,
  type LiveVerdict,
} from "@/store/useMarketTerminalStore";
import { resetAll } from "@/test/harness";

const SYMBOL = "EUR/USD";

const verdict = (overrides: Partial<LiveVerdict> = {}) =>
  ({
    symbol: SYMBOL,
    direction: "BUY",
    confidence: 62.4,
    market_waiting: false,
    waiting_reason: null,
    waiting_detail: null,
    book_confluence: 61.8,
    tier: "T5",
    tier_label: "WEAK",
    dispatchable: true,
    scored_only: true,
    executable: false,
    timestamp: "2026-10-06T10:00:00.000Z",
    ...overrides,
  }) as LiveVerdict & { symbol: string };

const stored = () => useMarketTerminalStore.getState().verdicts[SYMBOL];

describe("[377] ingestVerdict persists the engine's honest band", () => {
  beforeEach(() => resetAll());

  it("writes tier, tier_label and the three executable flags", () => {
    useMarketTerminalStore.getState().ingestVerdict(verdict());

    expect(stored().tier).toBe("T5");
    expect(stored().tier_label).toBe("WEAK");
    expect(stored().dispatchable).toBe(true);
    expect(stored().scored_only).toBe(true);
    expect(stored().executable).toBe(false);
    // The pre-existing fields are untouched — this is additive.
    expect(stored().direction).toBe("BUY");
    expect(stored().confidence).toBe(62.4);
  });

  it("normalises a malformed band to null rather than inventing one", () => {
    useMarketTerminalStore
      .getState()
      .ingestVerdict(verdict({ tier: "T9" as LiveVerdict["tier"] }));

    expect(stored().tier).toBeNull();
    // A bad band must not wipe the honest flags that came with it.
    expect(stored().scored_only).toBe(true);
  });

  it("keeps an executable band executable-looking (T1 at 98.6%)", () => {
    useMarketTerminalStore
      .getState()
      .ingestVerdict(
        verdict({
          confidence: 98.6,
          tier: "T1",
          tier_label: "PREMIUM",
          scored_only: false,
          executable: true,
        }),
      );

    expect(stored().tier).toBe("T1");
    expect(stored().executable).toBe(true);
    expect(stored().scored_only).toBe(false);
  });

  it("overwrites the previous band on the next verdict (no stale tier)", () => {
    const store = useMarketTerminalStore.getState();
    store.ingestVerdict(verdict({ tier: "T1", tier_label: "PREMIUM" }));
    expect(stored().tier).toBe("T1");

    store.ingestVerdict(
      verdict({
        confidence: 66.1,
        tier: "T5",
        tier_label: "WEAK",
        executable: false,
      }),
    );
    expect(stored().tier).toBe("T5");
    expect(stored().executable).toBe(false);
  });
});
