/**
 * poSessionMonitor.service.ts — PART 43.6 [483] SESSION-STATE ALERTING.
 *
 * The UI banner (feed_status) is not the only alarm: when the Pocket Option
 * session dies, `pocket-bridge` reports `session_expired` and live PO ticks
 * stop. This monitor watches that raw relay status and fires an email +
 * platform alert (via `poAlert` → NotificationService) once the dead session
 * has persisted for more than `PO_SESSION_STALE_ALERT_MIN` minutes.
 *
 * Debounce: raise exactly once per outage, recover exactly once per restore —
 * no alert storm on a 60 s poll. Startup: an outage that predates the process
 * starts counting from the first tick, not from boot.
 */

import { secrets } from "../config/secrets";
import { logger } from "../utils/logger";
import { poAlert } from "./poAlert";
import { pocketOptionBridgeService } from "./pocketOptionBridge.service";

export interface PoSessionMonitorState {
  invalid: boolean;
  invalidSince: string | null;
  alertActive: boolean;
  lastAlertAt: string | null;
}

export class PoSessionMonitor {
  private static instance: PoSessionMonitor;

  private timer: ReturnType<typeof setInterval> | null = null;
  private invalidSinceMs = 0;
  private alertActive = false;
  private lastAlertAtMs = 0;

  private constructor() {}

  public static getInstance(): PoSessionMonitor {
    if (!PoSessionMonitor.instance) {
      PoSessionMonitor.instance = new PoSessionMonitor();
    }
    return PoSessionMonitor.instance;
  }

  /** True when the relay reports the PO session dead. */
  public isSessionInvalidNow(): boolean {
    return pocketOptionBridgeService.getLastRelayStatus() === "session_expired";
  }

  public getState(): PoSessionMonitorState {
    return {
      invalid: this.isSessionInvalidNow(),
      invalidSince:
        this.invalidSinceMs > 0 ? new Date(this.invalidSinceMs).toISOString() : null,
      alertActive: this.alertActive,
      lastAlertAt:
        this.lastAlertAtMs > 0 ? new Date(this.lastAlertAtMs).toISOString() : null,
    };
  }

  public start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async tick(): Promise<void> {
    const staleMin = Math.max(1, Number(secrets.PO_SESSION_STALE_ALERT_MIN) || 15);
    const now = Date.now();

    if (this.isSessionInvalidNow()) {
      if (this.invalidSinceMs === 0) this.invalidSinceMs = now;
      const invalidForMin = (now - this.invalidSinceMs) / 60_000;
      if (invalidForMin >= staleMin && !this.alertActive) {
        this.alertActive = true;
        this.lastAlertAtMs = now;
        await poAlert({
          level: "critical",
          title: "[PO Session] SSID dead — live Pocket Option ticks stopped",
          message:
            `The Pocket Option session has been invalid for ` +
            `${Math.round(invalidForMin)} min (threshold ${staleMin} min). ` +
            `Live PO ticks are OFF. Refresh (` +
            `POST /health/po-auth/refresh) or re-capture the session — see ` +
            `docs/hosting/po-session-continuity.md.`,
        });
      }
      return;
    }

    const recovered = this.invalidSinceMs !== 0;
    if (recovered) {
      const downForMin = (now - this.invalidSinceMs) / 60_000;
      logger.info("[PO Session] relay session status restored", {
        downForMin: Math.round(downForMin),
      });
    }
    this.invalidSinceMs = 0;
    if (this.alertActive) {
      this.alertActive = false;
      await poAlert({
        level: "info",
        title: "[PO Session] SSID restored",
        message:
          "The Pocket Option session is valid again; live PO ticks resumed.",
      });
    }
  }
}

export const poSessionMonitor = PoSessionMonitor.getInstance();