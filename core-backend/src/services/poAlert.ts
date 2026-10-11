/**
 * poAlert.ts — PART 43.6 [483] alert channel for the Pocket Option session /
 * auth self-healing pipeline.
 *
 * Every alert flows through NotificationService (the platform's existing sink,
 * currently a structured-log sink; email/Telegram adapters plug in there). When
 * PO_ALERT_EMAIL is configured an email is also sent. Messages NEVER contain
 * credentials or the SSID — the closest thing to a secret ever passed is the
 * masked email from a snapshot.
 *
 * `poAlert` never throws: an alert sink failure must not take down the
 * refresh/health path that raised it.
 */

import { NotificationService } from "./notification.service";
import { secrets } from "../config/secrets";
import { logger } from "../utils/logger";

export interface PoAlertParams {
  level: "info" | "warning" | "critical";
  title: string;
  message: string;
}

export async function poAlert(params: PoAlertParams): Promise<void> {
  try {
    const service = NotificationService.getInstance();
    await service.sendSystemAlert({
      level: params.level,
      title: params.title,
      message: params.message,
    });
    const destination = (secrets.PO_ALERT_EMAIL || "").trim();
    if (destination) {
      await service.sendEmail({
        to: destination,
        subject: `[trading-ai] ${params.title}`,
        body: `${params.message}\n\nSent by core-backend (PART 43.6 PO session monitor).`,
      });
    }
  } catch (err) {
    logger.error("[PO Alert] delivery failed", {
      level: params.level,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}