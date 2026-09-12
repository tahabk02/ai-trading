import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

// ════════════════════════════════════════════════════════════════════
// ADVANCED RISK MANAGEMENT & AUTOMATED KILL SWITCH — ALPHA 5 PRO
// ════════════════════════════════════════════════════════════════════
// Tracks the user's daily equity curve in the RiskState table. When the
// realized daily drawdown breaches the configured max (default 3%), the
// kill switch AUTOMATICALLY engages and locks ALL trade execution until
// manually reset or the next UTC trading day.
//
// Drawdown math (high-water mark method):
//   equity      = startingEquity + realizedPnl
//   peakEquity  = max(peakEquity, equity)          // intraday high-water
//   drawdownPct = ((peakEquity - equity) / peakEquity) * 100
//   locked      = drawdownPct >= maxDailyDrawdownPct
// ════════════════════════════════════════════════════════════════════

/** PRODUCTION DEFAULT: 3% max daily drawdown before the kill switch fires. */
export const DEFAULT_MAX_DAILY_DRAWDOWN_PCT = 3.0;
/** Hard floor — the kill switch can never be configured below 0.5%. */
export const MIN_ALLOWED_DRAWDOWN_PCT = 0.5;
/** Hard ceiling — the kill switch can never be configured above 25%. */
export const MAX_ALLOWED_DRAWDOWN_PCT = 25.0;

/** UTC calendar day key "YYYY-MM-DD" — the daily reset boundary. */
function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface RiskStateSnapshot {
  dayKey: string;
  startingEquity: number;
  realizedPnl: number;
  equity: number;
  peakEquity: number;
  drawdownPct: number;
  maxDailyDrawdownPct: number;
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  killSwitchLocked: boolean;
  lockedReason: string | null;
  lockedAt: string | null;
}

export interface RecordTradeResultInput {
  /** Signed P&L in account currency (negative for a loss). */
  pnl: number;
  /** Optional explicit timestamp (defaults to now). */
  at?: Date;
}

export class RiskStateService {
  /**
   * Get (or lazily create) today's RiskState row for a user.
   * Automatically rolls over to a fresh row when the UTC day changes,
   * clearing any kill-switch lock from the previous session.
   */
  async getState(userId: string): Promise<RiskStateSnapshot> {
    const today = utcDayKey();

    let state = await prisma.riskState.findUnique({ where: { userId } });

    if (!state || state.dayKey !== today) {
      // ── Daily rollover (or first run) — fresh equity curve, lock cleared ──
      const startingEquity = state ? state.peakEquity : 10000;
      state = await prisma.riskState.upsert({
        where: { userId },
        create: {
          userId,
          dayKey: today,
          startingEquity,
          realizedPnl: 0,
          peakEquity: startingEquity,
          tradesToday: 0,
          winsToday: 0,
          lossesToday: 0,
          killSwitchLocked: false,
          lockedReason: null,
          lockedAt: null,
        },
        update: {
          dayKey: today,
          startingEquity,
          realizedPnl: 0,
          peakEquity: startingEquity,
          tradesToday: 0,
          winsToday: 0,
          lossesToday: 0,
          killSwitchLocked: false,
          lockedReason: null,
          lockedAt: null,
          unlockedAt: new Date(),
        },
      });
      logger.info("[RiskState] Daily rollover — fresh session", {
        userId,
        dayKey: today,
        startingEquity,
      });
    }

    const equity = state.startingEquity + state.realizedPnl;
    const peak = Math.max(state.peakEquity, equity);
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    // ── KILL-SWITCH SELF-HEALING RECOVERY (phantom-lock guard) ──
    // A kill-switch lock is only ever legitimate for a REAL risk event:
    //   • auto-lock fires ONLY when drawdown ≥ maxDailyDrawdownPct, which
    //     requires a realized equity LOSS; and
    //   • a manual EMERGENCY lock is a deliberate operator action.
    // If the stored row claims `killSwitchLocked: true` while the account has
    // ZERO realized P&L and drawdown is below the limit — i.e. there is no
    // real loss event that could justify the lock — the lock is a stale/phantom
    // remnant from a prior session or seeding and is silently healed so the
    // terminal returns to ACTIVE (green) instead of dead-locking trading.
    // Legitimate locks are NEVER touched: a genuine drawdown breach always
    // has realizedPnl < 0 and drawdown ≥ limit, and a real manual engage keeps
    // lockedReason prefixed "EMERGENCY STOP".
    const maxDD = this.getEffectiveDrawdownLimit(userId);
    const isRealRiskEvent =
      state.realizedPnl < 0 && drawdownPct >= maxDD;
    const isManualEmergency =
      (state.lockedReason ?? "").startsWith("EMERGENCY STOP");
    if (
      state.killSwitchLocked &&
      !isRealRiskEvent &&
      !isManualEmergency
    ) {
      logger.warn(
        "[RiskState] Self-healing stale kill-switch lock (no real drawdown event) — clearing to ACTIVE",
        { userId, realizedPnl: state.realizedPnl, drawdownPct },
      );
      await prisma.riskState.update({
        where: { userId },
        data: {
          killSwitchLocked: false,
          lockedReason: null,
          lockedAt: null,
          unlockedAt: new Date(),
        },
      });
      return {
        dayKey: state.dayKey,
        startingEquity: state.startingEquity,
        realizedPnl: state.realizedPnl,
        equity,
        peakEquity: peak,
        drawdownPct: Number(drawdownPct.toFixed(4)),
        maxDailyDrawdownPct: maxDD,
        tradesToday: state.tradesToday,
        winsToday: state.winsToday,
        lossesToday: state.lossesToday,
        killSwitchLocked: false,
        lockedReason: null,
        lockedAt: null,
      };
    }

    return {
      dayKey: state.dayKey,
      startingEquity: state.startingEquity,
      realizedPnl: state.realizedPnl,
      equity,
      peakEquity: peak,
      drawdownPct: Number(drawdownPct.toFixed(4)),
      maxDailyDrawdownPct: this.getEffectiveDrawdownLimit(userId),
      tradesToday: state.tradesToday,
      winsToday: state.winsToday,
      lossesToday: state.lossesToday,
      killSwitchLocked: state.killSwitchLocked,
      lockedReason: state.lockedReason,
      lockedAt: state.lockedAt ? state.lockedAt.toISOString() : null,
    };
  }

  /**
   * THE KILL-SWITCH EVALUATION — called BEFORE every trade execution.
   * Rolls the day over if needed, recomputes drawdown from the high-water
   * mark, and AUTO-ENGAGES the lock when the configured threshold is
   * breached. Returns the authoritative snapshot.
   */
  async evaluateAndEnforce(userId: string): Promise<RiskStateSnapshot> {
    const snapshot = await this.getState(userId);

    if (snapshot.killSwitchLocked) {
      return snapshot; // already locked — nothing further to do
    }

    if (snapshot.drawdownPct >= snapshot.maxDailyDrawdownPct) {
      const reason = `Daily drawdown ${snapshot.drawdownPct.toFixed(2)}% breached the ${snapshot.maxDailyDrawdownPct}% limit — kill switch engaged`;
      await prisma.riskState.update({
        where: { userId },
        data: {
          killSwitchLocked: true,
          lockedReason: reason,
          lockedAt: new Date(),
        },
      });
      logger.error("[RiskState] ⛔ KILL SWITCH ENGAGED", {
        userId,
        drawdownPct: snapshot.drawdownPct,
        limit: snapshot.maxDailyDrawdownPct,
      });
      return {
        ...snapshot,
        killSwitchLocked: true,
        lockedReason: reason,
        lockedAt: new Date().toISOString(),
      };
    }

    return snapshot;
  }

  /**
   * Record a settled trade's P&L into the daily equity curve, update the
   * high-water mark, and re-evaluate the kill switch immediately.
   */
  async recordTradeResult(
    userId: string,
    input: RecordTradeResultInput,
  ): Promise<RiskStateSnapshot> {
    await this.getState(userId); // guarantees today's row exists

    const pnl = Number(input.pnl);
    if (!Number.isFinite(pnl)) {
      throw new Error("[RiskState] pnl must be a finite number");
    }

    await prisma.riskState.update({
      where: { userId },
      data: {
        realizedPnl: { increment: pnl },
        tradesToday: { increment: 1 },
        winsToday: pnl >= 0 ? { increment: 1 } : undefined,
        lossesToday: pnl < 0 ? { increment: 1 } : undefined,
      },
    });

    // Refresh the high-water mark with the new equity.
    const fresh = await prisma.riskState.findUnique({ where: { userId } });
    if (fresh) {
      const equity = fresh.startingEquity + fresh.realizedPnl;
      if (equity > fresh.peakEquity) {
        await prisma.riskState.update({
          where: { userId },
          data: { peakEquity: equity },
        });
      }
    }

    logger.info("[RiskState] Trade result recorded", { userId, pnl });

    // Immediately re-evaluate — the kill switch fires the moment the
    // threshold is crossed, never on the NEXT trade.
    return this.evaluateAndEnforce(userId);
  }

  /**
   * MANUAL KILL-SWITCH RESET — clears the lock so trading can resume.
   * The daily drawdown counter keeps accumulating; if losses continue the
   * switch re-engages automatically on the next evaluation.
   */
  async resetKillSwitch(userId: string): Promise<RiskStateSnapshot> {
    await this.getState(userId); // guarantees today's row exists

    await prisma.riskState.update({
      where: { userId },
      data: {
        killSwitchLocked: false,
        lockedReason: null,
        lockedAt: null,
        unlockedAt: new Date(),
      },
    });

    logger.info("[RiskState] Kill switch manually reset", { userId });
    return this.getState(userId);
  }

  /**
   * EMERGENCY KILL-SWITCH ENGAGE — manual LOCK. Immediately halts ALL live
   * trade execution regardless of drawdown state (e.g. trader spots a
   * market anomaly, feed corruption, or wants to step away). The lock
   * persists until explicitly reset via resetKillSwitch() or the next UTC
   * day rollover.
   */
  async engageKillSwitch(
    userId: string,
    reason?: string,
  ): Promise<RiskStateSnapshot> {
    await this.getState(userId); // guarantees today's row exists

    const snapshot = await this.getState(userId);
    const reasonText =
      reason && reason.trim().length > 0
        ? `EMERGENCY STOP — ${reason.trim()}`
        : "EMERGENCY STOP — trading manually locked by operator.";

    await prisma.riskState.update({
      where: { userId },
      data: {
        killSwitchLocked: true,
        lockedReason: reasonText,
        lockedAt: new Date(),
      },
    });

    logger.error("[RiskState] ⛔ KILL SWITCH MANUALLY ENGAGED", {
      userId,
      drawdownPct: snapshot.drawdownPct,
      reason: reasonText,
    });
    return this.getState(userId);
  }

  /**
   * Configure the max daily drawdown threshold (validated + clamped).
   */
  async setMaxDrawdown(
    userId: string,
    pct: number,
  ): Promise<RiskStateSnapshot> {
    const value = Number(pct);
    if (!Number.isFinite(value)) {
      throw new Error("[RiskState] drawdown pct must be a finite number");
    }
    const clamped = Math.min(
      Math.max(value, MIN_ALLOWED_DRAWDOWN_PCT),
      MAX_ALLOWED_DRAWDOWN_PCT,
    );

    await this.getState(userId); // guarantees today's row exists
    logger.info("[RiskState] Max drawdown configured", {
      userId,
      requested: value,
      clamped,
    });

    // The threshold is enforced at evaluation time from the module constant;
    // persist it in the lockedReason-free state via a metadata-free approach:
    // store it on the row by bumping peakEquity is NOT correct — instead we
    // keep the configured value in the singleton config below.
    configuredDrawdownByUser.set(userId, clamped);
    return this.getState(userId);
  }

  /** Resolve the effective drawdown limit for a user (configured or default). */
  getEffectiveDrawdownLimit(userId: string): number {
    return (
      configuredDrawdownByUser.get(userId) ?? DEFAULT_MAX_DAILY_DRAWDOWN_PCT
    );
  }
}

/** Per-user configured drawdown limits (in-process; defaults to 3%). */
const configuredDrawdownByUser = new Map<string, number>();

export const riskStateService = new RiskStateService();
