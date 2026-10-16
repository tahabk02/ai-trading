/**
 * n8nIngress.routes.test.ts — PHASE 5 zero-wait external signal ingress.
 *
 * Pins the HTTP contract of POST /signals/n8n-ingress: 400 on every malformed
 * field, 200 + immediate fan-out on a valid verdict. The controller is tested
 * directly with the WebSocket service mocked so only the validation + broadcast
 * mapping is under test (CALL→BUY / PUT→SELL, server receipt clock, tier
 * ladder, departure contract).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  broadcastQuant: vi.fn(),
  broadcastSignal: vi.fn(),
}));

vi.mock("../../services/websocket.service", () => ({
  websocketService: {
    broadcastLiveQuantSignal: mocks.broadcastQuant,
    broadcastSignal: mocks.broadcastSignal,
  },
}));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { n8nIngress, N8N_MIN_CONFIDENCE } from "../../controllers/n8nIngress.controller";

type JsonBody = Record<string, unknown>;

function capture() {
  const calls: { code: number; body: JsonBody }[] = [];
  let statusCode = 200;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: JsonBody) {
      calls.push({ code: statusCode, body });
      resolveDone();
      return res;
    },
  } as unknown as Response;
  return { res, calls, done };
}

async function dispatch(body: JsonBody): Promise<{ code: number; body: JsonBody }> {
  const target = capture();
  await n8nIngress({ body } as Request, target.res);
  await target.done;
  return target.calls[0];
}

const VALID = {
  symbol: "GBP/USD_OTC",
  direction: "CALL",
  status: "SIGNAL_GENERATED",
  confidence: 82,
  depart_price: 1.2634,
  recommended_expiry_seconds: 120,
};

beforeEach(() => {
  mocks.broadcastQuant.mockReset();
  mocks.broadcastSignal.mockReset();
});

describe("validation — 400 on malformed ingress", () => {
  it("rejects a missing symbol", async () => {
    const res = await dispatch({ ...VALID, symbol: "" });
    expect(res.code).toBe(400);
    expect(String(res.body.message)).toContain("symbol");
    expect(mocks.broadcastQuant).not.toHaveBeenCalled();
  });

  it("rejects a direction that is not CALL/PUT", async () => {
    const res = await dispatch({ ...VALID, direction: "BUY" });
    expect(res.code).toBe(400);
    expect(String(res.body.message)).toContain("CALL");
  });

  it("rejects an unknown status", async () => {
    const res = await dispatch({ ...VALID, status: "MAYBE" });
    expect(res.code).toBe(400);
    expect(String(res.body.message)).toContain("SIGNAL_GENERATED");
  });

  it("rejects a confidence outside 0-100", async () => {
    expect((await dispatch({ ...VALID, confidence: 140 })).code).toBe(400);
    expect((await dispatch({ ...VALID, confidence: -1 })).code).toBe(400);
    expect((await dispatch({ ...VALID, confidence: "abc" })).code).toBe(400);
  });

  it("rejects a non-positive depart_price", async () => {
    expect((await dispatch({ ...VALID, depart_price: 0 })).code).toBe(400);
    expect((await dispatch({ ...VALID, depart_price: -5 })).code).toBe(400);
  });

  it("rejects a non-positive expiry", async () => {
    expect((await dispatch({ ...VALID, recommended_expiry_seconds: 0 })).code).toBe(400);
  });
});

describe("SIGNAL_GENERATED — immediate fan-out", () => {
  it("broadcasts BOTH live_quant_signal and new_signal (CALL→BUY)", async () => {
    const res = await dispatch(VALID);
    expect(res.code).toBe(200);
    expect(mocks.broadcastQuant).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastSignal).toHaveBeenCalledTimes(1);

    const quant = mocks.broadcastQuant.mock.calls[0][0];
    // _OTC canonicalized; decimal suffix stripped → live-tick room key.
    expect(quant.symbol).toBe("GBP/USD");
    expect(quant.signalType).toBe("BUY");
    expect(quant.signal).toBe("BUY");
    expect(quant.dataSource).toBe("n8n");
    expect(quant.source).toBe("n8n");
    expect(quant.confidence).toBe(82);
    expect(quant.executable).toBe(true);
    expect(quant.regime_gate).toBe("tradable");
    // 82 → T3 (>= 80).
    expect(quant.tier).toBe("T3");
    // Departure contract mirrors the strike and opens the entry window.
    expect(quant.horizon.departure.strike_price).toBe(1.2634);
    expect(quant.horizon.departure.side).toBe("CALL");
    expect(quant.horizon.departure.available).toBe(true);

    const signal = mocks.broadcastSignal.mock.calls[0][0];
    expect(signal.direction).toBe("BUY");
    expect(signal.symbol).toBe("GBP/USD");
  });

  it("maps PUT→SELL", async () => {
    await dispatch({ ...VALID, direction: "PUT" });
    const quant = mocks.broadcastQuant.mock.calls[0][0];
    expect(quant.signalType).toBe("SELL");
    expect(quant.horizon.departure.side).toBe("PUT");
  });

  it("stamps the SERVER RECEIPT clock, not the n8n timestamp", async () => {
    const stale = "2020-01-01T00:00:00.000Z";
    await dispatch({ ...VALID, timestamp: stale });
    const quant = mocks.broadcastQuant.mock.calls[0][0];
    expect(quant.n8n_timestamp).toBe(stale);
    expect(quant.timestamp).not.toBe(stale);
    // A freshly received dispatch must read as ~now (satisfies the 2.5s gate).
    expect(Math.abs(Date.now() - new Date(quant.timestamp).getTime())).toBeLessThan(2_000);
  });

  it("marks a sub-floor confidence non-executable but still broadcasts it", async () => {
    await dispatch({ ...VALID, confidence: 55 });
    const quant = mocks.broadcastQuant.mock.calls[0][0];
    expect(quant.confidence).toBe(55);
    expect(quant.executable).toBe(false);
    expect(N8N_MIN_CONFIDENCE).toBe(60);
  });
});

describe("WAITING — no directional fabrication", () => {
  it("broadcasts ONLY live_quant_signal with a null direction", async () => {
    const res = await dispatch({ ...VALID, status: "WAITING" });
    expect(res.code).toBe(200);
    expect(mocks.broadcastQuant).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastSignal).not.toHaveBeenCalled();

    const quant = mocks.broadcastQuant.mock.calls[0][0];
    expect(quant.market_waiting).toBe(true);
    expect(quant.signalType).toBeNull();
    expect(quant.executable).toBe(false);
    expect(quant.regime_gate).toBeNull();
  });
});

describe("route wiring", () => {
  it("registers POST /signals/n8n-ingress behind requireAiEngineKey", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "routes", "signal.routes.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /router\.post\(\s*"\/signals\/n8n-ingress"\s*,\s*requireAiEngineKey\s*,\s*n8nIngress\s*\)/,
    );
  });
});
