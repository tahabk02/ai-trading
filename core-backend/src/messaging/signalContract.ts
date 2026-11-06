/**
 * CANONICAL DURABLE-SIGNAL CONTRACT (v1)
 *
 * The Redis Stream is a long-lived, cross-service log: the core publisher,
 * the core persistence consumer, and the execution gateway all read the same
 * entries. A free-form `Record<string, unknown>` is therefore not a contract,
 * it is a latent outage. This module is the single schema both sides agree on.
 *
 * INVARIANTS
 * ──────────
 *  • Every entry carries an explicit `schema_version`. A consumer can reject
 *    an unknown version instead of guessing at field semantics.
 *  • Every entry carries a stable `event_id`. It is the execution gateway's
 *    idempotency key, so a replay (at-least-once delivery) can never create a
 *    second order.
 *  • Direction, target and horizon are AI-owned. The contract refuses to
 *    publish an executable entry whose target contradicts its direction or
 *    whose horizon is missing — the integration layer must never invent those.
 *  • Non-actionable waiting riders are allowed, but only with an explicit
 *    `market_waiting` flag and no executable stamp.
 */

import { createHash } from "crypto";
import { z } from "zod";

export const SIGNAL_SCHEMA_VERSION = "1.0.0";

/** Default cap for the durable log. Approximate trimming keeps XADD O(1). */
export const DEFAULT_SIGNAL_STREAM_MAXLEN = 10_000;

const direction = z.enum(["BUY", "SELL"]);

const finitePositive = z
  .number()
  .refine((n) => Number.isFinite(n) && n > 0, "must be finite and positive");

const nullableFinitePositive = finitePositive.nullable().optional();

const isoOrEpoch = z
  .union([z.string().min(1), z.number().finite().positive()])
  .refine(
    (value) =>
      typeof value === "number" ||
      (Number.isFinite(Date.parse(value)) && Date.parse(value) > 0),
    "must be a valid ISO-8601 timestamp or positive Unix epoch",
  );

/**
 * Shape written to `trading_signals:stream`.
 *
 * `.passthrough()` is deliberate: the AI engine emits a growing set of
 * diagnostic fields and dropping unknown keys would silently break the
 * operator surface. Known fields are validated; unknown fields are preserved.
 */
export const TradingSignalSchema = z
  .object({
    schema_version: z.literal(SIGNAL_SCHEMA_VERSION),
    event_id: z.string().regex(/^[a-f0-9]{32}$/),
    request_id: z.string().min(8).max(128).optional(),

    symbol: z.string().min(1).max(32),
    signal_type: direction.nullable().optional(),
    signal: direction.nullable().optional(),

    confidence: z.number().min(0).max(100),
    confidence_score: z.number().min(0).max(100).optional(),
    confidence_unit: z.literal("percent"),

    current_price: nullableFinitePositive,
    price: nullableFinitePositive,
    target_price: nullableFinitePositive,
    take_profit: nullableFinitePositive,
    display_target_override: nullableFinitePositive,
    horizon_minutes: z.number().int().positive().max(1_440).nullable().optional(),

    timeframe: z.string().min(1).max(16).optional(),
    timestamp: isoOrEpoch,
    market_waiting: z.boolean().optional(),
    waiting_reason: z.string().nullable().optional(),
    waiting_detail: z.string().nullable().optional(),

    executable: z.boolean().optional(),
    dispatchable: z.boolean().optional(),
    scored_only: z.boolean().optional(),
    tier: z.string().nullable().optional(),
    tier_label: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    regime_gate: z.string().nullable().optional(),
    suppressed_reason: z.string().nullable().optional(),
    dataSource: z.string().nullable().optional(),
    book_confluence: z.unknown().optional(),
    market_regime: z.unknown().optional(),
    aiEngine: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((signal, ctx) => {
    if (
      signal.confidence_score !== undefined &&
      Math.abs(signal.confidence_score - signal.confidence) > 0.01
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "confidence_score must match confidence in percentage units",
        path: ["confidence_score"],
      });
    }

    const side = signal.signal_type ?? signal.signal ?? null;
    const price = signal.current_price ?? signal.price;
    const target = signal.target_price;

    if (
      signal.signal_type != null &&
      signal.signal != null &&
      signal.signal_type !== signal.signal
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "signal_type and signal aliases must agree",
        path: ["signal"],
      });
    }

    if (
      signal.target_price != null &&
      signal.take_profit != null &&
      signal.target_price !== signal.take_profit
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "take_profit must not contradict the AI-owned target_price",
        path: ["take_profit"],
      });
    }

    // Executable invariants are checked BEFORE the no-direction return: a
    // waiting rider must never be able to bypass them by omitting the side.
    if (signal.executable === true || signal.dispatchable === true) {
      if (side === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an executable signal requires a BUY/SELL direction",
          path: ["signal_type"],
        });
      }
      if (signal.market_waiting === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an executable signal cannot be market_waiting",
          path: ["market_waiting"],
        });
      }
      if (target == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an executable signal requires an AI-owned target_price",
          path: ["target_price"],
        });
      }
      if (signal.horizon_minutes == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an executable signal requires an AI-owned horizon_minutes",
          path: ["horizon_minutes"],
        });
      }
    }

    if (side === null) return;

    if (price != null && target != null) {
      if (side === "BUY" && target <= price) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "BUY target_price must be above current_price",
          path: ["target_price"],
        });
      }
      if (side === "SELL" && target >= price) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SELL target_price must be below current_price",
          path: ["target_price"],
        });
      }
    }
  });

export type TradingSignal = z.infer<typeof TradingSignalSchema>;

function normalizeTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return Date.now();
}

function round(value: unknown, digits: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/**
 * Stable identity for a signal within a time bucket.
 *
 * Fields that change every tick (fresh telemetry) are deliberately excluded;
 * the minute bucket bounds how long an identical verdict keeps the same id.
 * This makes a re-publish / retry of the same verdict idempotent without
 * collapsing genuinely new verdicts from the next minute.
 */
export function deriveSignalEventId(
  payload: Record<string, unknown>,
  bucketMs = 60_000,
): string {
  const timestampMs = normalizeTimestampMs(payload.timestamp);
  const bucket = Math.floor(timestampMs / bucketMs) * bucketMs;
  const side =
    payload.signal_type ?? payload.signal ?? payload.signalType ?? null;
  const identity = {
    symbol: String(payload.symbol ?? "").trim().toUpperCase(),
    side: side == null ? null : String(side).trim().toUpperCase(),
    confidence: round(payload.confidence ?? payload.confidence_score, 2),
    current_price: round(payload.current_price ?? payload.price, 8),
    target_price: round(payload.target_price ?? payload.take_profit, 8),
    horizon_minutes: round(payload.horizon_minutes, 0),
    bucket,
  };
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Identity of an AI inference request. Unlike `deriveSignalEventId` this is
 * computed BEFORE the verdict exists, so it can travel to the AI engine and be
 * echoed back. A retried request inside the same minute is the same request.
 */
export function deriveSignalRequestId(
  payload: Record<string, unknown>,
  bucketMs = 60_000,
): string {
  const timestampMs = normalizeTimestampMs(payload.timestamp);
  const bucket = Math.floor(timestampMs / bucketMs) * bucketMs;
  const identity = {
    symbol: String(payload.symbol ?? "").trim().toUpperCase(),
    timeframe: String(payload.timeframe ?? "").trim().toLowerCase(),
    horizon_minutes: round(payload.horizon_minutes, 0),
    bucket,
  };
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Adds the version/identity envelope and validates it.
 *
 * Returns `null` (never throws) so the fire-and-forget publisher can log and
 * drop a malformed entry without touching the hot socket path.
 */
export function buildTradingSignal(
  payload: Record<string, unknown>,
): TradingSignal | null {
  if (
    payload.schema_version !== undefined &&
    payload.schema_version !== SIGNAL_SCHEMA_VERSION
  ) {
    return null;
  }
  const candidate = {
    ...payload,
    schema_version: SIGNAL_SCHEMA_VERSION,
    event_id:
      typeof payload.event_id === "string" && payload.event_id.trim()
        ? payload.event_id.trim()
        : deriveSignalEventId(payload),
  };
  const parsed = TradingSignalSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/** Human-readable validation failure for logs (never used as a response). */
export function describeSignalContractError(
  payload: Record<string, unknown>,
): string {
  if (
    payload.schema_version !== undefined &&
    payload.schema_version !== SIGNAL_SCHEMA_VERSION
  ) {
    return `schema_version: expected ${SIGNAL_SCHEMA_VERSION}`;
  }
  const candidate = {
    ...payload,
    schema_version: SIGNAL_SCHEMA_VERSION,
    event_id:
      typeof payload.event_id === "string" && payload.event_id.trim()
        ? payload.event_id.trim()
        : deriveSignalEventId(payload),
  };
  const parsed = TradingSignalSchema.safeParse(candidate);
  if (parsed.success) return "ok";
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
