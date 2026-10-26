/**
 * publishMarketData.ts — REAL DATA PUBLISHER → GITHUB RAW
 *
 * Fetches GENUINE live market prices from free public APIs (the exact same
 * tiered cascade used by ForexDataService: Frankfurter/ECB + open.er-api) and
 * publishes them to a public GitHub repository's raw file URL via the GitHub
 * Contents API.
 *
 * Every symbol in the platform's strict 26-pair whitelist (see
 * symbolRegistry.service.ts) is included, so the backend tick ingestion
 * pipeline never hits "All spot rate sources exhausted".
 *
 * Output schema — STRICTLY the array-of-ticks form parsed by the backend:
 *
 *   [
 *     { "symbol": "EUR/USD", "price": 1.1578, "timestamp": 1725294500000 }
 *   ]
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx FOREX_GITHUB_REPO_OWNER=you \
 *   FOREX_GITHUB_REPO_NAME=your-market-data GITHUB_DATA_BRANCH=main \
 *   npm run publish:data                 # single publish
 *
 *   npm run publish:data:loop             # continuous loop (poll interval)
 *
 * Zero-fabrication policy: if a real price cannot be fetched for a symbol,
 * that symbol is OMITTED from the published payload (never a fake number).
 */

import axios, { AxiosInstance } from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

/**
 * Load core-backend's OWN env, resolved from this file's location.
 *
 * The previous `path.resolve(__dirname, "../../.env")` walked two levels up —
 * from `<repo>/core-backend/scripts` that is `<repo>`'s PARENT directory, not
 * core-backend — so it read an unrelated env file (and missed the one this
 * service actually uses). Reuse the service loader so the script, the API, and
 * `npm start` all resolve configuration identically.
 *
 * `override: false` keeps a real injected environment (CI token, etc.) ahead
 * of anything on disk.
 */
const SERVICE_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(SERVICE_ROOT, ".env"), override: false, quiet: true });

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const REPO_OWNER =
  process.env.FOREX_GITHUB_REPO_OWNER || process.env.GITHUB_DATA_REPO_OWNER || "";
const REPO_NAME =
  process.env.FOREX_GITHUB_REPO_NAME || process.env.GITHUB_DATA_REPO_NAME || "";
const BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
/** Path in the repo that ForexDataService polls (must match GITHUB_PRICES_FILE). */
const PRICES_FILE =
  process.env.FOREX_GITHUB_PRICES_FILE || "data/fx_spot.json";
/** Poll interval (ms) for --loop mode. */
const POLL_INTERVAL_MS = Number(process.env.FOREX_GITHUB_POLL_MS) || 10_000;
/** Refresh interval (ms) for the upstream API cache. */
const REFRESH_INTERVAL_MS = Number(process.env.FOREX_PUBLISH_REFRESH_MS) || 60_000;

const REQUEST_TIMEOUT_MS = 15_000;

// Free public rate APIs (same cascade as ForexDataService)
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";
const OPEN_ER_API_BASE = "https://open.er-api.com/v6/latest";

// ─────────────────────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly the tick schema ForexDataService distinguishes on. */
interface MarketTick {
  symbol: string;
  price: number;
  timestamp: number;
}

/** Price rounded to a safe display precision. */
interface SymbolSpec {
  symbol: string;
  base: string;
  quote: string;
  digits: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE 26-PAIR WHITELIST (mirrors symbolRegistry.service.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_SPECS: SymbolSpec[] = [
  // Forex majors
  { symbol: "EUR/USD", base: "EUR", quote: "USD", digits: 5 },
  { symbol: "USD/JPY", base: "USD", quote: "JPY", digits: 3 },
  { symbol: "USD/CHF", base: "USD", quote: "CHF", digits: 5 },
  { symbol: "USD/CAD", base: "USD", quote: "CAD", digits: 5 },
  { symbol: "AUD/USD", base: "AUD", quote: "USD", digits: 5 },
  // Euro crosses
  { symbol: "EUR/JPY", base: "EUR", quote: "JPY", digits: 3 },
  { symbol: "EUR/CHF", base: "EUR", quote: "CHF", digits: 5 },
  { symbol: "EUR/AUD", base: "EUR", quote: "AUD", digits: 5 },
  { symbol: "EUR/CAD", base: "EUR", quote: "CAD", digits: 5 },
  // Yen crosses
  { symbol: "AUD/JPY", base: "AUD", quote: "JPY", digits: 3 },
  { symbol: "CAD/JPY", base: "CAD", quote: "JPY", digits: 3 },
  { symbol: "CHF/JPY", base: "CHF", quote: "JPY", digits: 3 },
  // Other minors
  { symbol: "AUD/CAD", base: "AUD", quote: "CAD", digits: 5 },
  { symbol: "AUD/NZD", base: "AUD", quote: "NZD", digits: 5 },
  { symbol: "CAD/CHF", base: "CAD", quote: "CHF", digits: 5 },
  { symbol: "EUR/RUB", base: "EUR", quote: "RUB", digits: 5 },
  // Emerging / OTC variants
  { symbol: "USD/TRY", base: "USD", quote: "TRY", digits: 5 },
  { symbol: "USD/MXN", base: "USD", quote: "MXN", digits: 5 },
  { symbol: "USD/SGD", base: "USD", quote: "SGD", digits: 5 },
  { symbol: "MAD/USD", base: "MAD", quote: "USD", digits: 5 },
  { symbol: "KES/USD", base: "KES", quote: "USD", digits: 5 },
  // Real non-OTC forex
  { symbol: "EUR/SEK", base: "EUR", quote: "SEK", digits: 5 },
  { symbol: "EUR/HUF", base: "EUR", quote: "HUF", digits: 5 },
  { symbol: "USD/NOK", base: "USD", quote: "NOK", digits: 5 },
  { symbol: "USD/PLN", base: "USD", quote: "PLN", digits: 5 },
  { symbol: "USD/CZK", base: "USD", quote: "CZK", digits: 5 },
];

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP CLIENT
// ─────────────────────────────────────────────────────────────────────────────

const http: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: "application/json",
    "User-Agent": "trading-ai-platform-publisher/1.0",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
//  REAL PRICE FETCHING (tiered cascade — identical to ForexDataService)
// ─────────────────────────────────────────────────────────────────────────────

/** Simple per-base-currency cache to avoid hammering the free APIs. */
const frankfurterCache = new Map<
  string,
  { rates: Record<string, number>; ts: number }
>();

/** Open ER-API cache (fallback tier — supports exotic currencies like MAD/KES). */
const openErApiCache = new Map<
  string,
  { rates: Record<string, number>; ts: number }
>();

/**
 * Fetch a real live rate for one symbol.
 * Returns null if NO source can produce a genuine price (symbol is omitted).
 */
async function fetchRealPrice(spec: SymbolSpec): Promise<number | null> {
  try {
    return await fetchForexPrice(spec);
  } catch (err) {
    log(`[publisher] Price fetch failed for ${spec.symbol}: ${
      err instanceof Error ? err.message : String(err)
    }`);
    return null;
  }
}

/**
 * Fetch a cross/QUOTE rate via a tiered cascade:
 *  1. Frankfurter (ECB) — covers all major/minor crosses
 *  2. Open ER-API     — fallback that also carries exotic currencies (MAD, KES)
 * Returns null only if every tier fails to produce a genuine positive rate.
 */
async function fetchForexPrice(spec: SymbolSpec): Promise<number | null> {
  // Tier 1: Frankfurter (ECB reference rates)
  const cached = frankfurterCache.get(spec.base);
  if (cached && Date.now() - cached.ts < REFRESH_INTERVAL_MS) {
    const rate = cached.rates[spec.quote];
    if (rate > 0) return rate;
  }

  try {
    const url = `${FRANKFURTER_BASE}/latest?from=${spec.base}`;
    const res = await http.get(url);
    const rates: Record<string, number> = res.data?.rates ?? {};
    const rate = Number(rates[spec.quote]);

    if (Number.isFinite(rate) && rate > 0) {
      frankfurterCache.set(spec.base, { rates, ts: Date.now() });
      return rate;
    }
  } catch (err) {
    log(
      `[publisher] Frankfurter failed for ${spec.symbol}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // Tier 2: Open ER-API (covers exotic currencies Frankfurter lacks)
  const erCached = openErApiCache.get(spec.base);
  if (erCached && Date.now() - erCached.ts < REFRESH_INTERVAL_MS) {
    const rate = erCached.rates[spec.quote];
    if (rate > 0) return rate;
  }

  try {
    const url = `${OPEN_ER_API_BASE}/${spec.base}`;
    const res = await http.get(url);
    const rates: Record<string, number> = res.data?.rates ?? {};
    const rate = Number(rates[spec.quote]);

    if (Number.isFinite(rate) && rate > 0) {
      openErApiCache.set(spec.base, { rates, ts: Date.now() });
      return rate;
    }
  } catch (err) {
    log(
      `[publisher] Open ER-API failed for ${spec.symbol}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return null;
}

/** Round a price to the pair's configured decimal precision. */
function roundPrice(value: number, spec: SymbolSpec): number {
  const factor = Math.pow(10, spec.digits);
  return Math.round(value * factor) / factor;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAYLOAD CONSTRUCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the exact array-of-tick payload the backend parses.
 * Only symbols with a genuine fetched price are included.
 */
async function buildPayload(now: number): Promise<MarketTick[]> {
  const results = await Promise.all(
    SYMBOL_SPECS.map(async (spec) => {
      const raw = await fetchRealPrice(spec);
      if (raw === null) return null;
      return {
        symbol: spec.symbol,
        price: roundPrice(raw, spec),
        timestamp: now,
      } as MarketTick;
    }),
  );

  const ticks = results.filter(
    (t): t is MarketTick => t !== null && t.price > 0,
  );

  // Sort deterministically by symbol for a stable, diff-friendly payload.
  ticks.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return ticks;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GITHUB PUBLISH (write via Contents API → served at raw URL)
// ─────────────────────────────────────────────────────────────────────────────

interface GitContentResponse {
  sha?: string;
  content?: { sha?: string };
}

/**
 * Publish the payload to the GitHub repo at {PRICES_FILE}.
 * Uses the Contents API with a fine-grained token (needs Contents: read/write).
 */
async function publishToGitHub(tokens: MarketTick[]): Promise<boolean> {
  if (!GITHUB_TOKEN) {
    log("[publisher] ERROR: GITHUB_TOKEN not set — cannot publish.");
    return false;
  }
  if (!REPO_OWNER || !REPO_NAME) {
    log("[publisher] ERROR: repo owner/name not set — cannot publish.");
    return false;
  }

  const body = JSON.stringify(tokens, null, 2);
  const encoded = Buffer.from(body, "utf-8").toString("base64");
  const contentsUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${PRICES_FILE}`;

  try {
    // Try to fetch the existing file's SHA (for an update instead of create).
    let sha: string | undefined;
    try {
      const existing = await http.get(contentsUrl, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
      });
      sha = existing.data?.sha as string | undefined;
    } catch {
      // 404 → new file; otherwise surface the original error below.
    }

    // Retry logic for name == main branch default handling + transient failures.
    let attempt = 0;
    const MAX_ATTEMPTS = 3;

    while (attempt < MAX_ATTEMPTS) {
      try {
        const payload: Record<string, unknown> = {
          message: `[publisher] live market data snapshot @ ${new Date().toISOString()}`,
          content: encoded,
          branch: BRANCH,
        };
        if (sha) payload.sha = sha;

        const res = await http.put(contentsUrl, payload, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
        });

        const data = res.data as GitContentResponse;
        if (res.status === 200 || res.status === 201) {
          log(
            `[publisher] Published ${tokens.length} symbols to ` +
              `${REPO_OWNER}/${REPO_NAME}@${BRANCH}:${PRICES_FILE} ` +
              `(sha ${data.sha || data.content?.sha || "n/a"})`,
          );
          return true;
        }
        return false;
      } catch (err) {
        attempt++;
        if (attempt >= MAX_ATTEMPTS) throw err;
        await sleep(500 * Math.pow(2, attempt - 1));
      }
    }

    return false;
  } catch (err) {
    const wrapped = wrapError(err);
    log(
      `[publisher] ERROR publishing to GitHub: ${wrapped} — ` +
        `check GITHUB_TOKEN has Contents: write on ${REPO_OWNER}/${REPO_NAME}, ` +
        `the branch "${BRANCH}" exists, and the API path is valid.`,
    );
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function wrapError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data;
    const detailStr =
      typeof detail === "string"
        ? detail
        : JSON.stringify(detail ?? err.message);
    return `${err.message} (${err.response?.status ?? "no-status"}): ${detailStr}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function runOnce(): Promise<boolean> {
  const now = Date.now();
  const tokens = await buildPayload(now);

  if (tokens.length === 0) {
    log("[publisher] ERROR: no reusable real price could be fetched — skipping publish.");
    return false;
  }

  if (tokens.length < SYMBOL_SPECS.length) {
    const missing = SYMBOL_SPECS.map((s) => s.symbol).filter(
      (sym) => !tokens.some((t) => t.symbol === sym),
    );
    log(
      `[publisher] WARNING: ${SYMBOL_SPECS.length - tokens.length} symbol(s) omitted ` +
        `(no real price available): ${missing.join(", ")}`,
    );
  }

  return await publishToGitHub(tokens);
}

async function runLoop(): Promise<void> {
  log(
    `[publisher] Starting continuous publish loop → ` +
      `${REPO_OWNER}/${REPO_NAME}@${BRANCH}:${PRICES_FILE} ` +
      `(every ${POLL_INTERVAL_MS}ms, refresh upstream every ${REFRESH_INTERVAL_MS}ms)`,
  );
  await runOnce();
  setInterval(() => {
    void runOnce();
  }, POLL_INTERVAL_MS);
}

// Entry point
const isLoop = process.argv.includes("--loop");
const isDry = process.argv.includes("--dry");
(async () => {
  const canPublish = !!(GITHUB_TOKEN && REPO_OWNER && REPO_NAME);

  if (!GITHUB_TOKEN) {
    log("[publisher] WARNING: GITHUB_TOKEN not set — dry-run mode, nothing will be published.");
  }
  if (!REPO_OWNER || !REPO_NAME) {
    log("[publisher] WARNING: repo owner/name not set — dry-run mode.");
  }

  if (isLoop) {
    if (!canPublish) {
      log("[publisher] ERROR: cannot loop-publish without token + repo. Aborting.");
      process.exit(1);
    }
    await runLoop();
  } else if (isDry || !canPublish) {
    // Dry-run: fetch real prices and print the exact JSON payload without
    // contacting GitHub. Same schema the backend parses.
    const now = Date.now();
    const tokens = await buildPayload(now);
    log(`[publisher] Dry-run payload (${tokens.length} symbols):`);
    log(JSON.stringify(tokens, null, 2));
    process.exit(0);
  } else {
    const ok = await runOnce();
    process.exit(ok ? 0 : 1);
  }
})().catch((err) => {
  log(`[publisher] FATAL: ${wrapError(err)}`);
  process.exit(1);
});
