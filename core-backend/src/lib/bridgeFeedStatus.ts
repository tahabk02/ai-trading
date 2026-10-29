export type BridgeFeedStatus =
  | "live"
  | "stalled"
  | "disconnected"
  | "awaiting_ssid"
  | "auth_failed"
  | "degraded";

export interface BridgeFeedStatusInput {
  permanentlyDegraded: boolean;
  lastHeartbeatAt: number;
  nowMs: number;
  heartbeatStaleMs: number;
  lastRelayStatus: string;
  lastStatus: "ONLINE" | "DEGRADED" | "awaiting_ssid" | "idle";
  /**
   * Age of the newest PO-sourced tick across all symbols. `null` means no PO
   * tick has ever been observed this session. `undefined` disables the gate
   * (legacy callers/tests that only model relay transport state).
   */
  poFreshAgeMs?: number | null;
  /** A PO tick older than this is not live (default 15s). */
  poStaleAfterMs?: number;
  /** Epoch ms the relay last reported an authenticated PO connection. */
  connectedAtMs?: number;
  /** Startup grace after auth before missing PO ticks become `stalled`. */
  poGraceMs?: number;
}

/**
 * Derive the PO feed status from authenticated bridge state, not from an open
 * relay transport. An open WebSocket only proves the local relay is reachable;
 * it says nothing about Pocket Option auth or fresh ticks.
 */
export function deriveBridgeFeedStatus(
  input: BridgeFeedStatusInput,
): BridgeFeedStatus {
  if (input.permanentlyDegraded) return "degraded";
  if (
    input.lastHeartbeatAt > 0 &&
    input.nowMs - input.lastHeartbeatAt > input.heartbeatStaleMs
  ) {
    return "disconnected";
  }
  if (input.lastRelayStatus === "awaiting_ssid") return "awaiting_ssid";
  if (input.lastRelayStatus === "session_expired") return "auth_failed";
  if (input.lastRelayStatus === "stalled") return "stalled";
  if (
    input.lastRelayStatus === "connected" &&
    input.lastStatus === "ONLINE"
  ) {
    // An authenticated relay is NOT proof of a live PO tape. A credential can
    // authenticate and list assets while being unauthorised for market data,
    // in which case the socket stays up but zero ticks ever arrive. Only a
    // fresh PO-sourced tick (or the bounded startup grace) may report `live`.
    if (input.poFreshAgeMs !== undefined) {
      const staleAfter = input.poStaleAfterMs ?? 15_000;
      const fresh =
        input.poFreshAgeMs !== null && input.poFreshAgeMs <= staleAfter;
      if (!fresh) {
        const grace = input.poGraceMs ?? 20_000;
        const withinGrace =
          typeof input.connectedAtMs === "number" &&
          input.connectedAtMs > 0 &&
          input.nowMs - input.connectedAtMs <= grace;
        if (!withinGrace) return "stalled";
      }
    }
    return "live";
  }
  if (input.lastStatus === "DEGRADED") return "degraded";
  if (input.lastStatus === "awaiting_ssid") return "awaiting_ssid";
  if (input.lastRelayStatus === "idle" || input.lastRelayStatus === "") {
    return "awaiting_ssid";
  }
  return "degraded";
}
