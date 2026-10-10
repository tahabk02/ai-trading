/**
 * PART 42 contract constants — shared by the Tier A / Tier B / Tier C runners.
 *
 * All values below are anchored to the running services and the client/server
 * consensus in `realtimeCandleAggregator` / `symbolRegistry`. Changing a
 * constant changes the whole matrix, so the report always prints these.
 */
export const BASE = process.env.PART42_BASE ?? "http://localhost:4000";
export const API = `${BASE}/api/v1`;

/** The 16 frames per the PO ladder (client + server aggregator agree). */
export const TIMEFRAMES = [
  "S5", "S10", "S15", "S30",
  "M1", "M2", "M3", "M5",
  "M10", "M15", "M30",
  "H1", "H4", "D1", "W1", "MN1",
];

export const TF_MS = {
  S5: 5_000,
  S10: 10_000,
  S15: 15_000,
  S30: 30_000,
  M1: 60_000,
  M2: 120_000,
  M3: 180_000,
  M5: 300_000,
  M10: 600_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
  W1: 604_800_000,
  MN1: 2_592_000_000,
};

/** The 5 trade expiries the matrix covers (minutes). */
export const EXPIRIES_MIN = [1, 2, 3, 5, 10];

/** Price tolerance per pair, derived from its `digits`:
 *  a quote at the tolerated offset must still read as "the same price".
 *  5-digit pairs: 2 pips; 3-digit (JPY-style): 2 pips; low-digit (crypto):
 *  0.05% of price (headline-news step). Stated once, applied everywhere. */
export function priceTolerance(digits, price = 0) {
  if (digits >= 4) return 2 * Math.pow(10, -digits); // 0.0002 for 5-digit
  if (digits === 3) return 0.02;                     // 2 pips on JPY
  return Math.max(price * 0.0005, 0.01);             // crypto relative
}

/** Stale threshold for quoted prices (milliseconds). */
export const QUOTE_STALE_THRESHOLD_MS = 15_000;

/** Map a raw symbol list entry to the quote map key (canonical). */
export function canonical(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export async function fetchSymbols() {
  const r = await fetch(`${API}/symbols?limit=1000`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  return (j.symbols || [])
    .map((s) => ({ symbol: canonical(s.symbol), digits: s.digits ?? 5, type: s.type }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function fetchQuotes() {
  const r = await fetch(`${API}/quotes`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  const bySymbol = {};
  for (const q of j.quotes || []) bySymbol[canonical(q.symbol)] = q;
  return { timestamp: j.timestamp, bySymbol };
}

export async function multiPredict(symbols, horizonMinutes, timeframe = "M1") {
  const r = await fetch(`${API}/multi-predict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols, timeframe, horizon_minutes: horizonMinutes }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await r.json();
  return { http: r.status, body: j };
}

/** A cell verdict record in the canonical [418] taxonomy. */
export function verdict(cell, kind, detail = null) {
  return { ...cell, verdict: kind, detail, ts: new Date().toISOString() };
}

/**
 * PART 42 [415](d) — classify the TARGET half of a cell from the engine
 * payload. The internal `target_price` may be computed even when the gate is
 * closed; authorization to DRAW it is governed by the regime/executable pair,
 * not by the value's existence. Returns one of:
 *   { state: "target", expected_target_price }   — gate open & executable
 *   { state: "withheld", reason }                — gate closed (reason carried)
 *   { state: "FAIL", reason }                    — gate open but no target
 * fails when `expectedDraw` is true yet target_price is absent, or on an
 * internal contradiction we cannot label.
 */
export function classifyTarget({ regime, suppressed, executable, tier, target_price, expectedDraw = null }) {
  const gateWord = String(regime ?? "").toLowerCase();
  const tradable = gateWord === "tradable";
  const exec = executable === true;
  const tgt = Number.isFinite(Number(target_price)) ? Number(target_price) : null;
  const reason = suppressed ?? regime ?? "(gate closed; reason withheld)";

  if (tradable && exec) {
    // Gate open: the [415](d) rule requires a drawn target at this expiry.
    if (tgt != null && tgt > 0) {
      return { state: "target", expected_target_price: tgt };
    }
    return {
      state: "FAIL",
      reason: `regime=tradable executable=true but target_price=${target_price} — engine authorizes an action with no target`,
    };
  }
  if (tradable && !exec) {
    // Gate open but not executable: too_late / below-tier / engine sub-gate.
    return {
      state: "withheld",
      reason: reason || "(regime tradable but executive gate closed)",
      expected_drawn: false,
    };
  }
  // Gate closed: withheld with the reason carried in the payload. The surface
  // MUST render this reason and MUST NOT draw the target (DOM half verifies).
  return {
    state: "withheld",
    reason,
    expected_drawn: false,
    internal_target_present: tgt != null && tgt > 0,
  };
}

export { API as API_BASE };