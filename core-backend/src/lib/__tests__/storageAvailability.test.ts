import { describe, expect, it } from "vitest";
import {
  isCacheUnavailable,
  isDbUnavailable,
  isStorageUnavailable,
} from "../storageAvailability";
import { normalizeSignalLimit } from "../signalQuery";

describe("storage availability classification", () => {
  it("treats missing tables/columns and connection failures as DB-unavailable", () => {
    expect(isDbUnavailable({ code: "P2021" })).toBe(true);
    expect(isDbUnavailable({ code: "P2022" })).toBe(true);
    expect(isDbUnavailable({ code: "P1001" })).toBe(true);
    expect(
      isDbUnavailable(new Error("The table `public.Signal` does not exist")),
    ).toBe(true);
    expect(isDbUnavailable(new Error("validation failed"))).toBe(false);
  });

  it("keeps Redis outages distinct but storage-recoverable", () => {
    expect(isCacheUnavailable({ name: "MaxRetriesPerRequestError" })).toBe(true);
    expect(isCacheUnavailable({ code: "NR_CLOSED" })).toBe(true);
    expect(isStorageUnavailable({ code: "P2021" })).toBe(true);
    expect(isStorageUnavailable(new Error("bad input"))).toBe(false);
  });
});

describe("normalizeSignalLimit", () => {
  it("never produces NaN or an unbounded query", () => {
    expect(normalizeSignalLimit("abc")).toBe(50);
    expect(normalizeSignalLimit("")).toBe(50);
    expect(normalizeSignalLimit(undefined)).toBe(50);
    expect(normalizeSignalLimit("0")).toBe(50);
    expect(normalizeSignalLimit("-5")).toBe(50);
    expect(normalizeSignalLimit("12.9")).toBe(12);
    expect(normalizeSignalLimit("500")).toBe(100);
    expect(normalizeSignalLimit(["25", "90"])).toBe(25);
  });
});
