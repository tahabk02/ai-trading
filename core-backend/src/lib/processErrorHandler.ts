import { randomUUID } from "crypto";

export interface ProcessErrorReport {
  correlationId: string;
  kind: string;
  isEpipe: boolean;
  shouldLog: boolean;
}

export interface ProcessErrorReporterOptions {
  rateLimitMs?: number;
  now?: () => number;
  createCorrelationId?: () => string;
}

const DEFAULT_RATE_LIMIT_MS = 5_000;
const EPIPE_PATTERN = /EPIPE|broken pipe/i;

function isEpipe(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "EPIPE") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return EPIPE_PATTERN.test(message);
}

/**
 * Build a reporter that decides whether a process-level error (uncaught
 * exception, unhandled rejection, or a stdio `error` event) deserves a log.
 *
 * - EPIPE errors (the classic "stream closed under ts-node-dev / piping"
 *   noise) are logged ONCE per `kind`, then silenced for that kind.
 * - Any other error is rate-limited to one log per `rateLimitMs` per `kind`.
 *
 * Every report carries a short correlation id so the caller can thread the
 * same id into the logged entry (and any follow-up state).
 */
export function createProcessErrorReporter(
  options: ProcessErrorReporterOptions = {},
) {
  const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const now = options.now ?? (() => Date.now());
  const createCorrelationId =
    options.createCorrelationId ?? (() => randomUUID().slice(0, 8));

  const lastLoggedAt = new Map<string, number>();
  const epipeAnnounced = new Set<string>();

  return {
    report(kind: string, error: unknown): ProcessErrorReport {
      const correlationId = createCorrelationId();
      const epipe = isEpipe(error);

      if (epipe) {
        if (epipeAnnounced.has(kind)) {
          return { correlationId, kind, isEpipe: true, shouldLog: false };
        }
        epipeAnnounced.add(kind);
        return { correlationId, kind, isEpipe: true, shouldLog: true };
      }

      const last = lastLoggedAt.get(kind) ?? Number.NEGATIVE_INFINITY;
      if (now() - last < rateLimitMs) {
        return { correlationId, kind, isEpipe: false, shouldLog: false };
      }
      lastLoggedAt.set(kind, now());
      return { correlationId, kind, isEpipe: false, shouldLog: true };
    },
  };
}