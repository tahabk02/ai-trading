export type ExpiryTargetMode = "CURRENT_CANDLE" | "NEXT_CANDLE" | "LOCKED_OUT";

export type ExpiryLockReason =
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
  lockReason: ExpiryLockReason;
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
  input: ExpiryTargetInput,
  nowMs: number,
  timeframeSeconds: number,
  expirationSeconds: number,
  reason: Exclude<ExpiryLockReason, null>,
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
    minActionableWindowMs: Math.max(
      0,
      Number(input.minActionableWindowMs ?? MIN_ACTIONABLE_WINDOW_MS),
    ),
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
    return locked(input, nowMs, timeframeSeconds, expirationSeconds, "invalid_input");
  }

  const periodMs = Math.max(1, Math.round(timeframeSeconds * 1000));
  const requestedMs = Math.max(1, Math.round(expirationSeconds * 1000));
  if (requestedMs > maxHorizonMs) {
    return locked(
      input,
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "expiry_exceeds_max_horizon",
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
      input,
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "expiry_exceeds_max_horizon",
    );
  }
  if (slippedCandles > maxSlipCandles) {
    return locked(
      input,
      nowMs,
      timeframeSeconds,
      expirationSeconds,
      "alignment_slipped_too_far",
    );
  }

  const targetCandleStartMs = targetEndMs - periodMs;
  const mode: ExpiryTargetMode =
    targetCandleStartMs <= currentCandleStartMs
      ? "CURRENT_CANDLE"
      : "NEXT_CANDLE";

  return {
    mode,
    actionable: true,
    lockReason: null,
    nowMs,
    timeframeSeconds,
    expirationSeconds,
    alignedSeconds: Math.round(periodMs / 1000) * k,
    slippedCandles,
    targetCandleStartMs,
    targetCandleEndMs: targetEndMs,
    expiresAtMs: targetEndMs,
    remainingMs: Math.max(0, targetEndMs - nowMs),
    minActionableWindowMs,
  };
}

export function expiryTargetLocked(target: ExpiryTarget): boolean {
  return target.mode === "LOCKED_OUT" || !target.actionable;
}
