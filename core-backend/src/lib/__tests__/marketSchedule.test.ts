import { describe, it, expect } from "vitest";
import {
  forexWeekState,
  isForexMarketClosed,
  isForexMarketOpen,
  newYorkForexParts,
  nextForexMarketOpenMs,
} from "../marketSchedule";

/**
 * PART 42.1 [420]/[423] — the forex week is Sunday 17:00 → Friday 17:00 New
 * York, derived from the IANA tz database (DST-correct). These are the
 * regression anchors for the closed/open boundary and for the New York offsets
 * in both US summer (EDT, UTC-4) and US winter (EST, UTC-5).
 */

describe("[420] forex-week schedule", () => {
  it("is CLOSED through Saturday", () => {
    expect(isForexMarketClosed("2026-10-10T15:00:00.000Z")).toBe(true);
  });

  it("closes Friday at 17:00 New York (EDT: 21:00 UTC)", () => {
    expect(isForexMarketOpen("2026-10-09T20:59:00.000Z")).toBe(true);
    expect(isForexMarketClosed("2026-10-09T21:00:00.000Z")).toBe(true);
  });

  it("reopens Sunday at 17:00 New York", () => {
    expect(isForexMarketClosed("2026-10-11T20:59:00.000Z")).toBe(true);
    expect(isForexMarketOpen("2026-10-11T21:00:00.000Z")).toBe(true);
  });

  it("is OPEN on a normal weekday", () => {
    expect(isForexMarketOpen("2026-10-12T12:00:00.000Z")).toBe(true);
  });

  it("handles the DST shift — winter close is 17:00 EST = 22:00 UTC", () => {
    // 2026-01-09 Friday, 2026-01-11 Sunday (New York on EST, UTC-5).
    expect(isForexMarketOpen("2026-01-09T21:00:00.000Z")).toBe(true); // 16:00 EST
    expect(isForexMarketClosed("2026-01-09T22:00:00.000Z")).toBe(true); // 17:00 EST
    expect(isForexMarketClosed("2026-01-11T21:59:00.000Z")).toBe(true); // 16:59 EST
    expect(isForexMarketOpen("2026-01-11T22:00:00.000Z")).toBe(true); // 17:00 EST
  });

  it("reports the New York wall-clock parts, not the host clock", () => {
    const parts = newYorkForexParts("2026-10-10T15:00:00.000Z");
    expect(parts.weekday).toBe(6); // Saturday
    expect(parts.hour).toBe(11); // 11:00 EDT
    expect(forexWeekState("2026-10-10T15:00:00.000Z").closed).toBe(true);
  });

  it("computes the next re-open after a weekend instant", () => {
    // Saturday 15:00 UTC → Sunday 17:00 EDT = 21:00 UTC.
    const reopen = nextForexMarketOpenMs(Date.parse("2026-10-10T15:00:00.000Z"));
    expect(new Date(reopen).toISOString()).toBe("2026-10-11T21:00:00.000Z");
    expect(isForexMarketOpen(reopen)).toBe(true);
    // Already open → returns the same instant.
    const open = Date.parse("2026-10-12T12:00:00.000Z");
    expect(nextForexMarketOpenMs(open)).toBe(open);
  });
});
