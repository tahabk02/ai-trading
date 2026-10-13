/**
 * verify-e2e/types.ts — PART 47 [525] shared shapes for the offline E2E harness.
 *
 * Everything here is plain data so the harness can run with NO network, NO DB,
 * NO browser and NO live PO session. A cell that genuinely needs one of those
 * is reported as `N/A` WITH A REASON — never as a pass.
 */

/** One raw tick on the BROKER clock (fixture-authoritative, never Date.now()). */
export interface Tick {
  tsMs: number;
  price: number;
  volume?: number;
  /** Provenance of this print, e.g. `pocket_option_ws` or a proxy source. */
  source?: string;
}

export type AssetClass = "otc" | "real" | "crypto";

/** One captured replay fixture: >= 30 min of ticks for one symbol. */
export interface Fixture {
  symbol: string;
  assetClass: AssetClass;
  /** Source stamped on every tick of this fixture unless a tick overrides it. */
  source: string;
  /** Fixture-authoritative broker-clock start, epoch ms. */
  startMs: number;
  intervalMs: number;
  spanMinutes: number;
  ticks: Tick[];
}

/** A closed OHLCV bar, timeframe-agnostic (oracle + server both produce this). */
export interface Bar {
  timestamp: number; // bucket-start, broker-clock epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type CheckStatus = "PASS" | "FAIL" | "N/A";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  /** Human-readable verdict. For FAIL: the explicit failure message. */
  message: string;
  /** Why an N/A cell is unavailable (REQUIRED for every N/A). */
  reason?: string;
  /** Optional compact evidence (e.g. counts). */
  detail?: string;
}

/** One deliberate defect injected to prove a check is load-bearing. */
export interface MutationResult {
  id: string;
  name: string;
  /** The check id this mutation is designed to break. */
  targets: string;
  /** True when the targeted check produced an explicit FAIL. */
  caught: boolean;
  /** The explicit FAIL message the check emitted (or why it was NOT caught). */
  message: string;
}

/** A post-expiry settlement record as the product would log it. */
export interface SettlementRecord {
  symbol: string;
  direction: "BUY" | "SELL";
  entryBucketSec: number;
  expiryBucketSec: number;
  entry: number;
  exitPrice: number;
  outcome: "WIN" | "LOSS";
}

/**
 * Values computed by the PRODUCTION helpers (imported by the runner) so a
 * check can compare the shipping rule against the independent oracle. A
 * mutation corrupts these to prove the comparison is load-bearing.
 */
export interface ProductSurface {
  /** expiry marker bucket per (tfSec, expirationSec), from the product helper. */
  expirySlots: Array<{ tfSec: number; expirationSec: number; slotSec: number }>;
  /** target ladder per (tfSec, expirationSec), from the product helper. */
  targetLadders: Array<{ tfSec: number; expirationSec: number; slots: number[] }>;
  /** TIMER expiry bucket per (entrySec, durationSec), from the product helper. */
  timerExpiries: Array<{ entrySec: number; durationSec: number; expirySec: number }>;
}

export interface E2EContext {
  sha: string;
  generatedAtIso: string;
  fixtures: Fixture[];
  /** symbol -> timeframe -> server-aggregator closed bars. */
  server: Map<string, Map<string, Bar[]>>;
  /** symbol -> timeframe -> INDEPENDENT oracle closed bars. */
  oracle: Map<string, Map<string, Bar[]>>;
  /** Broker-clock now (fixture-authoritative) for staleness/coherence math. */
  brokerNowMs: number;
  /** The full server timeframe ladder under test. */
  timeframes: string[];
  tfMs: Record<string, number>;
  /** Product-computed slot/timer values (see ProductSurface). */
  product: ProductSurface;
  /** Post-expiry settlements the product would have logged. */
  settlements: SettlementRecord[];
}
