/**
 * standaloneState.test.ts — the dependency-free cross-service flag that lets
 * `tickIngestion` stand down while the standalone feed authors the tape, and
 * lets the standalone feed report its mode without anyone importing each other.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { standaloneState } from "../standaloneState";

describe("standaloneState", () => {
  beforeEach(() => {
    standaloneState.reset();
  });

  it("starts inactive in the live mode", () => {
    const s = standaloneState.get();
    expect(s.active).toBe(false);
    expect(s.mode).toBe("live");
    expect(s.proxyPairs).toBe(0);
    expect(s.syntheticPairs).toBe(0);
    expect(standaloneState.isActive()).toBe(false);
  });

  it("records an active mixed snapshot with counts and a timestamp", () => {
    standaloneState.set({
      active: true,
      mode: "mixed",
      proxyPairs: 10,
      syntheticPairs: 32,
    });
    const s = standaloneState.get();
    expect(s.active).toBe(true);
    expect(s.mode).toBe("mixed");
    expect(s.proxyPairs).toBe(10);
    expect(s.syntheticPairs).toBe(32);
    expect(typeof s.updatedAt).toBe("number");
    expect(s.updatedAt).toBeGreaterThan(0);
    expect(standaloneState.isActive()).toBe(true);
  });

  it("reset() returns to the inactive/live state", () => {
    standaloneState.set({
      active: true,
      mode: "standalone_synthetic",
      proxyPairs: 0,
      syntheticPairs: 32,
    });
    standaloneState.reset();
    const s = standaloneState.get();
    expect(s.active).toBe(false);
    expect(s.mode).toBe("live");
  });

  it("get() returns a copy — callers cannot mutate shared state", () => {
    standaloneState.set({
      active: true,
      mode: "standalone_proxy",
      proxyPairs: 5,
      syntheticPairs: 0,
    });
    const s = standaloneState.get();
    s.active = false;
    s.mode = "live";
    expect(standaloneState.isActive()).toBe(true);
    expect(standaloneState.get().mode).toBe("standalone_proxy");
  });
});
