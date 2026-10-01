import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installPredictBudget,
  PREDICT_ABORT_MS,
} from "../predictBudget";

describe("installPredictBudget — /predict non-blocking guard (P1-2026-09-24)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the request signal after the budget elapses", () => {
    const budget = installPredictBudget(50);
    expect(budget.signal.aborted).toBe(false);

    vi.advanceTimersByTime(49);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.isBudgetAbort()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.isBudgetAbort()).toBe(true);
  });

  it("defaults to PREDICT_ABORT_MS (2s) when no budget is passed", () => {
    const budget = installPredictBudget();
    vi.advanceTimersByTime(PREDICT_ABORT_MS);
    expect(budget.signal.aborted).toBe(true);
  });

  it("isBudgetAbort stays false when the signal is aborted externally", () => {
    const budget = installPredictBudget(1000);
    const anyController = new AbortController();
    // Simulate an external abort (symbol/timeframe switch): combine both
    // signals the same way api.ts forwards them, then abort externally.
    const combined = new AbortController();
    anyController.signal.addEventListener("abort", () => combined.abort());
    budget.signal.addEventListener("abort", () => combined.abort());

    anyController.abort();
    expect(combined.signal.aborted).toBe(true);
    // The budget timer did NOT fire → must not be classified as a budget abort.
    expect(budget.isBudgetAbort()).toBe(false);
  });

  it("dispose clears the timer — the signal never aborts", () => {
    const budget = installPredictBudget(50);
    budget.dispose();

    vi.advanceTimersByTime(10_000);
    expect(budget.signal.aborted).toBe(true); // dispose() aborts to free listeners
    expect(budget.isBudgetAbort()).toBe(false);
  });

  it("a disposed budget aborts its (no-longer-needed) signal — safe for axios", () => {
    const budget = installPredictBudget(50);
    const listener = vi.fn();
    budget.signal.addEventListener("abort", listener);

    budget.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(budget.isBudgetAbort()).toBe(false);
  });

  it("budgetMs <= 0 disables the timer entirely (legacy unbounded path)", () => {
    const budget = installPredictBudget(0);
    vi.advanceTimersByTime(60_000);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.isBudgetAbort()).toBe(false);
  });
});