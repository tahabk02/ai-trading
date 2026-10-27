const DB_UNAVAILABLE_CODES = new Set([
  "P1001",
  "P1008",
  "P1017",
  "P2021",
  "P2022",
  "P2024",
]);

export function isDbUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code && DB_UNAVAILABLE_CODES.has(code)) return true;
  const name = (error as { name?: string } | null)?.name;
  if (name === "PrismaClientInitializationError") return true;
  if (name === "PrismaClientValidationError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /can'?t reach database server|connection (pool|refused)|Timed out fetching a new connection|does not exist in the current database|table .* does not exist|column .* does not exist|ECONNREFUSED (?:127\.0\.0\.1|localhost|::1):5433/i.test(
    message,
  );
}

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

export function isStorageUnavailable(error: unknown): boolean {
  return isCacheUnavailable(error) || isDbUnavailable(error);
}
