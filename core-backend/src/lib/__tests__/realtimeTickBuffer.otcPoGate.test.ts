/**
 * realtimeTickBuffer.otcPoGate.test.ts — PART 43.5 [473]/[472].
 *
 * An OTC pair is 24/7 and normally fed by Pocket Option. When PO goes offline
 * the backend prices it from a REST "market proxy" (Frankfurter / ER-API /
 * GitHub / last-known). That proxy used to reset the live-freshness gate: a
 * static weekend rate re-served every second painted exactly like a PO tick.
 *
 * These assertions pin the OTC liveness contract:
 *
 *   freshAgeMs   — any-source age (unchanged, REAL pairs still use it)
 *   staleLive    — any-source ">15s without a fresh tick"
 *   poFreshAgeMs — age of the newest PO-SOURCED print (the OTC gate input)
 *   poStaleLive  — "no fresh PO tick" (what an OTC card must obey)
 *   poSource     — newest PO tier observed, or null
 *   getTapeDebug — the [472] last-N raw dump (source/price/ts per entry)
 *
 * plus `resolveQuoteLiveness`, the pure server-side OTC decision.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";
import { resolveQuoteLiveness } from "../../lib/quoteLiveness";

const SYM = "OTCG/TEST";

describe("[473] OTC live-freshness gate is PO-sourced only", () => {
  beforeEach(() => realtimeTickBuffer.clearSymbol(SYM));

  it("a non-PO market proxy is fresh on the any-source tape but NOT PO-live", () => {
    realtimeTickBuffer.append(SYM, 1.0851, { source: "frankfurter" });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    // any-source view (REAL pairs) — unchanged
    expect(q.freshAgeMs).not.toBeNull();
    expect(q.staleLive).toBe(false);
    expect(q.source).toBe("frankfurter");
    // PO-only view (OTC gate) — the proxy must NOT count as a PO tick
    expect(q.poFreshAgeMs).toBeNull();
    expect(q.poStaleLive).toBe(true);
    expect(q.poSource).toBeNull();
  });

  it("a PO tick after a proxy restores the OTC gate", () => {
    realtimeTickBuffer.append(SYM, 1.0851, { source: "frankfurter" });
    realtimeTickBuffer.append(SYM, 1.0852, { source: "pocket_option_ssot" });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.poFreshAgeMs).not.toBeNull();
    expect(q.poFreshAgeMs!).toBeLessThan(5_000);
    expect(q.poStaleLive).toBe(false);
    expect(q.poSource).toBe("pocket_option_ssot");
  });

  it("a held PO print still counts as PO (held handshake tier)", () => {
    realtimeTickBuffer.append(SYM, 1.0851, {
      source: "pocket_option_held",
      stale: true,
    });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    // held → not fresh, but it IS a PO print, so poSource is recorded
    expect(q.poFreshAgeMs).toBeNull();
    expect(q.poStaleLive).toBe(true);
    expect(q.poSource).toBe("pocket_option_held");
  });

  it("the :live HTTP stamp is recognised as a PO source", () => {
    realtimeTickBuffer.append(SYM, 1.0855, {
      source: "pocket_option_ssot:live",
    });
    const q = realtimeTickBuffer.getSymbolQuote(SYM)!;
    expect(q.poFreshAgeMs).not.toBeNull();
    expect(q.poStaleLive).toBe(false);
  });

  it("getGlobalPoFreshAgeMs ignores proxy-only tapes", () => {
    realtimeTickBuffer.append(SYM, 1.0851, { source: "frankfurter" });
    expect(realtimeTickBuffer.getGlobalPoFreshAgeMs()).toBeNull();
    realtimeTickBuffer.append(SYM, 1.0852, { source: "pocket_option_ssot" });
    const age = realtimeTickBuffer.getGlobalPoFreshAgeMs();
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(5_000);
  });

  it("getTapeDebug dumps the last-N entries newest-last with source/price/ts", () => {
    for (let i = 0; i < 5; i++) {
      realtimeTickBuffer.append(SYM, 1.2 + i * 1e-4, {
        tsMs: Date.now() - (5 - i) * 1000,
        source: "frankfurter",
      });
    }
    const tape = realtimeTickBuffer.getTapeDebug(SYM, 30);
    expect(tape).toHaveLength(5);
    expect(tape[tape.length - 1].price).toBeCloseTo(1.2 + 4e-4, 6);
    expect(tape[tape.length - 1].source).toBe("frankfurter");
    expect(typeof tape[tape.length - 1].iso).toBe("string");
    // oldest → newest: timestamps must be non-decreasing
    for (let i = 1; i < tape.length; i++) {
      expect(tape[i].tsMs).toBeGreaterThanOrEqual(tape[i - 1].tsMs);
    }
    expect(realtimeTickBuffer.getTapeDebug(SYM, 3)).toHaveLength(3);
  });
});

describe("[473] resolveQuoteLiveness — pure OTC decision", () => {
  const base = {
    marketClosed: false,
    freshAgeMs: 500,
    staleLive: false,
    poFreshAgeMs: null as number | null,
    poStaleLive: true,
  };

  it("OTC + non-PO proxy → not live, poOffline", () => {
    const r = resolveQuoteLiveness({
      ...base,
      assetSubType: "otc",
      source: "frankfurter",
    });
    expect(r.staleLive).toBe(true);
    expect(r.freshAgeMs).toBeNull();
    expect(r.poOffline).toBe(true);
  });

  it("OTC + fresh PO print → live, not poOffline", () => {
    const r = resolveQuoteLiveness({
      ...base,
      assetSubType: "otc",
      source: "pocket_option_ssot",
      poFreshAgeMs: 400,
      poStaleLive: false,
    });
    expect(r.staleLive).toBe(false);
    expect(r.freshAgeMs).toBe(400);
    expect(r.poOffline).toBe(false);
  });

  it("REAL forex + Frankfurter fallback → any-source rule, never poOffline", () => {
    const r = resolveQuoteLiveness({
      ...base,
      assetSubType: "forex",
      source: "frankfurter",
    });
    expect(r.staleLive).toBe(false);
    expect(r.freshAgeMs).toBe(500);
    expect(r.poOffline).toBe(false);
  });

  it("REAL forex + market closed → not live regardless of source", () => {
    const r = resolveQuoteLiveness({
      ...base,
      assetSubType: "forex",
      source: "frankfurter",
      marketClosed: true,
    });
    expect(r.staleLive).toBe(true);
    expect(r.poOffline).toBe(false);
  });

  it("crypto is never poOffline", () => {
    const r = resolveQuoteLiveness({
      ...base,
      assetSubType: "crypto",
      source: "coingecko",
    });
    expect(r.poOffline).toBe(false);
  });
});
