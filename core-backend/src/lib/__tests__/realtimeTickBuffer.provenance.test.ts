/**
 * realtimeTickBuffer.provenance.test.ts — PART 38.2 [384]/[385].
 *
 * The terminal used to render `ageMs` (age of the NEWEST entry, held prints
 * included) as if it were quote freshness, so a ~59-minute-old held price
 * painted at "0s". These assertions pin the three fields the card needs to
 * tell the truth:
 *
 *   source      — WHICH feed authored the newest print
 *   stale       — is the newest entry a held (continuity) print
 *   freshAgeMs  — age of the newest NON-STALE tick (null = nothing live)
 *   staleLive   — ">15s without a fresh tick" flag the UI must surface
 */
import { describe, it, expect, beforeEach } from "vitest";

import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";

const SYM = "PRV/TEST";

describe("[384] quote provenance fields", () => {
  beforeEach(() => realtimeTickBuffer.clearSymbol(SYM));

  it("reports the authoring source of the newest print", () => {
    realtimeTickBuffer.append(SYM, 1.2345, { source: "frankfurter" });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.source).toBe("frankfurter");
    expect(q.stale).toBe(false);
    expect(q.staleLive).toBe(false);
    expect(q.freshAgeMs).not.toBeNull();
  });

  it("flags a held (stale) print and reports NO fresh tick", () => {
    realtimeTickBuffer.append(SYM, 1.2345, {
      stale: true,
      source: "last_known_real",
    });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.source).toBe("last_known_real");
    expect(q.stale).toBe(true);
    expect(q.freshAgeMs).toBeNull();
    // No genuinely fresh tick → the terminal must say so, whatever `ageMs` is.
    expect(q.staleLive).toBe(true);
    expect(q.ageMs).not.toBeNull();
  });

  it("flips to staleLive when the freshest REAL tick is older than 15s", () => {
    realtimeTickBuffer.append(SYM, 1.2345, {
      tsMs: Date.now() - 60_000,
      source: "frankfurter",
    });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.stale).toBe(false); // the entry itself is a genuine print…
    expect(q.freshAgeMs).toBeGreaterThan(15_000);
    expect(q.staleLive).toBe(true); // …but it is NOT a live quote any more
  });

  it("a held print on top of an old live one stays staleLive", () => {
    realtimeTickBuffer.append(SYM, 1.1111, {
      tsMs: Date.now() - 120_000,
      source: "frankfurter",
    });
    realtimeTickBuffer.append(SYM, 1.1112, {
      stale: true,
      source: "last_known_real",
    });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.stale).toBe(true);
    expect(q.freshAgeMs).toBeGreaterThan(15_000);
    expect(q.staleLive).toBe(true);
  });

  it("measures the NEWEST fresh print, not the oldest one in the ring", () => {
    // Regression: `tail()` is ordered oldest → newest, and the walk used to
    // start at index 0 — so a boot-seeded bar hours old made a perfectly live
    // tape read as starved (freshAgeMs = hours) and staleLive flipped true on
    // every healthy card.
    realtimeTickBuffer.append(SYM, 1.1111, {
      tsMs: Date.now() - 3 * 60 * 60 * 1000,
      source: "github_repo_cached",
    });
    realtimeTickBuffer.append(SYM, 1.2222, {
      source: "pocket_option_ssot",
    });

    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.freshAgeMs).toBeLessThan(5_000);
    expect(q.staleLive).toBe(false);
    expect(q.source).toBe("pocket_option_ssot");
  });

  it("clearSymbol drops the recorded source (no cross-symbol leakage)", () => {
    realtimeTickBuffer.append(SYM, 1.2345, { source: "coingecko" });
    realtimeTickBuffer.clearSymbol(SYM);
    expect(realtimeTickBuffer.getSymbolQuote(SYM)).toBeUndefined();
  });
});
