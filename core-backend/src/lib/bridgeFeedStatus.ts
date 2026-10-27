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
    return "live";
  }
  if (input.lastStatus === "DEGRADED") return "degraded";
  if (input.lastStatus === "awaiting_ssid") return "awaiting_ssid";
  if (input.lastRelayStatus === "idle" || input.lastRelayStatus === "") {
    return "awaiting_ssid";
  }
  return "degraded";
}
