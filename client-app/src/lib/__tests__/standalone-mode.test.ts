/**
 * standalone-mode.test.ts — STANDALONE SaaS MODE client flag + its interaction
 * with the OTC "PO OFFLINE" blocker.
 *
 * When the backend serves the standalone fallback tape, an OTC price is a
 * LABELED proxy/synthetic tick — a usable, continuously-flowing tape — so
 * `isPoOfflineOtc` must stop treating it as a hard "not tradeable" blocker. The
 * honest origin is disclosed by the badge, not by withholding the verdict.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setStandaloneMode,
  isStandaloneMode,
  getStandaloneFeedMode,
  resetStandaloneMode,
} from "../standaloneMode";
import { isPoOfflineOtc, quoteProvenance } from "../quoteProvenance";

describe("standaloneMode flag", () => {
  beforeEach(() => resetStandaloneMode());

  it("defaults to inactive with a null mode", () => {
    expect(isStandaloneMode()).toBe(false);
    expect(getStandaloneFeedMode()).toBeNull();
  });

  it("engages with a mode and disengages clears it", () => {
    setStandaloneMode(true, "mixed");
    expect(isStandaloneMode()).toBe(true);
    expect(getStandaloneFeedMode()).toBe("mixed");

    setStandaloneMode(false);
    expect(isStandaloneMode()).toBe(false);
    expect(getStandaloneFeedMode()).toBeNull();
  });
});

describe("isPoOfflineOtc under standalone mode", () => {
  beforeEach(() => resetStandaloneMode());

  it("flags a non-PO OTC proxy quote when NOT standalone (unchanged)", () => {
    expect(isPoOfflineOtc("EUR/USD", { source: "frankfurter:live" })).toBe(true);
    expect(isPoOfflineOtc("EUR/USD", { source: "standalone:frankfurter" })).toBe(
      true,
    );
  });

  it("does NOT flag a labeled proxy/synthetic OTC quote while standalone", () => {
    setStandaloneMode(true, "mixed");
    expect(
      isPoOfflineOtc("EUR/USD", { source: "standalone:frankfurter" }),
    ).toBe(false);
    expect(isPoOfflineOtc("EUR/USD", { source: "standalone_synthetic" })).toBe(
      false,
    );
  });

  it("re-arms the blocker once standalone disengages", () => {
    setStandaloneMode(true, "standalone_synthetic");
    expect(isPoOfflineOtc("EUR/USD", { source: "frankfurter:live" })).toBe(false);
    resetStandaloneMode();
    expect(isPoOfflineOtc("EUR/USD", { source: "frankfurter:live" })).toBe(true);
  });
});

describe("quoteProvenance labels for the standalone tape", () => {
  it("labels a synthetic OTC price SIMULATED", () => {
    const p = quoteProvenance({ source: "standalone_synthetic", staleLive: false });
    expect(p.label).toBe("SIMULATED");
    expect(p.title.toLowerCase()).toContain("synthetic");
  });

  it("labels a real public proxy price STANDALONE", () => {
    const p = quoteProvenance({
      source: "standalone:yahoo_finance",
      staleLive: false,
    });
    expect(p.label).toBe("STANDALONE");
    expect(p.title).toContain("yahoo_finance");
  });
});
