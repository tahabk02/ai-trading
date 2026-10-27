export type ExpiryTargetMode = "CURRENT_CANDLE" | "NEXT_CANDLE" | "LOCKED_OUT";

export type ExpiryTargetLockReason =
  | "invalid_input"
  | "expiry_exceeds_max_horizon"
  | "alignment_slipped_too_far"
  | null;

export interface ExpiryTargetInput {
  nowMs: number;
  expirationSeconds: number;
  timeframeSeconds?: number;
  minActionableWindowMs?: number;
  maxHorizonMs?: number;
  maxSlipCandles?: number;
}

export interface ExpiryTarget {
  mode: ExpiryTargetMode;
  actionable: boolean;
  lockReason: ExpiryTargetLockReason;
  nowMs: number;
  timeframeSeconds: number;
  expirationSeconds: number;
  alignedSeconds: number;
  slippedCandles: number;
  targetCandleStartMs: number;
  targetCandleEndMs: number;
  expiresAtMs: number;
  remainingMs: number;
  minActionableWindowMs: number;
}

export const MIN_ACTIONABLE_WINDOW_MS = 1_500;
export const MAX_EXPIRY_HORIZON_MS = 30 * 24 * 60 * 60_000;

function locked(
  nowMs: number,
  timeframeSeconds: number,
  expirationSeconds: number,
  reason: Exclude<ExpiryTargetLockReason, null>,
  minActionableWindowMs: number,
): ExpiryTarget {
  return {
    mode: "LOCKED_OUT",
    actionable: false,
    lockReason: reason,
    nowMs,
    timeframeSeconds,
    expirationSeconds,
    alignedSeconds: 0,
    slippedCandles: 0,
    targetCandleStartMs: 0,
    targetCandleEndMs: 0,
    expiresAtMs: 0,
    remainingMs: 0,
    minActionableWindowMs,
  };
}

export function resolveExpiryTarget(input: ExpiryTargetInput): ExpiryTarget {
  const nowMs = Number(input?.nowMs);
  const expirationSeconds = Number(input?.expirationSeconds);
  const timeframeSeconds = Number(input?.timeframeSeconds ?? 60);
  const minActionableWindowMs = Math.max(
    0,
    Number(input?.minActionableWindowMs ?? MIN_ACTIONABLE_WINDOW_MS),
  );
  const maxHorizonMs = Math.max(
    1,
    Number(input?.maxHorizonMs ?? MAX_EXPIRY_HORIZON_MS),
  );
  const maxSlipCandles = Math.max(
    0,
    Math.floor(Number(input?.maxSlipCandles ?? 2)),
  );

  if (
    !Number.isFinite(nowMs) ||
    nowMs <= 0 ||
    !Number.isFinite(expirationSeconds) ||
    expirationSeconds <= 0 ||
    !Number.isFinite(timeframeSeconds) ||
    timeframeSeconds <= 0
  ) {
    return locked(
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "invalid_input",
      minActionableWindowMs,
    );
  }

  const periodMs = Math.max(1, Math.round(timeframeSeconds * 1000));
  const requestedMs = Math.max(1, Math.round(expirationSeconds * 1000));
  if (requestedMs > maxHorizonMs) {
    return locked(
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "expiry_exceeds_max_horizon",
      minActionableWindowMs,
    );
  }

  const currentCandleStartMs = Math.floor(nowMs / periodMs) * periodMs;
  const baseK = Math.max(1, Math.ceil(requestedMs / periodMs));
  let k = baseK;
  let targetEndMs = currentCandleStartMs + k * periodMs;
  while (targetEndMs < nowMs + minActionableWindowMs) {
    k += 1;
    targetEndMs = currentCandleStartMs + k * periodMs;
  }

  const slippedCandles = k - baseK;
  if (targetEndMs - nowMs > maxHorizonMs) {
    return locked(
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "expiry_exceeds_max_horizon",
      minActionableWindowMs,
    );
  }
  if (slippedCandles > maxSlipCandles) {
    return locked(
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "alignment_slipped_too_far",
      minActionableWindowMs,
    );
  }

  const targetCandleStartMs = targetEndMs - periodMs;
  return {
    mode:
      targetCandleStartMs <= currentCandleStartMs
        ? "CURRENT_CANDLE"
        : "NEXT_CANDLE",
    actionable: true,
    lockReason: null,
    nowMs,
    timeframeSeconds,
    expirationSeconds,
    alignedSeconds: Math.round((periodMs / 1000) * k),
    slippedCandles,
    targetCandleStartMs,
    targetCandleEndMs: targetEndMs,
    expiresAtMs: targetEndMs,
    remainingMs: Math.max(0, targetEndMs - nowMs),
    minActionableWindowMs,
  };
}

export function expiryTargetSecondsRemaining(
  target: ExpiryTarget | null | undefined,
  nowMs: number,
): number {
  if (!target || !target.actionable) return 0;
  return Math.max(0, Math.ceil((target.expiresAtMs - nowMs) / 1000));
}
