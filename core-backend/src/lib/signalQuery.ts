export function normalizeSignalLimit(limit: unknown): number {
  const raw = Array.isArray(limit) ? limit[0] : limit;
  const parsed =
    typeof raw === "string" && raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(Math.floor(parsed), 100);
}
