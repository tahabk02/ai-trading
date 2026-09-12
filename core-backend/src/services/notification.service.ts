import { logger } from "../utils/logger";

/**
 * NotificationService
 *
 * Handles sending notifications to users about signal events,
 * trade executions, and system alerts.
 *
 * Currently implements a logger-based sink. In production you would
 * integrate with SendGrid (email), Twilio (SMS), Firebase (push),
 * or a webhook relay.
 */
export class NotificationService {
  private static instance: NotificationService;

  private constructor() {}

  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Send a notification about a new trading signal.
   */
  public async sendSignalAlert(params: {
    userId: string;
    symbol: string;
    signalType: "BUY" | "SELL";
    price: number;
    confidence: number;
  }): Promise<void> {
    logger.info("Signal alert notification", {
      userId: params.userId,
      symbol: params.symbol,
      signalType: params.signalType,
      price: params.price,
      confidence: params.confidence,
    });

    // In production:
    //   await emailClient.send({ ... });
    //   await pushClient.send({ ... });
  }

  /**
   * Send a notification about a trade execution.
   */
  public async sendExecutionAlert(params: {
    userId: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    status: "FILLED" | "PARTIAL" | "REJECTED";
  }): Promise<void> {
    logger.info("Execution alert notification", {
      userId: params.userId,
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      price: params.price,
      status: params.status,
    });
  }

  /**
   * Send a system alert (e.g. engine offline, risk threshold breached).
   */
  public async sendSystemAlert(params: {
    level: "info" | "warning" | "critical";
    title: string;
    message: string;
  }): Promise<void> {
    logger.warn("System alert", {
      level: params.level,
      title: params.title,
      message: params.message,
    });
  }

  /**
   * Send an email (placeholder for production integration).
   */
  public async sendEmail(params: {
    to: string;
    subject: string;
    body: string;
  }): Promise<void> {
    logger.info("Email notification", {
      to: params.to,
      subject: params.subject,
    });
    // Integrate with SendGrid / Mailgun / SES here
  }
}

export default NotificationService;
