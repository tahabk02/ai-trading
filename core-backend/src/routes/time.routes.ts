import { Router, Request, Response } from "express";
import { brokerClock } from "../lib/serverClock";
import { resolveExpiryTarget, MIN_ACTIONABLE_WINDOW_MS } from "../lib/expiryMapping";

const router = Router();

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildClockSnapshot(): {
  brokerNowMs: number;
  localNowMs: number;
  offsetMs: number;
  calibrated: boolean;
  stale: boolean;
  source: string;
  sampleCount: number;
  latencyMs: number | null;
  jitterMs: number | null;
  confidence: number;
  lastSampleAtMs: number | null;
  timestamp: string;
} {
  const localNowMs = Date.now();
  const snap = brokerClock.snapshot(localNowMs);
  return {
    ...snap,
    localNowMs,
    timestamp: new Date(localNowMs).toISOString(),
  };
}

router.get("/clock", (_req: Request, res: Response) => {
  res.json(buildClockSnapshot());
});

router.get("/expiry/target", (req: Request, res: Response) => {
  const expirationSeconds = positiveNumber(
    req.query.expirationSeconds ?? req.query.expiration ?? req.query.expiry,
  );
  const timeframeSeconds =
    positiveNumber(req.query.timeframeSeconds ?? req.query.timeframe) ?? 60;
  const minActionableWindowMs =
    positiveNumber(req.query.minActionableWindowMs) ?? MIN_ACTIONABLE_WINDOW_MS;

  if (expirationSeconds === null) {
    res.status(400).json({
      error: "expirationSeconds (or expiration) is required",
    });
    return;
  }

  const nowMs = brokerClock.now();
  const target = resolveExpiryTarget({
    nowMs,
    expirationSeconds,
    timeframeSeconds,
    minActionableWindowMs,
  });
  const clock = buildClockSnapshot();
  res.status(target.actionable ? 200 : 409).json({
    ...target,
    clock,
  });
});

export default router;
