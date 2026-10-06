import { describe, it, expect } from "vitest";
import { realtimeTickBuffer } from "../../services/realtimeTickBuffer.service";

/**
 * HELD-PRINT ISOLATION contract.
 *
 * A held (previously observed) print re-pended during a source outage keeps the
 * ring contiguous for charts/replay, but it must never be mistaken for a live
 * quote. These tests pin the distinction the ingestion loop depends on:
 * `getLatestFreshAgeMs` ignores held entries, and a `freshOnly` window excludes
 * them entirely (so a fully-held tape produces no scorable window at all).
 */

const FRESH = "USD/JPY";
const HELD = "EUR/GBP";
const WINDOW = "AUD/USD";

describe("realtimeTickBuffer: held prints never read as live", () => {
  it("ignores held entries when measuring live-tape age", () => {
    realtimeTickBuffer.append(FRESH, 148.2);
    expect(realtimeTickBuffer.getLatestFreshAgeMs(FRESH)).not.toBeNull();

    // Held entry lands last — it must not mask the starving live tape.
    realtimeTickBuffer.append(FRESH, 148.2, { stale: true });
    const freshAge = realtimeTickBuffer.getLatestFreshAgeMs(FRESH);
    expect(freshAge).not.toBeNull();
    expect(realtimeTickBuffer.getLatestEntry(FRESH)?.stale).toBe(true);
  });

  it("reports no fresh age when every observed entry is held", () => {
    realtimeTickBuffer.append(HELD, 0.8531, { stale: true });
    expect(realtimeTickBuffer.getLatestFreshAgeMs(HELD)).toBeNull();
  });

  it("filters held entries out of a freshOnly window", () => {
    realtimeTickBuffer.append(WINDOW, 0.6532);
    realtimeTickBuffer.append(WINDOW, 0.6532, { stale: true });
    realtimeTickBuffer.append(WINDOW, 0.6532, { stale: true });

    const all = realtimeTickBuffer.getRecentWindow(WINDOW, 10);
    const freshOnly = realtimeTickBuffer.getRecentWindow(WINDOW, 10, {
      freshOnly: true,
    });

    expect(all.length).toBe(3);
    expect(all.some((t) => t.stale === true)).toBe(true);
    expect(freshOnly.length).toBe(1);
    expect(freshOnly[0].stale).toBeUndefined();
  });
});
