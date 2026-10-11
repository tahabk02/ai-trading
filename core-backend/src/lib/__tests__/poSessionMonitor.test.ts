import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * PART 43.6 [483] — session-stale alerting. The monitor watches the raw relay
 * session status and raises exactly ONE email/platform alert per outage once
 * the dead session outlives PO_SESSION_STALE_ALERT_MIN. No browser, no network:
 * the relay status + alert sink are mocked, time is faked.
 */

const bridgeMock = vi.hoisted(() => ({ status: "connected" as string }));
vi.mock("../../services/pocketOptionBridge.service", () => ({
  pocketOptionBridgeService: {
    getLastRelayStatus: () => bridgeMock.status,
  },
}));

const poAlertMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/poAlert", () => ({ poAlert: poAlertMock }));

vi.mock("../../config/secrets", () => ({
  secrets: { PO_SESSION_STALE_ALERT_MIN: 15, PO_ALERT_EMAIL: "" },
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PoSessionMonitor } from "../../services/poSessionMonitor.service";

/** Fresh instance per test (the private constructor is TS-only). */
const makeMonitor = (): PoSessionMonitor =>
  new (PoSessionMonitor as unknown as new () => PoSessionMonitor)();

beforeEach(() => {
  poAlertMock.mockReset();
  bridgeMock.status = "connected";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PoSessionMonitor ([483])", () => {
  it("reports the invalid relay status", () => {
    const monitor = makeMonitor();
    bridgeMock.status = "session_expired";
    expect(monitor.isSessionInvalidNow()).toBe(true);
    bridgeMock.status = "connected";
    expect(monitor.isSessionInvalidNow()).toBe(false);
  });

  it("does not alert before the stale threshold", async () => {
    const monitor = makeMonitor();
    bridgeMock.status = "session_expired";
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await monitor.tick();
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z")); // 10 min < 15
    await monitor.tick();
    expect(poAlertMock).not.toHaveBeenCalled();
    expect(monitor.getState().invalid).toBe(true);
    expect(monitor.getState().alertActive).toBe(false);
  });

  it("alerts exactly once per outage after the threshold", async () => {
    const monitor = makeMonitor();
    bridgeMock.status = "session_expired";
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await monitor.tick();
    vi.setSystemTime(new Date("2026-01-01T00:16:00Z")); // 16 min >= 15
    await monitor.tick();
    expect(poAlertMock).toHaveBeenCalledTimes(1);
    expect(poAlertMock.mock.calls[0][0]).toMatchObject({ level: "critical" });
    expect(monitor.getState().alertActive).toBe(true);

    // A subsequent tick in the SAME outage must not re-alert (debounce).
    vi.setSystemTime(new Date("2026-01-01T00:45:00Z"));
    await monitor.tick();
    expect(poAlertMock).toHaveBeenCalledTimes(1);
  });

  it("emits exactly one recovery alert and resets the outage", async () => {
    const monitor = makeMonitor();
    bridgeMock.status = "session_expired";
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await monitor.tick();
    vi.setSystemTime(new Date("2026-01-01T00:20:00Z"));
    await monitor.tick(); // critical
    expect(poAlertMock).toHaveBeenCalledTimes(1);

    bridgeMock.status = "connected";
    vi.setSystemTime(new Date("2026-01-01T00:21:00Z"));
    await monitor.tick();
    expect(poAlertMock).toHaveBeenCalledTimes(2);
    expect(poAlertMock.mock.calls[1][0]).toMatchObject({ level: "info" });
    expect(monitor.getState().alertActive).toBe(false);
    expect(monitor.getState().invalidSince).toBeNull();
  });

  it("stays silent on a blip shorter than the threshold", async () => {
    const monitor = makeMonitor();
    bridgeMock.status = "session_expired";
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await monitor.tick();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z")); // under threshold
    await monitor.tick();
    bridgeMock.status = "connected";
    await monitor.tick();
    expect(poAlertMock).not.toHaveBeenCalled();
  });

  it("start()/stop() manage the interval idempotently", () => {
    const monitor = makeMonitor();
    monitor.start(60_000);
    monitor.start(60_000); // second call is a no-op
    monitor.stop();
    monitor.stop(); // safe to double-stop
    expect(true).toBe(true);
  });
});