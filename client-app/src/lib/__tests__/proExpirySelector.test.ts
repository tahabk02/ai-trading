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
} from "@/store/useTradingStore";
import {
  buildProHref,
  PRO_TERMINAL_ROUTE,
} from "@/lib/pro-deep-link";

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
});