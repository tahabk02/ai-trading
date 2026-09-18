import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  logDebounced503,
  reset503Debounce,
} from "../logDebouncer";

describe("logDebounced503 — burst suppression contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    reset503Debounce();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("test_503_logs_debounced", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First 503 → warns
    logDebounced503("[api] 503", { url: "/predict" });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Second 503 inside the 10 s window → swallowed
    logDebounced503("[api] 503", { url: "/predict" });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 10 s elapses
    vi.advanceTimersByTime(10_001);

    // Third 503 after window → warns again
    logDebounced503("[api] 503", { url: "/predict" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});