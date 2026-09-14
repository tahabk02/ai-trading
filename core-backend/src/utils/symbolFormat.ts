export function canonicalizeSymbol(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim().toUpperCase();
  s = s.replace(/\s*OTC\s*$/, "");
  s = s.replace(/=X$/, "");
  s = s.replace(/\.(FX|FOREX|CS|TO)$/, "");
  s = s.replace(/[\-_.\s]+/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/^\//, "").replace(/\/$/, "");
  if (s.includes("/")) return s;
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
    return `${s.slice(0, 3)}/${s.slice(3)}`;
  }
  return s;
}