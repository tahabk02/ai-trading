/**
 * poAlert.ts — alert channel for the Pocket Option session / auth self-healing
 * pipeline (PART 43.6 [483], external sink PART 43.7 [488]).
 *
 * Every alert flows through NotificationService (the platform's existing sink,
 * currently a structured-log sink; email/Telegram adapters plug in there). When
 * PO_ALERT_EMAIL is configured an email is also sent, and when
 * PO_ALERT_WEBHOOK_URL is configured the alert is POSTed to that webhook (a
 * Slack-compatible / generic endpoint). Messages NEVER contain credentials or
 * the SSID — the closest thing to a secret ever passed is the masked email from
 * a snapshot.
 *
 * `poAlert` never throws: an alert sink failure must not take down the
 * refresh/health path that raised it.
 */

import axios from "axios";
import { NotificationService } from "./notification.service";
import { secrets } from "../config/secrets";
import { logger } from "../utils/logger";

export interface PoAlertParams {
  level: "info" | "warning" | "critical";
  title: string;
  message: string;
}

const WEBHOOK_TIMEOUT_MS = 5_000;

export async function poAlert(params: PoAlertParams): Promise<void> {
  try {
    const service = NotificationService.getInstance();
    await service.sendSystemAlert({
      level: params.level,
      title: params.title,
      message: params.message,
    });
  } catch (err) {
    logger.error("[PO Alert] platform sink failed", {
      level: params.level,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const destination = (secrets.PO_ALERT_EMAIL || "").trim();
  if (destination) {
    try {
      await NotificationService.getInstance().sendEmail({
        to: destination,
        subject: `[trading-ai] ${params.title}`,
        body: `${params.message}\n\nSent by core-backend (PART 43.6 PO session monitor).`,
      });
    } catch (err) {
      logger.error("[PO Alert] email delivery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // PART 43.7 [488] — single external sink: one env var, no adapter code.
  const webhook = (secrets.PO_ALERT_WEBHOOK_URL || "").trim();
  if (webhook) {
    try {
      await axios.post(
        webhook,
        {
          // `text` renders in Slack; the structured fields are for generic
          // consumers. No secret is ever placed here.
          text: `[${params.level.toUpperCase()}] ${params.title}\n${params.message}`,
          level: params.level,
          title: params.title,
          message: params.message,
          source: "core-backend:po-alert",
          timestamp: new Date().toISOString(),
        },
        { timeout: WEBHOOK_TIMEOUT_MS },
      );
    } catch (err) {
      logger.error("[PO Alert] webhook delivery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
