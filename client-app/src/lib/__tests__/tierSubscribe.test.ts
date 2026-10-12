/**
 * tierSubscribe.test.ts — TIER SELECTOR reaches the LIVE 1Hz path.
 *
 * The Tier Selector has to travel a three-hop chain to actually change what the
 * operator can trade on the live surface:
 *
 *   client subscribe payload `min_tier`
 *     → core `liveTickSignalDispatcher.setSelectedMinTier` (per symbol)
 *       → `/tick-signal` payload `min_tier`
 *         → engine `resolve_execution_floor` decides `executable`.
 *
 * The `/predict` leg was covered first. This suite covers the SUBSCRIBE leg,
 * which was the gap that made a tier selection silently inert on the live
 * verdict — the one surface the terminal actually watches.
 *
 * The floor is an executability control, so the tests below root three safety
 * properties: the selection is forwarded verbatim, garbage degrades to the
 * STRICT T1 default (never to a wider one), and an absent symbol still yields
 * no payload rather than a malformed one.
 */

import { describe, expect, it } from "vitest";
import { buildSubscriptionPayload } from "@/hooks/useWebSocket";
import { TIER_SELECTIONS } from "@/lib/tierFilter";
import { DEFAULT_EXECUTION_TIER } from "@/lib/signalTiers";

const STORE = {
  activeSymbol: "EUR/USD",
  selectedTimeframe: "S5",
  selectedHorizonMinutes: 3,
} as const;

describe("subscribe payload carries the selected tier", () => {
  it("defaults to the strict T1 bar when the selection is absent", () => {
    const payload = buildSubscriptionPayload(STORE, undefined);
    expect(payload?.min_tier).toBe(DEFAULT_EXECUTION_TIER);
  });

  it("forwards every real band verbatim", () => {
    for (const tier of TIER_SELECTIONS) {
      const payload = buildSubscriptionPayload(STORE, tier);
      expect(payload?.min_tier).toBe(tier);
    }
  });

  it("normalises case and whitespace before forwarding", () => {
    expect(buildSubscriptionPayload(STORE, " t3 ")?.min_tier).toBe("T3");
  });

  it("degrades garbage to the STRICT default, never to a wider one", () => {
    // A malformed preference must not be able to LOOSEN the executable bar.
    for (const bad of ["T9", "premium", "", "  ", 3, {}, [], true]) {
      expect(buildSubscriptionPayload(STORE, bad)?.min_tier).toBe(
        DEFAULT_EXECUTION_TIER,
      );
    }
  });

  it("forwards T5 losslessly — the engine alone decides it floors to T4", () => {
    // The bridge must not pre-empt the engine's safety floor.
    expect(buildSubscriptionPayload(STORE, "T5")?.min_tier).toBe("T5");
  });

  it("keeps the tier and the horizon independent on the same payload", () => {
    const payload = buildSubscriptionPayload(STORE, "T4");
    expect(payload?.horizon_minutes).toBe(3);
    expect(payload?.min_tier).toBe("T4");
  });

  it("returns null without a symbol, never a malformed payload", () => {
    for (const bad of ["", "   ", null, undefined]) {
      expect(
        buildSubscriptionPayload(
          { ...STORE, activeSymbol: bad as string },
          "T3",
        ),
      ).toBeNull();
    }
  });

  it("falls back to the M1 timeframe default and still carries the tier", () => {
    const payload = buildSubscriptionPayload(
      {
        activeSymbol: "GBP/USD",
        selectedTimeframe: "bogus" as never,
        selectedHorizonMinutes: 1,
      },
      "T2",
    );
    expect(payload).toEqual({
      symbol: "GBP/USD",
      timeframe: "M1",
      horizon_minutes: 1,
      min_tier: "T2",
    });
  });
});