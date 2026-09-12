/**
 * publishMarketData.ts — REAL DATA PUBLISHER → GITHUB RAW
 *
 * Fetches GENUINE live market prices from free public APIs (the exact same
 * tiered cascade used by ForexDataService: Frankfurter/ECB + CoinGecko) and
 * publishes them to a public GitHub repository's raw file URL via the GitHub
 * Contents API.
 *
 * Every symbol in the platform's strict 34-pair OTC whitelist (see
 * symbolRegistry.service.ts) is included, so the backend tick ingestion
 * pipeline never hits "All spot rate sources exhausted".
 *
 * Output schema — STRICTLY the array-of-ticks form parsed by the backend:
 *
 *   [
 *     { "symbol": "EUR/USD", "price": 1.1578, "timestamp": 1725294500000 },
 *     { "symbol": "BTC/USD", "price": 61200.5, "timestamp": 1725294500000 }
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

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

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
const FRANKFURTER_BASE = "https://api.frankfurter.app";
const OPEN_ER_API_BASE = "https://open.er-api.com/v6/latest";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

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
  kind: "forex" | "crypto";
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE FULL 34-PAIR WHITELIST (mirrors symbolRegistry.service.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_SPECS: SymbolSpec[] = [
  // Forex majors
  { symbol: "EUR/USD", base: "EUR", quote: "USD", digits: 5, kind: "forex" },
  { symbol: "GBP/USD", base: "GBP", quote: "USD", digits: 5, kind: "forex" },
  { symbol: "USD/JPY", base: "USD", quote: "JPY", digits: 3, kind: "forex" },
  { symbol: "USD/CHF", base: "USD", quote: "CHF", digits: 5, kind: "forex" },
  { symbol: "USD/CAD", base: "USD", quote: "CAD", digits: 5, kind: "forex" },
  { symbol: "AUD/USD", base: "AUD", quote: "USD", digits: 5, kind: "forex" },
  { symbol: "NZD/USD", base: "NZD", quote: "USD", digits: 5, kind: "forex" },
  // Crypto majors
  { symbol: "BTC/USD", base: "bitcoin", quote: "USD", digits: 2, kind: "crypto" },
  { symbol: "ETH/USD", base: "ethereum", quote: "USD", digits: 2, kind: "crypto" },
  // Euro crosses
  { symbol: "EUR/GBP", base: "EUR", quote: "GBP", digits: 5, kind: "forex" },
  { symbol: "EUR/JPY", base: "EUR", quote: "JPY", digits: 3, kind: "forex" },
  { symbol: "EUR/CHF", base: "EUR", quote: "CHF", digits: 5, kind: "forex" },
  { symbol: "EUR/AUD", base: "EUR", quote: "AUD", digits: 5, kind: "forex" },
  { symbol: "EUR/CAD", base: "EUR", quote: "CAD", digits: 5, kind: "forex" },
  { symbol: "EUR/NZD", base: "EUR", quote: "NZD", digits: 5, kind: "forex" },
  { symbol: "EUR/TRY", base: "EUR", quote: "TRY", digits: 5, kind: "forex" },
  // Pound crosses
  { symbol: "GBP/JPY", base: "GBP", quote: "JPY", digits: 3, kind: "forex" },
  { symbol: "GBP/CHF", base: "GBP", quote: "CHF", digits: 5, kind: "forex" },
  { symbol: "GBP/AUD", base: "GBP", quote: "AUD", digits: 5, kind: "forex" },
  { symbol: "GBP/CAD", base: "GBP", quote: "CAD", digits: 5, kind: "forex" },
  // Yen crosses
  { symbol: "AUD/JPY", base: "AUD", quote: "JPY", digits: 3, kind: "forex" },
  { symbol: "CAD/JPY", base: "CAD", quote: "JPY", digits: 3, kind: "forex" },
  { symbol: "CHF/JPY", base: "CHF", quote: "JPY", digits: 3, kind: "forex" },
  // Other minors
  { symbol: "AUD/CAD", base: "AUD", quote: "CAD", digits: 5, kind: "forex" },
  { symbol: "AUD/NZD", base: "AUD", quote: "NZD", digits: 5, kind: "forex" },
  { symbol: "NZD/JPY", base: "NZD", quote: "JPY", digits: 3, kind: "forex" },
  { symbol: "CAD/CHF", base: "CAD", quote: "CHF", digits: 5, kind: "forex" },
  { symbol: "EUR/RUB", base: "EUR", quote: "RUB", digits: 5, kind: "forex" },
  // Emerging / OTC variants
  { symbol: "USD/TRY", base: "USD", quote: "TRY", digits: 5, kind: "forex" },
  { symbol: "USD/ZAR", base: "USD", quote: "ZAR", digits: 5, kind: "forex" },
  { symbol: "USD/MXN", base: "USD", quote: "MXN", digits: 5, kind: "forex" },
  { symbol: "USD/SGD", base: "USD", quote: "SGD", digits: 5, kind: "forex" },
  { symbol: "MAD/USD", base: "MAD", quote: "USD", digits: 5, kind: "forex" },
  { symbol: "KES/USD", base: "KES", quote: "USD", digits: 5, kind: "forex" },
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

const cryptoPriceCache = new Map<
  string,
  { price: number; ts: number }
>();

/**
 * Fetch a real live rate for one symbol.
 * Returns null if NO source can produce a genuine price (symbol is omitted).
 */
async function fetchRealPrice(spec: SymbolSpec): Promise<number | null> {
  try {
    if (spec.kind === "crypto") {
      return await fetchCryptoPrice(spec);
    }
    return await fetchForexPrice(spec);
  } catch (err) {
    log(`[publisher] Price fetch failed for ${spec.symbol}: ${
      err instanceof Error ? err.message : String(err)
    }`);
    return null;
  }
}

/** Fetch a USD price for BTC/ETH via CoinGecko. */
async function fetchCryptoPrice(spec: SymbolSpec): Promise<number | null> {
  const cached = cryptoPriceCache.get(spec.symbol);
  if (cached && Date.now() - cached.ts < REFRESH_INTERVAL_MS) {
    return cached.price;
  }

  const url = `${COINGECKO_BASE}/simple/price?ids=${spec.base}&vs_currencies=usd`;
  const res = await http.get(url);
  const price = Number(res.data?.[spec.base]?.usd);

  if (!Number.isFinite(price) || price <= 0) return null;

  cryptoPriceCache.set(spec.symbol, { price, ts: Date.now() });
  return price;
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
