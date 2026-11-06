import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({
  default: {
    create: () => ({
      get: () => new Promise(() => {}),
    }),
  },
}));

let computeTargetPrice: (
  direction: "BUY" | "SELL" | "HOLD",
  livePrice: number,
  atr: number | null | undefined,
  timeframe: string,
  symbol: string,
) => number | null;

beforeAll(async () => {
  vi.spyOn(globalThis, "setInterval").mockReturnValue(
    0 as unknown as ReturnType<typeof setInterval>,
  );
  const { forexDataService } = await import("../../services/forexData.service");
  computeTargetPrice = forexDataService.computeTargetPrice.bind(forexDataService);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("computeTargetPrice", () => {
  it.each([undefined, null, 0, -0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns null when ATR is missing or invalid (%s)",
    (atr) => {
      expect(
        computeTargetPrice(
          "BUY",
          1.1,
          atr,
          "1m",
          "EUR/USD",
        ),
      ).toBeNull();
    },
  );
});
