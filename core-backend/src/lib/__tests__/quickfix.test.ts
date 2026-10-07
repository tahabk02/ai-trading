/**
 * quickfix.test.ts — QUICK FIX regression suite (EADDRINUSE + Redis + PO
 * timeframe set + Postgres). Byte-truth assertions against the live config:
 *   1. The candle grid is EXACTLY the confirmed PO timeframe ladder.
 *   2. "write EPIPE" is announced once per source then ignored.
 *   3. REDIS_URL points at the radar_bus bus.
 *   4. DATABASE_URL is Postgres (never sqlite).
 */

import { describe, expect, it, vi } from "vitest";
import { SERVER_CANDLE_TFS } from "../../services/realtimeCandleAggregator.service";
import { createProcessErrorReporter } from "../../lib/processErrorHandler";
import { secrets } from "../../config/secrets";

const PO_TIMEFRAME_SET = [
  "S5",
  "S10",
  "S15",
  "S30",
  "M1",
  "M2",
  "M3",
  "M5",
  "M10",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  // PART 39 [371]/[373] — the ladder ends at the ceiling PO's own blog states
  // ("Timeframe selector – ranges from 5 seconds to 1 month"), so W1 and MN1
  // are in and S1 is out (PO says the floor is 5 seconds). PO's exact
  // twenty-item selector list is NOT recoverable from here — the cabinet UI
  // only ever archives as a /login redirect — so this asserts OUR confirmed
  // grid, not a claim about the full PO selector.
  "W1",
  "MN1",
] as const;

describe("QUICK FIX configuration contract", () => {
  it("test_timeframe_set_matches_po", () => {
    // The aggregator grid MUST equal the confirmed PO ladder,
    // element-for-element and in order.
    expect(SERVER_CANDLE_TFS).toEqual([...PO_TIMEFRAME_SET]);
    expect(SERVER_CANDLE_TFS).toHaveLength(16);
  });

  it("test_epipe_is_ignored", () => {
    const reporter = createProcessErrorReporter({ now: () => 0 });
    const epipe: NodeJS.ErrnoException = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });

    // First EPIPE on a source → surfaced once.
    expect(reporter.report("stdout", epipe).shouldLog).toBe(true);
    expect(reporter.report("stdout", epipe).isEpipe).toBe(true);

    // Subsequent EPIPEs on the SAME source → silently ignored, forever.
    expect(reporter.report("stdout", epipe).shouldLog).toBe(false);
    expect(reporter.report("stdout", epipe).shouldLog).toBe(false);

    // EPIPE on a DIFFERENT source is an independent incident → announced once.
    const stderrEp = createProcessErrorReporter({ now: () => 0 });
    expect(stderrEp.report("stderr", epipe).shouldLog).toBe(true);
    expect(stderrEp.report("stderr", epipe).shouldLog).toBe(false);
  });

  it("test_redis_url_configured", () => {
    // The bus host varies by runtime context:
    //   • "redis://radar_bus:6379" — pure docker-internal networking
    //   • "redis://localhost:6379" — hybrid host-mode (backend outside docker,
    //     connecting to radar_bus via docker's published port 6379)
    const VALID_BUS_URLS = new Set([
      "redis://radar_bus:6379",
      "redis://localhost:6379",
    ]);
    expect(VALID_BUS_URLS).toContain(secrets.REDIS_URL);
  });

  it("test_database_url_is_postgres", () => {
    // Postgres connection string — never the sqlite file:./dev.db fallback.
    expect(secrets.DATABASE_URL.startsWith("file:")).toBe(false);
    expect(secrets.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//);
    expect(secrets.DATABASE_URL).not.toContain("dev.db");
  });
});