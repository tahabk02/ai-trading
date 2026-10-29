import { describe, expect, it } from "vitest";
import { deriveBridgeFeedStatus } from "../bridgeFeedStatus";

const base = {
  permanentlyDegraded: false,
  lastHeartbeatAt: 0,
  nowMs: 1_000_000,
  heartbeatStaleMs: 70_000,
  lastRelayStatus: "idle",
  lastStatus: "idle" as const,
};

describe("deriveBridgeFeedStatus", () => {
  it("does not report live merely because the relay transport opened", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connecting",
        lastStatus: "DEGRADED",
      }),
    ).toBe("degraded");
  });

  it("reports live only after authenticated status or a real PO tick", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
      }),
    ).toBe("live");
  });

  it("marks a stale authenticated feed disconnected", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastHeartbeatAt: 900_000,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
      }),
    ).toBe("disconnected");
  });

  it("treats re-auth/unknown relay states as degraded, never awaiting SSID", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "authing",
        lastStatus: "ONLINE",
      }),
    ).toBe("degraded");
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connecting",
        lastStatus: "idle",
      }),
    ).toBe("degraded");
  });

  it("keeps the pre-handshake idle state as awaiting SSID", () => {
    expect(deriveBridgeFeedStatus(base)).toBe("awaiting_ssid");
  });

  it("maps bridge auth/session states explicitly", () => {
    expect(
      deriveBridgeFeedStatus({ ...base, lastRelayStatus: "awaiting_ssid" }),
    ).toBe("awaiting_ssid");
    expect(
      deriveBridgeFeedStatus({ ...base, lastRelayStatus: "session_expired" }),
    ).toBe("auth_failed");
    expect(
      deriveBridgeFeedStatus({ ...base, lastRelayStatus: "stalled" }),
    ).toBe("stalled");
  });

  it("never reports live for a permanently degraded or connected-but-unverified bridge", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        permanentlyDegraded: true,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
      }),
    ).toBe("degraded");
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connected",
        lastStatus: "DEGRADED",
      }),
    ).toBe("degraded");
  });

  it("reports stalled when authenticated but no fresh PO tick past the grace", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
        poFreshAgeMs: null,
        connectedAtMs: base.nowMs - 60_000,
        poGraceMs: 20_000,
        poStaleAfterMs: 15_000,
      }),
    ).toBe("stalled");
  });

  it("keeps the startup grace while the first PO tick is still pending", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
        poFreshAgeMs: null,
        connectedAtMs: base.nowMs - 5_000,
        poGraceMs: 20_000,
        poStaleAfterMs: 15_000,
      }),
    ).toBe("live");
  });

  it("reports live on a fresh PO tick even if a proxy also owns other symbols", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
        poFreshAgeMs: 2_000,
        connectedAtMs: base.nowMs - 120_000,
        poGraceMs: 20_000,
        poStaleAfterMs: 15_000,
      }),
    ).toBe("live");
  });

  it("reports stalled when the newest PO tick is older than the stale window", () => {
    expect(
      deriveBridgeFeedStatus({
        ...base,
        lastRelayStatus: "connected",
        lastStatus: "ONLINE",
        poFreshAgeMs: 45_000,
        connectedAtMs: base.nowMs - 120_000,
        poGraceMs: 20_000,
        poStaleAfterMs: 15_000,
      }),
    ).toBe("stalled");
  });
});
