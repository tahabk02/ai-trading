/**
 * dbHealth.ts — shared infrastructure-outage classifiers.
 *
 * Distinguishes "the database/cache is unreachable" from "the request is
 * broken". These were previously duplicated inside `signal.controller.ts`
 * (and a third copy in `history.routes.ts`), which is why the risk-state and
 * journal controllers had NO classifier at all and surfaced raw 500s whenever
 * Postgres was cold. One implementation, every DB-touching controller.
 */

/**
 * Prisma surfaces an unreachable database as a known error code, an
 * initialization error, or a connection-level message — all of which mean
 * "retry later", never "the API is broken".
 */
export function isDbUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code && ["P1001", "P1008", "P1017", "P2024"].includes(code)) return true;
  const name = (error as { name?: string } | null)?.name;
  if (name === "PrismaClientInitializationError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /can'?t reach database server|connection (pool|refused)|Timed out fetching a new connection|ECONNREFUSED (?:127\.0\.0\.1|localhost|::1):5433/i.test(
    message,
  );
}

/**
 * Redis/cache outages are a SEPARATE recoverable condition from a DB outage.
 * ioredis surfaces them as `MaxRetriesPerRequestError` / `ReplyError`, an
 * `NR_CLOSED` code, or a connection message naming Redis. Checked BEFORE the
 * DB classifier by callers because a refused Redis connection carries a bare
 * ECONNREFUSED.
 */
export function isCacheUnavailable(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (
    /redis/i.test(name) ||
    name === "MaxRetriesPerRequestError" ||
    name === "ReplyError"
  ) {
    return true;
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "NR_CLOSED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /redis|MaxRetriesPerRequest|Stream isn'?t writeable|ECONNREFUSED .*:6379/i.test(
    message,
  );
}
