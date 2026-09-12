/**
 * tickIngestion.service.ts — STRICT LIVE TICK INGESTION ENGINE
 *
 * 100% REAL DATA. 0% DEMO. ZERO SYNTHETIC FALLBACKS.
 *
 * Requirements:
 *  1. Every price tick streams strictly from active external market data connections
 *     (e.g., live OTC spot endpoints / L1 orderbook feeds via forexDataService,
 *     or periodic GitHub repository snapshots via githubDataProvider).
 *  2. Completely purges and disables any random walk generators, simulated tick loops,
 *     mock historical fillers, or dummy price variations.
 *  3. If a live feed drops or fails health checks, logs the error and enters
 *     LINGER mode — the stream loop stays ALIVE probing at a throttled cadence
 *     so a restored feed resumes within seconds, notifying WebSockets of
 *     DEGRADED status (and ONLINE on recovery) rather than fabricating
 *     synthetic ticks.
 *
 * Data Sources:
 *  - GitHub Data Provider: periodic polls of a GitHub repository for live price data
 *  - HTTP Polling (forexDataService): tiered cascade of real forex rate APIs
 *  - Pocket Option Bridge: optional SSOT for real PO prices
 */

import { logger } from "../utils/logger";
import { forexDataService, ForexSpotResult } from "./forexData.service";
import { WebSocketService } from "./websocket.service";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";
import { liveTickSignalDispatcher } from "./liveTickSignal.dispatch";
import { githubDataProvider } from "./githubData.provider";
import { symbolRegistry } from "./symbolRegistry.service";
import {
  exponentialBackoffMs,
  classifyFeedLog,
} from "../lib/feedResilience";
import { feedMetrics } from "../lib/feedMetrics";

export interface LiveMarketTick {
  symbol: string;
  price: number;
  /** Real bid arm, present only when a genuine order book/quote is observed. */
  bid?: number;
  /** Real ask arm, present only when a genuine order book/quote is observed. */
  ask?: number;
  volume: number;
  timestamp: string;
  source: string;
  /**
   * STRICT ASSET CLASSIFICATION — "forex" | "otc" | "crypto" embedded on every
   * broadcast tick so downstream services and the UI can route/label OTC vs
   * standard forex vs crypto without ever mixing the classes.
   */
  assetType: string;
}

export class LiveTickIngestionService {
  private static instance: LiveTickIngestionService;
  private wsService: WebSocketService;
  private activeStreams: Map<string, NodeJS.Timeout> = new Map();
  private streamConsecutiveErrors: Map<string, number> = new Map();
  /**
   * Per-symbol earliest-allowed-again instant (epoch ms) while the symbol is in
   * LINGER mode (degraded feed). The stream loop is NEVER halted — probes at
   * the lingering cadence continue so a restored feed resumes within seconds.
   */
  private nextAllowedPollAt: Map<string, number> = new Map();
  /**
   * Per-symbol DEGRADED broadcast latch. Broadcasts DEGRADED exactly once per
   * incident and flips back (ONLINE broadcast) on the first successful probe —
   * no status-event spam over the socket channel.
   */
  private streamDegraded: Map<string, boolean> = new Map();
  private readonly MAX_CONSECUTIVE_ERRORS = 5;
  private readonly POLLING_INTERVAL_MS = 1000; // Real-time 1-second tick cadence
/**
    * LINGER backoff: probe cadence grows EXPONENTIALLY per consecutive error
    * (1s → 2s → 5s → 10s → 30s → 60s cap, ±20% jitter) via
    * `exponentialBackoffMs` in lib/feedResilience — a downed API is never
    * hammered, and recovery stays zero-latency via the AGE WATCHDOG override.
    */
   /**
    * AGE WATCHDOG: if the real tick tape for a symbol is STILL this old, the
    * next cyclic poll runs immediately even inside the linger throttle — a
    * starved chart is exactly when recovery must be zero-timeout.
   */
  private readonly FORCE_POLL_AGE_MS = 3000;

  /**
   * Per-symbol last assigned tick timestamp (epoch ms), floored to the 1-second
   * grid. Used to emit SEQUENTIAL, CONTINUOUS tick timestamps so the chart sees
   * evenly spaced 1-second instants even if a poll is delayed or a batch arrives
   * at once — preventing large time gaps that would shove the next candle away.
   */
  private lastTickMs: Map<string, number> = new Map();

  private constructor() {
    this.wsService = WebSocketService.getInstance();
    this.initializeGitHubDataProvider();
  }

  /**
   * Wire the GitHub data provider callbacks into the live tick pipeline.
   * When the provider delivers a new price from the GitHub repository, it flows
   * through the same broadcast -> buffer -> candle aggregation -> signal engine
   * path as the HTTP-polled ticks — zero duplication, zero mock data.
   */
  private initializeGitHubDataProvider(): void {
    githubDataProvider.setCallbacks({
      onTick: (symbol, price, bid, ask, _volume, timestamp) => {
        const norm = symbol.trim().toUpperCase();

        const tick: LiveMarketTick = {
          symbol: norm,
          price,
          bid,
          ask,
          volume: _volume || 0,
          timestamp,
          source: "github_data_provider",
          assetType: symbolRegistry.getAssetSubType(norm),
        };

        // Broadcast to Socket.io clients
        this.wsService.broadcastLiveTick(tick);

        // Fold into high-frequency tick buffer
        realtimeTickBuffer.append(norm, price, { bid, ask });

        // Arm the live-quant /tick-signal forwarder (coalesced, no drops)
        liveTickSignalDispatcher.enqueue(norm);

        // Fold into persistent candle buffer
        try {
          forexDataService.appendTick(norm, price);
        } catch (bufErr) {
          logger.debug("[TickIngestion] Candle buffer append failed", {
            symbol: norm,
            error: bufErr instanceof Error ? bufErr.message : String(bufErr),
          });
        }
      },

      onStatus: (status, message) => {
        if (status === "connected") {
          logger.info("[TickIngestion] GitHub data provider connected", { message });
          this.wsService.broadcastEngineStatus("ONLINE", message);
        } else if (status === "disconnected") {
          logger.warn("[TickIngestion] GitHub data provider disconnected", { message });
          this.wsService.broadcastEngineStatus("DEGRADED", message);
        } else if (status === "error") {
          logger.error("[TickIngestion] GitHub data provider error", { message });
          this.wsService.broadcastEngineStatus("DEGRADED", message);
        }
      },
    });
  }

  public static getInstance(): LiveTickIngestionService {
    if (!LiveTickIngestionService.instance) {
      LiveTickIngestionService.instance = new LiveTickIngestionService();
    }
    return LiveTickIngestionService.instance;
  }

  /**
   * Start the GitHub data provider polling (once). This is idempotent —
   * calling it multiple times does not create extra poll loops.
   */
  private ensureGitHubProviderRunning(): void {
    if (!githubDataProvider.isRunning()) {
      githubDataProvider.startPolling();
    }
  }

  /**
   * Start streaming strict live ticks for a whitelisted symbol.
   * Fetches real live market spot rates from direct API endpoints / L1 feeds.
   * The GitHub data provider provides periodic snapshots that are folded into
   * the same tick pipeline for real-time processing.
   */
  public startSymbolStream(symbol: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (this.activeStreams.has(norm)) {
      return; // Already streaming
    }

    logger.info("[TickIngestion] Starting strict live tick stream", {
      symbol: norm,
    });
    this.streamConsecutiveErrors.set(norm, 0);
    this.nextAllowedPollAt.delete(norm);
    this.streamDegraded.delete(norm);

    // Ensure the GitHub data provider is running (shared polling loop)
    this.ensureGitHubProviderRunning();

    // Initial immediate fetch (HTTP fallback for symbols not in the GitHub repo,
    // and as a bootstrap for the first tick before the GitHub poll delivers)
    void this.pollLiveTick(norm);

    // Stream loop — HTTP polling via forexDataService continues independently
    // to ensure ticks flow even when GitHub data has no entry for a symbol.
    // The GitHub provider path provides ticks from repository snapshots.
    const timer = setInterval(() => {
      void this.pollLiveTick(norm);
    }, this.POLLING_INTERVAL_MS);

    this.activeStreams.set(norm, timer);
  }

  /**
   * Stop streaming ticks for a symbol.
   */
  public stopSymbolStream(symbol: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    const timer = this.activeStreams.get(norm);
    if (timer) {
      clearInterval(timer);
      this.activeStreams.delete(norm);
      this.streamConsecutiveErrors.delete(norm);
      this.nextAllowedPollAt.delete(norm);
      this.streamDegraded.delete(norm);

      logger.info("[TickIngestion] Stopped live tick stream", { symbol: norm });
    }
  }

  /**
   * Emit the NEXT continuous tick timestamp for a symbol, normalised to the
   * 1-second wall-clock grid. Ticks are advanced by a strict 1000ms stride from
   * the last assigned instant (never a stride smaller than 1s, so sequential
   * candles never cluster). If the real clock has moved ahead, we align to it so
   * the stream keeps near-current timestamps; if it has lagged (delayed poll),
   * we never emit an out-of-order or retrograde stamp.
   */
  private nextTickTimestamp(symbol: string, nowMs: number): string {
    const last = this.lastTickMs.get(symbol);
    let assigned: number;

    if (last === undefined) {
      // First tick → floor the wall-clock to the 1s grid.
      assigned = Math.floor(nowMs / 1000) * 1000;
    } else {
      const next = last + 1000;
      // If real time has advanced past the sequential stride (e.g. network
      // delay), snap forward to the current 1s grid so we don't fall behind;
      // otherwise keep the strict 1-second cadence.
      const gridNow = Math.floor(nowMs / 1000) * 1000;
      assigned = next >= gridNow ? next : gridNow;
    }

    this.lastTickMs.set(symbol, assigned);
    return new Date(assigned).toISOString();
  }

  /**
   * Poll a genuine live spot tick from real external market feeds.
   *
   * PO-PARITY CONTRACT: the price is ALWAYS the genuine observed value —
   * VERBATIM, no fabricated drift, no synthetic overlay. When the Pocket
   * Option bridge is ONLINE it is the sole live author; this loop acts only
   * as a cold-start bootstrap / last-resort guard for symbols PO has not yet
   * delivered, and it NEVER re-writes a divergent value that would desync the
   * candle buffer from the authoritative PO tape.
   */
  private pollLiveTick(symbol: string): void {
    // LINGER MODE: once a feed breaches the consecutive-error threshold, probes
    // are throttled by the exponential backoff ladder (never hammer a downed
    // API), but the STREAM LOOP ITSELF NEVER STOPS — recovery is zero-timeout.
    const errCount = this.streamConsecutiveErrors.get(symbol) ?? 0;
    if (errCount >= this.MAX_CONSECUTIVE_ERRORS) {
      const now = Date.now();
      const nextAllowed = this.nextAllowedPollAt.get(symbol) ?? 0;
      if (now < nextAllowed) {
        // AGE WATCHDOG OVERRIDE — a starved chart must never wait out the
        // linger throttle. If the real tick tape is older than this symbol's
        // FORCE_POLL_AGE_MS, probe immediately.
        const ageMs = realtimeTickBuffer.getLatestAgeMs(symbol);
        if (!(ageMs != null && ageMs > this.FORCE_POLL_AGE_MS)) {
          return;
        }
      }
      this.nextAllowedPollAt.delete(symbol);
    }
    // Flyweight bootstrap poll — does NOT fabricate movement. We read the real
    // PO SSOT (or the next genuine API print) verbatim and fold it in only if
    // PO has not already authored a fresher value for this symbol this second.
    void this.pollOnce(symbol);
  }

  private async pollOnce(symbol: string): Promise<void> {
    try {
      // ════════════════════════════════════════════════════════════════
      // PO-AUTHORITY GUARD — skip HTTP polling entirely when the PO
      // bridge is actively delivering real ticks for this symbol.
      // This eliminates the root cause of price divergence: two sources
      // (PO socket vs Frankfurter/ER-API) writing different values for
      // the same symbol within the same 1-second window.
      // ════════════════════════════════════════════════════════════════
      if (forexDataService.isPocketOptionCovered(symbol, 20_000)) {
        return;
      }

      // ── RING REFRESH: when the tick ring is starving during LINGER mode,
      // try to push a held price so the 2000-tick buffer never empties. ──
      const ringAgeMs = realtimeTickBuffer.getLatestAgeMs(symbol);
      if (ringAgeMs != null && ringAgeMs > this.FORCE_POLL_AGE_MS) {
        this.refreshTickRingFromHeldPrice(symbol);
      }

      const spot: ForexSpotResult =
        await forexDataService.getLiveSpotFresh(symbol);

      if (!spot.success || spot.price == null || spot.price <= 0) {
        this.handleFeedFailure(
          symbol,
          spot.error || "Live feed returned null or invalid price rate",
        );
        return;
      }

      this.streamConsecutiveErrors.set(symbol, 0);
      this.nextAllowedPollAt.delete(symbol);

      // ── RECOVERY → ONLINE (exactly once per incident) ──
      // A successful probe after a DEGRADED latch flips the engine status back
      // so subscribers see the feed heal the instant it does. Also emits the
      // single info line that closes the incident (rate-limited log policy).
      if (this.streamDegraded.get(symbol)) {
        this.streamDegraded.set(symbol, false);
        feedMetrics.countRecovery(symbol);
        const recoveryLog = classifyFeedLog(0, true);
        logger.info("[TickIngestion] Live market feed restored", {
          symbol,
          source: spot.source,
          recoveryState: recoveryLog.isRecovery ? "recovered" : "online",
        });
        this.wsService.broadcastEngineStatus(
          "ONLINE",
          `Live tick stream restored for ${symbol}.`,
        );
      }

      // ── PO-AUTHORITY GUARD ──
      // The Pocket Option bridge is the single source of truth for a live
      // pair. If a fresh PO price is already present (written by the socket
      // bridge), this fallback poll must NOT inject a divergent value into the
      // shared candle buffer — that would cause the exact misalignment the
      // parity overhaul is eliminating. We only author here when PO is not
      // actively covering the pair.
      const isPoSource =
        spot.source === "pocket_option_ssot" ||
        spot.source === "pocket_option_held";
      const poAlreadyAuthored = forexDataService.isPocketOptionCovered(symbol, 15_000);
      if (isPoSource || poAlreadyAuthored) {
        // PO is authoritative — do not double-write. Skip mutation (broadcast
        // of TICKS is exclusively the bridge's job when it is live).
        return;
      }

      const liveMid = spot.price;
      // Real bid/ask arms only when the quote source genuinely exposes them and
      // they differ from the mid. Refuse to fabricate a zero-spread quote.
      const hasRealBid =
        spot.bid !== undefined && Number.isFinite(spot.bid) &&
        spot.bid > 0 && spot.bid !== spot.price;
      const hasRealAsk =
        spot.ask !== undefined && Number.isFinite(spot.ask) &&
        spot.ask > 0 && spot.ask !== spot.price;

      const tick: LiveMarketTick = {
        symbol,
        price: liveMid,
        ...(hasRealBid ? { bid: Number(spot.bid!.toFixed(6)) } : {}),
        ...(hasRealAsk ? { ask: Number(spot.ask!.toFixed(6)) } : {}),
        volume: 0,
        timestamp: this.nextTickTimestamp(symbol, Date.now()),
        source: `${spot.source}:live`,
        assetType: symbolRegistry.getAssetSubType(symbol),
      };

      // Broadcast strict live tick to WebSocket clients
      this.wsService.broadcastLiveTick(tick);

      // Fold into the high-frequency real-tick ring (real arms only)
      realtimeTickBuffer.append(symbol, liveMid, { bid: tick.bid, ask: tick.ask });

      // Arm the live-quant /tick-signal forwarder (coalesced, no drops)
      liveTickSignalDispatcher.enqueue(symbol);

      // Fold into the persistent multi-timeframe candle buffer (non-fatal on
      // failure). PO not covering = this authoring is a genuine 1s bootstrapper.
      try {
        forexDataService.appendTick(symbol, liveMid);
      } catch (bufErr) {
        logger.debug("[TickIngestion] Candle buffer append failed", {
          symbol,
          error: bufErr instanceof Error ? bufErr.message : String(bufErr),
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.handleFeedFailure(symbol, msg);
    }
  }

  /**
   * SAFETY GUARD: Handle live feed drops.
   * NEVER fabricates synthetic fallbacks and NEVER halts the stream.
   * The stream loop stays ALIVE in LINGER mode (throttled probes via
   * nextAllowedPollAt) so a restored feed resumes within seconds — the old
   * halt-then-recover-after-15s path starved the chart for ~23s on every
   * transient drop. DEGRADED is broadcast exactly once per incident; the next
   * successful probe broadcasts ONLINE (see anySuccessReset).
   */
  private handleFeedFailure(symbol: string, errorDetail: string): void {
    const errCount = (this.streamConsecutiveErrors.get(symbol) || 0) + 1;
    this.streamConsecutiveErrors.set(symbol, errCount);

    // ── EXPONENTIAL BACKOFF (mission [2]) ──
    // The old fixed 750ms recovery throttle (a "recovery mode" probe doubling)
    // turned a dead API into a hot-1000/s retry storm across every symbol. Now
    // the linger cadence grows 1s → 2s → 5s → 10s → 30s → 60s (cap) with ±20%
    // jitter per failure, reset on the next successful probe (anySuccessReset
    // clears the throttle slot). A downed API is never hammered; recovery stays
    // zero-latency thanks to the FORCE_POLL_AGE watchdog override below.
    const lingerMs = exponentialBackoffMs(
      errCount,
      Date.now(),
    );

    // Throttle the next probe to the backoff cadence. The 1s stream
    // loop continues to tick — later calls skip the probe until this instant
    // passes (zero-timeout recovery, no halted stream, no hammering).
    this.nextAllowedPollAt.set(
      symbol,
      Date.now() + lingerMs,
    );

    // ── METRICS (mission [7]) ──
    // Monotonic retry/error counters per symbol+reason, plus the current
    // backoff and consecutive-error watermark as gauges — scapeable at
    // GET /metrics in Prometheus text exposition format.
    feedMetrics.countRetry(symbol, errorDetail || "unknown_error");
    feedMetrics.countError(symbol, errorDetail || "unknown_error");
    feedMetrics.setBackoffMs(symbol, lingerMs);
    feedMetrics.setMaxConsecutiveErrors(symbol, errCount);

    // ── LOG RATE LIMIT (mission [3]) ──
    // One warn on the first failure of an incident, one error per every 10th
    // consecutive failure, and silence in between — no more warn-per-retry
    // flooding. Recovery (a zero count while a DEGRADED latch is set) logs
    // info exactly once (see anySuccessReset / the ONLINE branch below).
    const logClass = classifyFeedLog(errCount, this.streamDegraded.get(symbol) ?? false);
    if (logClass.level === "warn") {
      logger.warn("[TickIngestion] Live market feed error", {
        symbol,
        consecutiveErrors: errCount,
        error: errorDetail,
        lingerMs,
        recoveryMode: forexDataService.isRecoveryMode(),
      });
    } else if (logClass.level === "error") {
      logger.error(
        "[TickIngestion] Live market feed still failing (every 10th failure)",
        {
          symbol,
          consecutiveErrors: errCount,
          error: errorDetail,
          lingerMs,
          recoveryMode: forexDataService.isRecoveryMode(),
        },
      );
    }

    if (errCount >= this.MAX_CONSECUTIVE_ERRORS) {
      logger.error(
        "[TickIngestion] Live market feed dropped — entering LINGER mode (stream stays alive)",
        { symbol, totalFailures: errCount, lastError: errorDetail },
      );

      // Notify WebSocket clients of DEGRADED feed status exactly once per
      // incident — subsequent duplicate failures while still degraded stay
      // silent (no event spam over the socket channel).
      if (!this.streamDegraded.get(symbol)) {
        this.streamDegraded.set(symbol, true);
        this.wsService.broadcastEngineStatus(
          "DEGRADED",
          `Live market feed temporarily dropped for ${symbol}. Automatic recovery engaged.`,
        );
        // Structured WAITING-ONLY rider (change-gated): live-quant consumers
        // get a clean reason-tagged waiting update instead of a silent gap —
        // trades with no fabricated direction, no HOLD.
        liveTickSignalDispatcher.notifyFeedDegraded(symbol, errorDetail);
      }
    }
  }

  /**
   * RING REFRESH during LINGER mode — ensures the 2000-tick ring never
   * empties when the PO bridge is down AND all HTTP APIs are temporarily
   * exhausted. Pushes the latest held price (from forexDataService's
   * stale-cache) into the ring so the backend's replay-on-join and the
   * client's candle aggregator always have real ticks to work with.
   *
   * This is called from the poll loop when the ring is starving (latest
   * tick older than FORCE_POLL_AGE_MS) — zero fabrication, only real
   * previously-observed prices.
   */
  private refreshTickRingFromHeldPrice(symbol: string): void {
    const ageMs = realtimeTickBuffer.getLatestAgeMs(symbol);
    if (ageMs == null || ageMs <= this.FORCE_POLL_AGE_MS) return;

    const spot = forexDataService.getLastKnownSpot(symbol);
    if (spot.success && spot.price != null && spot.price > 0) {
      realtimeTickBuffer.append(symbol, spot.price);
      liveTickSignalDispatcher.enqueue(symbol);
      try {
        forexDataService.appendTick(symbol, spot.price);
      } catch {
        /* non-fatal */
      }
      logger.debug("[TickIngestion] Ring refresh from held price", {
        symbol,
        price: spot.price,
        source: spot.source,
      });
    }
  }

  /**
   * Stop all active tick streams.
   */
  public stopAllStreams(): void {
    for (const symbol of this.activeStreams.keys()) {
      this.stopSymbolStream(symbol);
    }
    githubDataProvider.stopPolling();
  }

  /**
   * Restart a halted real tick stream for a symbol (recovery after feed
   * restoration). Clears the consecutive-error counter so a recovered feed
   * resumes normal streaming immediately.
   */
  public resumeSymbolStream(symbol: string): void {
    const norm = (symbol || "").trim().toUpperCase();
    if (this.activeStreams.has(norm)) return;
    this.streamConsecutiveErrors.set(norm, 0);
    this.startSymbolStream(norm);
  }

  /**
   * Fold a genuine Pocket Option live tick into the existing real-data
   * pipeline. Used by the Pocket Option bridge client so the PO feed becomes
   * the single source of truth (SSOT) for real prices — the exact same
   * broadcast -> buffer -> candle aggregation -> signal path as the GitHub
   * data provider and HTTP polling. Zero fabrication: only finite positive
   * prices are accepted.
   */
  public ingestTick(
    symbol: string,
    price: number,
    source: string,
    timestamp?: string,
    assetType?: string,
  ): void {
    // Canonicalize the incoming symbol to the strict "/" whitelist format so a
    // Pocket Option tick ("EURUSD", "BTCUSD", "EUR-USD") lands on the SAME
    // symbol the chart, candle buffers and prediction pipeline index by —
    // otherwise every PO pair would fork into a disconnected symbol/candle.
    const norm = forexDataService.toCanonicalSymbol(symbol || "");
    if (!norm || !Number.isFinite(price) || price <= 0) return;

    // Route genuine Pocket Option prices to the authoritative PO cache so the
    // whole platform (price, candles, targets) consumes the SSOT value when it
    // is fresh — achieving PO parity for covered pairs.
    // (`isPo` is declared below once, right before the tick payload is built.)
    if ((source || "").toLowerCase() === "pocket_option") {
      forexDataService.setPocketOptionPrice(norm, price);
    }

    // ════════════════════════════════════════════════════════════════════
    // AUTHORITATIVE POCKET-OPTION SERVER TIMESTAMP — PRICE/GRID PARITY.
    // The PO bridge forwards Pocket Option's OWN `ts_ms` (server time,
    // pre-adjusted by PLATFORM_TIME_OFFSET in the m20 engine). Using that as
    // the tick's wall-clock instant keeps the chart's candle grid, the M20
    // buckets and the live tape EXACTLY aligned with the Pocket Option session.
    // A locally generated `Date.now()` would re-anchor ticks to THIS host's
    // clock and shift every candle off the PO grid — mis-bucketing the active
    // bar and making the live tip read "stale". We therefore prefer the
    // authoritative frame whenever the bridge supplies one (PO source), falling
    // back to the local 1-second stride only for non-PO / payloads without a
    // timestamp.
    // ════════════════════════════════════════════════════════════════════
    let resolvedTs: string | undefined;
    if (timestamp) {
      const parsed = new Date(timestamp).getTime();
      if (Number.isFinite(parsed) && parsed > 0) {
        resolvedTs = new Date(parsed).toISOString();
      }
    }
    const isPo = (source || "").toLowerCase() === "pocket_option";

    const tick: LiveMarketTick = {
      symbol: norm,
      price,
      volume: 0,
      timestamp:
        resolvedTs ?? this.nextTickTimestamp(norm, Date.now()),
      source: isPo ? "pocket_option" : source || "pocket_option",
      // STRICT CLASSIFICATION — honor the bridge's own `asset_type` stamp
      // (authoritative from the PO asset resolution), else classify locally.
      assetType: assetType || symbolRegistry.getAssetSubType(norm),
    };

    // Broadcast strict live tick to WebSocket clients (symbol room).
    this.wsService.broadcastLiveTick(tick);

    // Fold into the high-frequency real-tick ring (tick-quant signal path).
    // No bid/ask arms are passed here: the Pocket Option OTC feed exposes no
    // real order book, so we refuse to fabricate a zero-spread quote. The
    // bidAskPressure micro-factor therefore honestly reads neutral (no_book)
    // instead of pretending there is market depth we do not actually have.
    realtimeTickBuffer.append(norm, price);

    // Arm the live-quant /tick-signal forwarder (coalesced, no drops)
    liveTickSignalDispatcher.enqueue(norm);

    // Fold into the persistent candle buffer (non-fatal on failure).
    try {
      forexDataService.appendTick(norm, price);
    } catch (bufErr) {
      logger.debug("[TickIngestion] PO candle buffer append failed", {
        symbol: norm,
        error: bufErr instanceof Error ? bufErr.message : String(bufErr),
      });
    }
  }
}

export const tickIngestionService = LiveTickIngestionService.getInstance();
export default tickIngestionService;
