/**
 * standaloneFeed.service.ts — STANDALONE SaaS MODE fallback feed.
 *
 * WHAT THIS SOLVES
 * ────────────────
 * The whole platform (charts, candle aggregator, live-quant scorer, n8n signal
 * rendering) is fed by the Pocket Option bridge. When that bridge is offline —
 * no SSID, expired session, relay down — the tape goes cold: no `live_tick`,
 * `last_tick` climbs past 2s, the terminal shows "WAITING FOR REAL-TIME TICK"
 * and every action button locks. This service keeps the platform USABLE without
 * the PO dependency by authoring a continuous, honestly-labeled fallback tape:
 *
 *   • NON-OTC pairs (real forex + crypto) → the REAL public proxy cascade
 *     (Yahoo → Frankfurter → open.er-api → GitHub), tagged
 *     `source: "standalone:<tier>"`. Real prices, never fabricated.
 *   • OTC pairs → a LABELED synthetic random walk (see below), tagged
 *     `source: "standalone_synthetic"` + `synthetic: true`. OTC instruments have
 *     no public source (they are broker-internal), so this is the only way to
 *     keep their tape alive — and it is ALWAYS disclosed to the client.
 *
 * AUTHORITY: Pocket Option WINS whenever it is genuinely live. Every beat first
 * asks the bridge for its feed status; if it reports "live" the service stands
 * down entirely (no tick, no status) and lets the real PO path own the tape.
 * `standaloneState` broadcasts that decision so `tickIngestion` does not double
 * author the same symbol.
 *
 * THE SYNTHETIC WALK (OTC only) — DESIGN
 * ──────────────────────────────────────
 * A synthetic OTC price is anchored to the REAL underlying pair's public spot
 * (refreshed slowly, e.g. every 30s) and evolves as a mean-reverting random
 * walk clamped to a narrow band around that anchor:
 *
 *     step  = price * STEP_PCT * N(0,1) + (anchor - price) * MEAN_REVERT
 *     price = clamp(price + step, anchor·(1±MAX_DRIFT))
 *
 * The mean-reversion keeps it tethered to reality (it cannot wander off), the
 * clamp bounds it, and the small per-tick step yields a plausible micro-tape.
 * It is a simulation and is labeled as one everywhere it surfaces.
 */

import { logger } from "../utils/logger";
import secrets from "../config/secrets";
import { symbolRegistry, type SymbolEntry } from "./symbolRegistry.service";
import { forexDataService } from "./forexData.service";
import { pocketOptionBridgeService } from "./pocketOptionBridge.service";
import { websocketService } from "./websocket.service";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";
import { standaloneState, type StandaloneFeedMode } from "../lib/standaloneState";

/** Per-tick fractional step of the synthetic OTC walk (std-dev of the noise). */
const OTC_STEP_PCT = 0.0006;
/** Hard band: synthetic price can never drift further than this from anchor. */
const OTC_MAX_DRIFT_PCT = 0.005;
/** Mean-reversion pull toward the anchor each tick (fraction of the gap). */
const OTC_MEAN_REVERT = 0.03;
/** How long a fetched OTC anchor stays valid before a refresh attempt. */
const ANCHOR_REFRESH_MS = 30_000;
/** Default 1s beat — keeps `last_tick` well under the client's 2s stale gate. */
const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Static anchor seeds for the majors, in case even the public proxy is
 * unreachable at cold start (offline dev box). These are only the FIRST anchor;
 * a real public print replaces them on the first successful refresh. They exist
 * so the synthetic OTC tape can start within a tick instead of waiting on a
 * network round-trip.
 */
const SEED_ANCHORS: Record<string, number> = {
  "EUR/USD": 1.08,
  "GBP/USD": 1.27,
  "USD/JPY": 150.0,
  "AUD/USD": 0.66,
  "USD/CAD": 1.36,
  "USD/CHF": 0.88,
  "NZD/USD": 0.6,
  "EUR/GBP": 0.85,
  "EUR/JPY": 162.0,
  "GBP/JPY": 190.0,
};

export interface SyntheticParams {
  stepPct: number;
  maxDriftPct: number;
  meanRevert: number;
}

/**
 * PURE synthetic step — deterministic given (prev, anchor, rand). Extracted so
 * the band/mean-reversion invariants are unit-testable without a running
 * service or a live network.
 *
 * @param prev    previous synthetic price (> 0)
 * @param anchor  real reference price the walk is tethered to (> 0)
 * @param rand    a uniform sample in [0,1) (the caller supplies Math.random)
 */
export function nextSyntheticPrice(
  prev: number,
  anchor: number,
  rand: () => number,
  params: SyntheticParams = {
    stepPct: OTC_STEP_PCT,
    maxDriftPct: OTC_MAX_DRIFT_PCT,
    meanRevert: OTC_MEAN_REVERT,
  },
): number {
  // Box–Muller: two uniforms → one standard-normal sample.
  const u1 = Math.max(rand(), Number.EPSILON);
  const u2 = rand();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  const noise = prev * params.stepPct * normal;
  const reversion = (anchor - prev) * params.meanRevert;
  const step = noise + reversion;

  const lo = anchor * (1 - params.maxDriftPct);
  const hi = anchor * (1 + params.maxDriftPct);
  const next = Math.min(hi, Math.max(lo, prev + step));

  // Never emit a non-positive / non-finite price from the synthetic path.
  if (!Number.isFinite(next) || next <= 0) return anchor;
  return next;
}

interface SyntheticState {
  price: number;
  anchor: number;
  anchorAt: number;
}

export class StandaloneFeedService {
  private static instance: StandaloneFeedService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Cached registry universe (the whitelist is static). */
  private universe: SymbolEntry[] = [];
  /** Per-OTC-symbol synthetic walk state. */
  private synth: Map<string, SyntheticState> = new Map();
  /** Last broadcast mode, so `feed_status` is only re-emitted on change. */
  private lastMode: StandaloneFeedMode | null = null;

  private constructor() {}

  public static getInstance(): StandaloneFeedService {
    if (!StandaloneFeedService.instance) {
      StandaloneFeedService.instance = new StandaloneFeedService();
    }
    return StandaloneFeedService.instance;
  }

  private get enabled(): boolean {
    return secrets.STANDALONE_FEED_ENABLED;
  }

  private get syntheticOtcEnabled(): boolean {
    return secrets.STANDALONE_SYNTHETIC_OTC;
  }

  /** Begin the standalone fallback feed (idempotent). */
  public start(): void {
    if (this.running) return;
    if (!this.enabled) {
      logger.info(
        "[StandaloneFeed] Disabled via STANDALONE_FEED_ENABLED — not starting",
      );
      return;
    }
    this.running = true;

    void symbolRegistry
      .getAll()
      .then((entries) => {
        this.universe = entries;
      })
      .catch((err) => {
        logger.warn("[StandaloneFeed] Failed to load symbol universe", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    this.timer = setInterval(() => {
      void this.beat();
    }, DEFAULT_INTERVAL_MS);
    // Do not keep the process alive solely for this timer.
    if (typeof this.timer.unref === "function") this.timer.unref();

    logger.info("[StandaloneFeed] Standalone fallback feed started", {
      intervalMs: DEFAULT_INTERVAL_MS,
      syntheticOtc: this.syntheticOtcEnabled,
    });
  }

  /** Stop the feed and return to the inactive/"live" state. */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.synth.clear();
    this.lastMode = null;
    standaloneState.reset();
    logger.info("[StandaloneFeed] Standalone fallback feed stopped");
  }

  /** True while the standalone fallback feed is authoring ticks. */
  public isActive(): boolean {
    return standaloneState.isActive();
  }

  /** One emission beat — see the module header for the authority rule. */
  private async beat(): Promise<void> {
    // ── AUTHORITY: PO WINS ──
    // While the bridge reports a genuine "live" feed, stand down completely so
    // it owns every tick. Only on the transition do we announce the hand-back.
    const poStatus = pocketOptionBridgeService.getCurrentFeedStatus().status;
    if (poStatus === "live") {
      if (this.lastMode !== "live") {
        this.lastMode = "live";
        standaloneState.reset();
        // Restore the bridge's own status to the client. Observational: a
        // failure here must never stop the emitter.
        try {
          websocketService.broadcastFeedStatus("live");
        } catch {
          /* best-effort */
        }
      }
      return;
    }

    if (this.universe.length === 0) {
      // Universe not resolved yet — retry on the next beat.
      try {
        this.universe = await symbolRegistry.getAll();
      } catch {
        return;
      }
      if (this.universe.length === 0) return;
    }

    let proxyPairs = 0;
    let syntheticPairs = 0;

    for (const entry of this.universe) {
      try {
        if (entry.assetSubType === "otc") {
          if (!this.syntheticOtcEnabled) continue;
          if (await this.emitSynthetic(entry)) syntheticPairs++;
        } else {
          if (await this.emitProxy(entry)) proxyPairs++;
        }
      } catch (err) {
        logger.debug("[StandaloneFeed] Symbol beat failed", {
          symbol: entry.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const mode: Exclude<StandaloneFeedMode, "live"> =
      proxyPairs > 0 && syntheticPairs > 0
        ? "mixed"
        : syntheticPairs > 0
          ? "standalone_synthetic"
          : "standalone_proxy";

    standaloneState.set({
      active: true,
      mode,
      proxyPairs,
      syntheticPairs,
    });

    // Emit feed_status EVERY beat: the client's 1s heartbeat-age sweep flips to
    // "disconnected" if no authoritative frame arrives, so the standalone mode
    // must keep the frame fresh — not only on a mode change. The log line stays
    // change-gated to avoid 1Hz spam.
    const changed = this.lastMode !== mode;
    this.lastMode = mode;
    this.broadcastStandaloneStatus(mode, proxyPairs, syntheticPairs, changed);
  }

  /**
   * NON-OTC path — a REAL public proxy print. Returns true only when a genuine
   * fresh price was broadcast. Market-closed / stale / failed symbols are
   * skipped (never fabricated): between the weekly forex close and Sunday open
   * a real pair is legitimately quiet, and that is surfaced honestly.
   */
  private async emitProxy(entry: SymbolEntry): Promise<boolean> {
    const spot = await forexDataService.getLiveSpotFresh(entry.symbol);
    if (
      !spot.success ||
      spot.price == null ||
      !Number.isFinite(spot.price) ||
      spot.price <= 0 ||
      spot.stale === true ||
      spot.marketClosed === true
    ) {
      return false;
    }

    const source = `standalone:${spot.source}`;
    const price = Number(spot.price.toFixed(entry.digits));
    const ts = new Date().toISOString();

    realtimeTickBuffer.append(entry.symbol, price, {
      source,
      tsMs: Date.now(),
    });
    websocketService.broadcastLiveTick({
      symbol: entry.symbol,
      price,
      timestamp: ts,
      source,
      bid: spot.bid,
      ask: spot.ask,
    });
    return true;
  }

  /**
   * OTC path — the LABELED synthetic random walk. Always returns true (a seed
   * anchor guarantees a price even with the public proxy fully unreachable), so
   * an OTC chart never goes cold in standalone mode.
   */
  private async emitSynthetic(entry: SymbolEntry): Promise<boolean> {
    const symbol = entry.symbol;
    const now = Date.now();
    let st = this.synth.get(symbol);

    if (!st) {
      const anchor = await this.resolveAnchor(entry, null);
      st = { price: anchor, anchor, anchorAt: now };
      this.synth.set(symbol, st);
    } else if (now - st.anchorAt >= ANCHOR_REFRESH_MS) {
      st.anchor = await this.resolveAnchor(entry, st.anchor);
      st.anchorAt = now;
    }

    const next = nextSyntheticPrice(st.price, st.anchor, Math.random);
    st.price = Number(next.toFixed(entry.digits));

    const source = "standalone_synthetic";
    const ts = new Date().toISOString();

    realtimeTickBuffer.append(symbol, st.price, {
      source,
      synthetic: true,
      tsMs: now,
    });
    websocketService.broadcastLiveTick({
      symbol,
      price: st.price,
      timestamp: ts,
      source,
      synthetic: true,
    });
    return true;
  }

  /**
   * Resolve the real anchor for an OTC symbol: the underlying pair's public
   * spot when reachable, else the last known anchor, else a static seed.
   */
  private async resolveAnchor(
    entry: SymbolEntry,
    previous: number | null,
  ): Promise<number> {
    try {
      const spot = await forexDataService.getLiveSpotFresh(entry.symbol);
      if (
        spot.success &&
        spot.price != null &&
        Number.isFinite(spot.price) &&
        spot.price > 0
      ) {
        return spot.price;
      }
    } catch {
      /* fall through to previous / seed */
    }
    if (previous != null && previous > 0) return previous;
    return SEED_ANCHORS[entry.symbol] ?? 1;
  }

  private broadcastStandaloneStatus(
    mode: Exclude<StandaloneFeedMode, "live">,
    proxyPairs: number,
    syntheticPairs: number,
    logChange: boolean,
  ): void {
    try {
      websocketService.broadcastFeedStatus("standalone", {
        heartbeatAgeMs: 0,
        feedMode: mode,
        proxyPairs,
        syntheticPairs,
      });
      if (logChange) {
        logger.info("[StandaloneFeed] Standalone mode engaged", {
          mode,
          proxyPairs,
          syntheticPairs,
        });
      }
    } catch (err) {
      logger.debug("[StandaloneFeed] feed_status broadcast failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const standaloneFeedService = StandaloneFeedService.getInstance();
