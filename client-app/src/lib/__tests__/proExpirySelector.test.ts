/**
 * proExpirySelector.test.ts — Pro Terminal per-asset expiration button group
 * (Alpha.5 Pro, PART 7). Verifies:
 *   [1] the button set is exactly 1m/2m/3m/5m/10m (60/120/180/300/600s);
 *   [2] every option is a PO-canonical expiration (snap is lossless);
 *   [3] selecting any option round-trips through store.setSelectedExpirationSeconds
 *       unchanged (the deep-link &tf= path and the card horizon stay 1:1);
 *   [4] each option deep-links to the EXACT &tf= href the Market card emits;
 *   [5] the countdown formatter is mm:ss with a non-negative floor.
 */

import { describe, expect, it } from "vitest";
import {
  PRO_EXPIRY_OPTIONS,
  formatProCountdown,
} from "@/components/pro/pro-expiry-bar";
import {
  useTradingStore,
  selectSelectedExpiration,
  PO_EXPIRATION_SECONDS_SET,
  expirySecondsToHorizonMinutes,
} from "@/store/useTradingStore";
import {
  buildProHref,
  PRO_TERMINAL_ROUTE,
} from "@/lib/pro-deep-link";
import { buildSubscriptionPayload } from "@/hooks/useWebSocket";

describe("Pro expiry button group (PART 7)", () => {
  it("exposes exactly the 1m/2m/3m/5m/10m set in order", () => {
    expect(PRO_EXPIRY_OPTIONS.map((o) => o.label)).toEqual([
      "1m",
      "2m",
      "3m",
      "5m",
      "10m",
    ]);
    expect(PRO_EXPIRY_OPTIONS.map((o) => o.seconds)).toEqual([
      60, 120, 180, 300, 600,
    ]);
  });

  it("every option is a PO-canonical expiration (snap is lossless)", () => {
    for (const opt of PRO_EXPIRY_OPTIONS) {
      expect(PO_EXPIRATION_SECONDS_SET.has(opt.seconds)).toBe(true);
    }
  });

  it("selecting each option round-trips selection unchanged via the store", () => {
    const before = selectSelectedExpiration(useTradingStore.getState());
    try {
      for (const opt of PRO_EXPIRY_OPTIONS) {
        useTradingStore.getState().setSelectedExpirationSeconds(opt.seconds);
        expect(
          selectSelectedExpiration(useTradingStore.getState()),
        ).toBe(opt.seconds);
      }
    } finally {
      useTradingStore.getState().setSelectedExpirationSeconds(before);
    }
  });

  it("each option deep-links to the EXACT &tf= href the market card emits", () => {
    for (const opt of PRO_EXPIRY_OPTIONS) {
      expect(buildProHref("EUR/USD", opt.seconds)).toBe(
        `${PRO_TERMINAL_ROUTE}?symbol=EUR%2FUSD&tf=${opt.seconds}`,
      );
    }
  });

  it("formats countdown mm:ss with a non-negative floor", () => {
    expect(formatProCountdown(60)).toBe("01:00");
    expect(formatProCountdown(120)).toBe("02:00");
    expect(formatProCountdown(180)).toBe("03:00");
    expect(formatProCountdown(300)).toBe("05:00");
    expect(formatProCountdown(600)).toBe("10:00");
    expect(formatProCountdown(-5)).toBe("00:00");
    expect(formatProCountdown(59.9)).toBe("00:59");
  });

  it("keeps the selected duration through transient live-data resets", () => {
    const before = selectSelectedExpiration(useTradingStore.getState());
    try {
      useTradingStore.getState().setSelectedExpirationSeconds(60);
      useTradingStore.getState().hardResetLiveData();
      useTradingStore.getState().flushPriceCache();
      expect(selectSelectedExpiration(useTradingStore.getState())).toBe(60);
    } finally {
      useTradingStore.getState().setSelectedExpirationSeconds(before);
    }
  });

  it("builds the socket contract from the selected AI horizon", () => {
    expect(
      buildSubscriptionPayload(
        {
          activeSymbol: "EUR/USD",
          selectedTimeframe: "S5",
          selectedHorizonMinutes: 3,
        },
        "T1",
      ),
    ).toEqual({
      symbol: "EUR/USD",
      timeframe: "S5",
      horizon_minutes: 3,
      min_tier: "T1",
    });
  });

  // ── THE LOCK-STEP INVARIANT ────────────────────────────────────────────
  // ProExpiryBar only paints a button ACTIVE when BOTH store fields agree:
  // selectedExpirationSeconds (chart projection) AND selectedHorizonMinutes
  // (AI evaluation). If a single click does not move BOTH, the bar renders with
  // no active option at all — the reported "buttons do nothing" symptom.
  it("one click keeps the chart expiry and the AI horizon in lock-step", () => {
    const beforeExp = selectSelectedExpiration(useTradingStore.getState());
    const beforeHz = useTradingStore.getState().selectedHorizonMinutes;
    try {
      for (const opt of PRO_EXPIRY_OPTIONS) {
        const horizonMinutes = expirySecondsToHorizonMinutes(opt.seconds);
        // Exactly what the button's onClick does.
        useTradingStore.getState().setSelectedExpirationSeconds(opt.seconds);
        useTradingStore.getState().setSelectedHorizonMinutes(horizonMinutes);

        const state = useTradingStore.getState();
        // The active-flag precondition must hold for THIS option.
        expect(state.selectedExpirationSeconds).toBe(opt.seconds);
        expect(state.selectedHorizonMinutes).toBe(horizonMinutes);
        expect(state.selectedHorizonMinutes).toBe(
          expirySecondsToHorizonMinutes(state.selectedExpirationSeconds),
        );
      }
    } finally {
      useTradingStore
        .getState()
        .setSelectedExpirationSeconds(beforeExp);
      useTradingStore.getState().setSelectedHorizonMinutes(beforeHz);
    }
  });

  it("maps every expiry option onto the engine's supported horizon set", () => {
    // The engine's resolve_horizon_minutes() accepts exactly {1,2,3,5,10}.
    expect(PRO_EXPIRY_OPTIONS.map((o) => expirySecondsToHorizonMinutes(o.seconds)))
      .toEqual([1, 2, 3, 5, 10]);
  });

  it("the socket contract carries the SAME horizon the button selected", () => {
    // Closes the loop with the 1Hz /tick-signal path: the horizon learned on
    // subscribe is what the engine must evaluate, so the live tick verdict
    // cannot silently fall back to the engine's 1m default.
    for (const opt of PRO_EXPIRY_OPTIONS) {
      const horizonMinutes = expirySecondsToHorizonMinutes(opt.seconds);
      const payload = buildSubscriptionPayload(
        {
          activeSymbol: "EUR/USD",
          selectedTimeframe: "S5",
          selectedHorizonMinutes: horizonMinutes,
        },
        "T1",
      );
      expect(payload?.horizon_minutes).toBe(horizonMinutes);
    }
  });
});
