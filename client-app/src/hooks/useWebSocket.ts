import { useEffect, useState, useRef, useCallback } from "react";
import {
  useTradingStore,
  getAggregatorParityDebug,
  resolveHorizonMinutes,
} from "@/store/useTradingStore";
import { useSocket } from "./useSocket";
import { normalizeSymbol } from "@/services/api";
import { normalizeTimeframe } from "@/lib/realtimeCandleAggregator";
import { tickLatencyProbe } from "@/lib/tickLatencyProbe";

// ── CANONICAL SUBSCRIPTION SYMBOL ──
// Every subscribe payload pushed to the backend MUST use the canonical
// "/"-form symbol ("EUR/USD") — the exact room key the backend joins clients
// to and the PO bridge streams under. UI labels ("EUR/USD OTC") and compact /
// separator variants ("EURUSD", "EUR-USD") are normalised here so the bridge
// handshake can never race a mismatched room (which would leave the
// "WAITING FOR REAL-TIME TICK" lock set forever).
const canonicalSymbol = (raw: string): string =>
  normalizeSymbol(raw) ?? (raw || "").trim().toUpperCase();

// ── SUBSCRIBE PAYLOAD SHAPER ──
// The backend keys candle aggregation against BOTH the canonical symbol AND
// the ACTIVE CHART TIMEFRAME. Every subscribe emit carries { symbol, timeframe }
// so the server joins the `${symbol}:${timeframe}` candle room and seeds
// `history_candles` for exactly the selected resolution. The trade expiry is
// deliberately NOT part of the payload — chart timeframe and trade expiry are
// fully decoupled (Alpha.5 Pro), so changing expiration never re-buckets the
// chart and changing timeframe never moves the trade duration. The TARGET-EXPIRY
// HORIZON (mirrored through the store's selectedHorizonMinutes) IS carried so
// the /predict tick path evaluates on the same convergence window the UI
// shows, keeping the authoritative and stabilized contracts phase-aligned.
const subscribePayload = (): {
  symbol: string;
  timeframe: string;
  horizon_minutes: number;
} | null => {
  const store = useTradingStore.getState();
  const symbol = canonicalSymbol(store.activeSymbol);
  if (!symbol) return null;
  const timeframe = normalizeTimeframe(store.selectedTimeframe) ?? "M1";
  return { symbol, timeframe, horizon_minutes: 5 };
};

// ── STALL / STALE THRESHOLDS (module scope — stable, never recreated per
//    render so they cannot churn effect dependency identities or trip the
//    React internal "Should have a queue" Fast Refresh invariant). ──
// `STALL_MS` is the coarser "no ticks at all" threshold; `STALE_PRICE_MS`
// implements the 2-second price-age rule.
const STALL_MS = 6_000;
const STALE_PRICE_MS = 2_000;
// ── STREAM RECOVERY WATCHDOGS ──
// Once the stream stalls, soft recovery runs on first detection (re-join the
// active room, sync the aggregator wall-clock, background re-poll) and is
// re-run at most every `RECOVERY_COOLDOWN_MS` (2s — a stalled tape gets a
// recovery nudge every 2 seconds). If the tape stays silent far beyond
// STALL_MS, a HARD RECONNECT forces a fresh transport handshake — the socket
// may be "connected" while the backend room/feed is wedged, and no amount of
// Soft recovery will unblock a dead pipe.
//
// HARD_RECONNECT_MS = 15s — deliberately conservative. Raising the old 6s
// teardown removed the ~6s reconnect churn that (a) re-opened the chart gap
// on every slow-but-live tape and (b) collided with the backend's own
// ~12-15s ping/liveness cadence (the exact "disconnect every ~15s" the
// production stream complained about). Soft recovery still nudges every 2s,
// and the backend now REPLAYS its real 2000-tick ring on every re-join, so
// even a genuine 15s wedge rebuilds the chart with zero visible gap.
const RECOVERY_COOLDOWN_MS = 2_000;
const HARD_RECONNECT_MS = 15_000;
const HARD_RECONNECT_COOLDOWN_MS = 12_000;
// ── FEED STATUS HEARTBEAT-AGE RULE ──
// The backend broadcasts the authoritative `feed_status` every ~5s (bridge
// heartbeat). If none arrives for FEED_STATUS_STALE_MS while the transport is
// connected, the feed is effectively dead — flip the single store source to
// "disconnected" (the honest state, never fabricated live).
const FEED_STATUS_STALE_MS = 15_000;

/**
 * WebSocket orchestrator for real-time price updates and signal feed.
 *
 * ── Architecture (Single Source of Truth) ──
 * This is the ONLY place that initiates data synchronization with the backend.
 * 1. Initial fetch: ONE getPrediction() + fetchRecentSignals() per symbol change.
 * 2. WebSocket: Listens for 'live_tick' and 'symbol_update' from the backend
 *    Socket.io server and feeds them into the store's candle aggregator.
 *
 * ── Behaviour ──
 * - NO HTTP polling. All /predict and /signals data updates rely strictly on
 *   incoming WebSocket events (live_tick, symbol_update, prediction_update)
 *   rather than setInterval loops. This eliminates API flooding and 429s.
 * - Listens for live price ticks via Socket.io (real-time).
 * - `connected` = true as long as the Socket.io is connected.
 * - Re-joins the active symbol room automatically after every reconnect so
 *   live_tick streaming resumes without user interaction.
 */

export const useWebSocket = (_url?: string) => {
  const {
    socket,
    connected: socketConnected,
    status: socketStatus,
    reconnectAttempt,
    lastError,
  } = useSocket();
  const [connected, setConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Tracks the symbol whose WebSocket room we have joined. */
  const subscribedSymbolRef = useRef<string>("");
  /** Tracks the timeframe of the last subscribed candle resolution. */
  const lastSubscribedTfRef = useRef<string | null>(null);

  // ── LIVE-STREAM STALL DETECTION ──
  // `streamStalled` is true when the Socket.io transport is connected but NO
  // live_tick has arrived for STALL_MS. This lets the UI show a genuine
  // "WAITING FOR LIVE STREAM..." state instead of pretending the feed is live.
  // NOTE: STALL_MS is defined at module scope (stable across renders). Do NOT
  // redeclare it here — doing so creates a new value every render, which is
  // used as a useEffect dependency and corrupts React's hook queue during Fast
  // Refresh ("Should have a queue" crash / hook-order violation).
  const lastTickAtRef = useRef<number>(Date.now());
  const [streamStalled, setStreamStalled] = useState(false);
  const streamStalledRef = useRef(false);
  /** Epoch ms of the last authoritative `feed_status` frame received from the
   *  backend. Drives the client-side heartbeat-age rule (=> "disconnected"). */
  const lastFeedStatusAtRef = useRef<number>(Date.now());

  // ── RECOVERY WATCHDOG REFS ──
  // `stallStartedAtRef` = onset of the CURRENT stall episode (reset to 0 when
  // a tick lands); `lastSoftRecoveryAtRef` throttles the soft-recovery pass;
  // `lastHardReconnectAtRef` throttles forced transport handshakes.
  const stallStartedAtRef = useRef(0);
  const lastSoftRecoveryAtRef = useRef(0);
  const lastHardReconnectAtRef = useRef(0);

  // ── STALE-PRICE WARNING (2-second rule) ──
  // `stalePrice` becomes true when the most recently received PRICE is older
  // than STALE_PRICE_MS (2s). It is driven by the LOCAL RECEIVE clock — the
  // instant a real price packet physically arrives over the WebSocket — NOT
  // by the packet's embedded timestamp. Anchoring on the upstream/PO server
  // timestamp is unreliable: the Pocket Option bridge carries a fixed
  // PLATFORM_TIME_OFFSET (7200s) and cross-host clock skew can shift
  // `Date.now() - tick.timestamp` by hours, which falsely reports a live feed
  // as stale (or a dead feed as fresh). The receive clock is the ONLY anchor
  // that unambiguously means "a genuine tick arrived within the last 2s". If
  // the backend stalls or the transport dies, the receive clock correctly
  // goes stale after 2s with no real packet — the exact no-fabrication rule.
  // `streamStalled` (6s, no ticks at all) remains a separate, coarser signal.
  // NOTE: STALE_PRICE_MS is defined at module scope — same invariant as above.
  const lastPriceTsRef = useRef<number>(Date.now());
  const [stalePrice, setStalePrice] = useState(false);
  const stalePriceRef = useRef(false);

  // ── CANDLE PARITY ASSERTION (raw-tick ↔ bucket-write parity) ──
  // Flags any symbol that keeps receiving raw live ticks while its aggregation
  // buckets are NOT advancing (a tick with no active bucket increment: clock
  // anchor discontinuity, symbol key fork, or a wedge in the builder). Mirrors
  // the server-side watchdog; surfaced as an honest amber banner instead of a
  // silently flat-lining axis.
  const [candleParityBreach, setCandleParityBreach] = useState<{
    symbol: string;
    timeframe: string;
    tickCount: number;
    bucketWrites: number;
    gapCount: number;
    bucketsCreated: number;
    bucketsUpdated: number;
  } | null>(null);
  const parityRef = useRef<{
    tickCount: number;
    bucketWrites: number;
    gapCount: number;
    sym: string;
    tf: string;
  } | null>(null);
  const parityCyclesRef = useRef(0);
  const parityBreachRef = useRef<{
    symbol: string;
    timeframe: string;
    tickCount: number;
    bucketWrites: number;
    gapCount: number;
    bucketsCreated: number;
    bucketsUpdated: number;
  } | null>(null);

  const ingestLiveTick = useTradingStore((state) => state.ingestLiveTick);
  const applyLiveSignal = useTradingStore((state) => state.applyLiveSignal);
  const ingestQuantDispatch = useTradingStore(
    (state) => state.ingestQuantDispatch,
  );
  const replayTicks = useTradingStore((state) => state.replayTicks);
  const applyServerCandle = useTradingStore((state) => state.applyServerCandle);
  const seedServerCandles = useTradingStore((state) => state.seedServerCandles);
  const setFeedStatus = useTradingStore((state) => state.setFeedStatus);
  const selectedTimeframe = useTradingStore((state) => state.selectedTimeframe);

  // ── SUBSCRIBE (canonical symbol + ACTIVE CHART TIMEFRAME) ──
  // Re-emits the { symbol, timeframe } payload on the socket. Serving as the
  // single choke point for every subscribe push, it also keeps the tf ref in
  // sync so the timeframe-change effect below only re-subscribes on ACTUAL
  // resolution switches (clean state swap + history_candles re-seed).
  const emitSubscribe = useCallback(() => {
    if (!socket) return;
    const payload = subscribePayload();
    if (!payload) return;
    const previousSymbol = subscribedSymbolRef.current;
    const previousTimeframe = lastSubscribedTfRef.current;
    if (previousSymbol && previousSymbol !== payload.symbol) {
      socket.emit("unsubscribe_symbol", {
        symbol: previousSymbol,
        timeframe: previousTimeframe,
      });
    }
    socket.emit("subscribe", payload);
    subscribedSymbolRef.current = payload.symbol;
    lastSubscribedTfRef.current = payload.timeframe;
  }, [socket]);
  const markTickReceived = useCallback(() => {
    lastTickAtRef.current = Date.now();
    if (streamStalledRef.current) {
      streamStalledRef.current = false;
      setStreamStalled(false);
    }
  }, []);

  const markPriceReceived = useCallback(() => {
    // Freshness is measured against the local wall-clock at packet arrival.
    // A real price packet just arrived, so the tape is fresh RIGHT NOW.
    lastPriceTsRef.current = Date.now();
    if (stalePriceRef.current) {
      stalePriceRef.current = false;
      setStalePrice(false);
    }
  }, []);

  const markTick = useCallback(
    (tick: any) => {
      markTickReceived();
      if (tick && (tick.price != null || tick.close != null)) {
        markPriceReceived();
      }
    },
    [markTickReceived, markPriceReceived],
  );

  // ── STORE FRESHNESS BRIDGE ──
  // The store stamps `lastPriceUpdate` on EVERY genuine price write it
  // performs on its own: history/replay bursts (`replayTicks`), /predict
  // first-frame priming (`seedAggregatorPrice`), and `applyLiveSignal` price
  // seeds. Each stamp IS a genuine market-data arrival that the local WS-only
  // receive clocks here would otherwise miss — which would leave a freshly
  // seeded pair stuck under the amber "Connecting / Waiting for Real-time
  // Tick" banner until a direct `live_tick` packet lands. Re-arm both receive
  // clocks on every stamped advance so the stale flag clears the instant real
  // data reaches the store (connect + history/replay + seed all covered).
  // Pure re-anchor of Date.now() — never fabricates a price; the 2s/6s clocks
  // still go stale on a genuinely quiet tape.
  const storeLastPriceUpdate = useTradingStore((s) => s.lastPriceUpdate);
  const lastStorePriceUpdateRef = useRef(storeLastPriceUpdate);
  useEffect(() => {
    if (
      !storeLastPriceUpdate ||
      storeLastPriceUpdate === lastStorePriceUpdateRef.current
    ) {
      return;
    }
    lastStorePriceUpdateRef.current = storeLastPriceUpdate;
    lastTickAtRef.current = Date.now();
    lastPriceTsRef.current = Date.now();
    if (streamStalledRef.current) {
      streamStalledRef.current = false;
      setStreamStalled(false);
    }
    if (stalePriceRef.current) {
      stalePriceRef.current = false;
      setStalePrice(false);
    }
  }, [storeLastPriceUpdate]);

  /**
   * SOFT RECOVERY — run the moment the live stream is detected as stalled.
   *
   * The Socket.IO transport can honestly report `connected` while the
   * underlying room/feed pipeline is wedged (lost room membership, silent
   * backend loop, throttled tab). This pass nudges every layer without
   * tearing the transport down:
   *   1. re-joins the active symbol room (live_tick resumes on stale rooms),
   *   2. advances the aggregator's wall-clock so rolled bars paint even if the
   *      module heartbeat was throttled in a backgrounded tab,
   *   3. fires a background /predict re-poll (coalesced + debounced by the
   *      store) so the prediction and price priming refresh on recovery.
   */
  const recoverStalledStream = useCallback(() => {
    if (!socket) return;
    const store = useTradingStore.getState();
    const symbol = store.activeSymbol;
    if (!symbol) return;

    emitSubscribe();

    store.syncAggregatorWallClock();
    store.getPrediction(symbol);
  }, [socket, emitSubscribe]);

  useEffect(() => {
    // Single source of truth: sync the convenience boolean to the context
    // provider's granular status (which also flips on reconnect attempts).
    setConnected(socketStatus === "connected" || socketConnected);
  }, [socketStatus, socketConnected]);

  // Heartbeat: re-evaluate the stall + stale flags every 1s against the last tick.
  useEffect(() => {
    if (!socketConnected) {
      streamStalledRef.current = false;
      setStreamStalled(false);
      stalePriceRef.current = false;
      setStalePrice(false);
      return;
    }
    const interval = window.setInterval(() => {
      const stalled =
        socketConnected && Date.now() - lastTickAtRef.current > STALL_MS;
      if (stalled !== streamStalledRef.current) {
        streamStalledRef.current = stalled;
        setStreamStalled(stalled);
      }
      const stale =
        socketConnected && Date.now() - lastPriceTsRef.current > STALE_PRICE_MS;
      if (stale !== stalePriceRef.current) {
        stalePriceRef.current = stale;
        setStalePrice(stale);
      }

      // ── FEED STATUS HEARTBEAT-AGE RULE (single store source) ──
      // While the transport is connected but no authoritative `feed_status`
      // frame has arrived for FEED_STATUS_STALE_MS, the feed is dead — flip the
      // store's single source to "disconnected" (honest, never fabricated).
      if (
        socketConnected &&
        Date.now() - lastFeedStatusAtRef.current > FEED_STATUS_STALE_MS
      ) {
        const store = useTradingStore.getState();
        if (store.feedStatus !== "disconnected") {
          store.setFeedStatus("disconnected");
        }
      }

      // ── CANDLE PARITY ASSERTION ──
      // While the transport is live, compare the ACTIVE symbol's raw tick count
      // against its bucket write count every second. New ticks with zero bucket
      // writes for ≥3 consecutive sweeps = a flat-lining pair (aggregation is
      // consuming nothing). Advancing writes instantly re-arm the flag; a symbol
      // or resolution switch resets the window so one pair's failure can never
      // be misattributed to the next.
      const parityActive = useTradingStore.getState().activeSymbol;
      const parityTf =
        normalizeTimeframe(useTradingStore.getState().selectedTimeframe) ??
        "M1";
      if (parityActive && socketConnected) {
        const dbg = getAggregatorParityDebug(parityActive);
        const prev = parityRef.current;
        const windowChanged =
          !prev ||
          prev.sym !== dbg.symbol ||
          prev.sym !== parityActive ||
          prev.tf !== dbg.timeframe ||
          prev.tf !== parityTf;
        if (windowChanged) {
          // New symbol / resolution window: release any prior breach, re-arm
          // the comparison purely on the new pair.
          parityCyclesRef.current = 0;
          if (parityBreachRef.current) {
            parityBreachRef.current = null;
            setCandleParityBreach(null);
          }
          parityRef.current = {
            tickCount: dbg.tickCount,
            bucketWrites: dbg.bucketWrites,
            gapCount: dbg.gapCount,
            sym: dbg.symbol,
            tf: dbg.timeframe,
          };
        } else {
          if (dbg.bucketWrites > dbg.tickCount + dbg.gapCount) {
            const breach = {
              symbol: dbg.symbol,
              timeframe: String(dbg.timeframe),
              tickCount: dbg.tickCount,
              bucketWrites: dbg.bucketWrites,
              gapCount: dbg.gapCount,
              bucketsCreated: dbg.bucketsCreated,
              bucketsUpdated: dbg.bucketsUpdated,
            };
            console.warn(
              "[CandleParity] Bucket writes exceed expected writes",
              breach,
            );
            parityBreachRef.current = breach;
            setCandleParityBreach(breach);
          } else {
            parityCyclesRef.current = 0;
            if (parityBreachRef.current) {
              parityBreachRef.current = null;
              setCandleParityBreach(null);
            }
          }
          parityRef.current = {
            tickCount: dbg.tickCount,
            bucketWrites: dbg.bucketWrites,
            gapCount: dbg.gapCount,
            sym: dbg.symbol,
            tf: dbg.timeframe,
          };
        }
      } else {
        parityRef.current = null;
        parityCyclesRef.current = 0;
        if (parityBreachRef.current) {
          parityBreachRef.current = null;
          setCandleParityBreach(null);
        }
      }
    }, 1_000);
    return () => clearInterval(interval);
    // STALL_MS / STALE_PRICE_MS are module-scope constants (stable); they are
    // intentionally omitted from the deps so the heartbeat cannot churn its
    // identity on every render (which previously tripped the Fast Refresh hook
    // queue invariant). Only `socketConnected` genuinely drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketConnected]);

  /**
   * Handle incoming real-time ticks from the WebSocket.
   * This is the authoritative feed for the chart's live candlesticks.
   */
  useEffect(() => {
    if (!socket) return;

    const onLiveTick = (tick: any) => {
      markTick(tick);
      // TEMPORARY LATENCY AUDIT — logs the 100-tick broker→browser delta + leg
      // breakdown + seq-drop count to the console (see tickLatencyProbe.ts).
      tickLatencyProbe.record(tick);
      ingestLiveTick(tick);
    };

    const onSymbolUpdate = (update: any) => {
      markTick(update);
      // symbol_update can carry predictions or ticks — fold ticks into aggregator
      if (update?.price != null || update?.close != null) {
        ingestLiveTick(update);
      }
      // It may also carry a fresh signal — push it onto the active panel so the
      // badge + execution buttons track the latest engine direction live.
      applyLiveSignal(update);
    };

    const onNewSignal = (signal: any) => {
      markTick(signal);
      applyLiveSignal(signal);
    };

    const onLiveQuantSignal = (payload: any) => {
      markTick(payload);
      ingestQuantDispatch(payload);
    };

    // REPLAY-ON-JOIN — the backend ships the real 2000-tick ring as a `history`
    // burst the moment this socket joins a symbol room (subscribe, every
    // reconnect/rejoin). Folding it in here closes the chart gap between "last
    // tick before the disconnect" and "first live tick after", so a rejoin
    // never stalls the visible series waiting for the feed to move again.
    const onHistory = (payload: any) => {
      if (
        !payload ||
        !Array.isArray(payload.ticks) ||
        payload.ticks.length === 0
      ) {
        return;
      }
      markTick(payload);
      const replaySymbol = (payload.symbol || "")
        .toString()
        .trim()
        .toUpperCase();
      const active = useTradingStore.getState().activeSymbol;
      const activeNorm = (active || "").toString().trim().toUpperCase();
      // Only fold the active symbol's replay (the series already on screen) —
      // other rooms' history is discarded to keep the chart authoritative.
      if (!replaySymbol || (activeNorm && replaySymbol !== activeNorm)) return;
      replayTicks(replaySymbol, payload.ticks);
      // The replay burst IS live price-data contact: the real 2000-tick ring is
      // now seeding the chart. Anchor the freshness clocks so a quiet tape
      // right after a rejoin doesn't linger in the stale/stall banner while
      // the replayed series is already painting — the honest 2s/6s rules then
      // only re-engage if NO further real packets arrive.
      lastPriceTsRef.current = Date.now();
      lastTickAtRef.current = Date.now();
    };

    // ── SERVER-AUTHORITATIVE CANDLE ACKNOWLEDGEMENT ──
    // The backend's candle aggregator pushes each CLOSED candle on the `candle`
    // event. Fold it into the store's serverCandles map (only closed payloads
    // are accepted there) so the chart repaints the authoritative closed bar.
    const onCandle = (payload: any) => {
      if (!payload) return;
      const active = useTradingStore.getState().activeSymbol;
      const activeNorm = (active || "").toString().trim().toUpperCase();
      const sym = (payload.symbol || "").toString().trim().toUpperCase();
      if (!sym || (activeNorm && sym !== activeNorm)) return;
      applyServerCandle(payload);
    };

    // ── REPLAY-ON-JOIN (closed candles) ──
    // The backend ships the aggregator's authoritative closed-candle history
    // per timeframe as a `history_candles` burst on every subscribe/rejoin.
    const onHistoryCandles = (payload: any) => {
      if (!payload || !Array.isArray(payload.candles)) {
        return;
      }
      const active = useTradingStore.getState().activeSymbol;
      const activeNorm = (active || "").toString().trim().toUpperCase();
      const sym = (payload.symbol || "").toString().trim().toUpperCase();
      if (!sym || (activeNorm && sym !== activeNorm)) return;
      // Single-resolution burst: { symbol, timeframe, candles } — the backend
      // seeds EXACTLY the chart timeframe requested on subscribe.
      seedServerCandles(
        sym,
        String(payload.timeframe || "1m"),
        payload.candles,
      );
    };

    socket.on("live_tick", onLiveTick);
    socket.on("symbol_update", onSymbolUpdate);
    socket.on("new_signal", onNewSignal);
    socket.on("live_quant_signal", onLiveQuantSignal);
    socket.on("history", onHistory);
    socket.on("candle", onCandle);
    socket.on("history_candles", onHistoryCandles);

    // ── AUTHORITATIVE FEED STATUS (heartbeat-age rule) ──
    // The backend broadcasts `feed_status` on every bridge heartbeat + state
    // change. This is the SINGLE source of truth for the store's `feedStatus`;
    // the 1s sweep below re-applies the local heartbeat-age rule so a socket
    // that stops receiving these frames honestly reports "disconnected".
    const onFeedStatus = (payload: any) => {
      if (!payload) return;
      lastFeedStatusAtRef.current = Date.now();
      const raw = String(payload.status || "").toLowerCase();
      const allowed: ReadonlyArray<string> = [
        "live",
        "stalled",
        "disconnected",
        "awaiting_ssid",
        "auth_failed",
        "degraded",
      ];
      if (!allowed.includes(raw)) return;
      setFeedStatus(
        raw as
          | "live"
          | "stalled"
          | "disconnected"
          | "awaiting_ssid"
          | "auth_failed"
          | "degraded",
      );
    };
    socket.on("feed_status", onFeedStatus);

    // ── FORCE INITIAL TICK HANDSHAKE (every "SYNCHRONISÉ") ──
    // The instant the transport reports a live connection, dispatch the
    // active symbol's subscription payload so the backend (a) joins the room,
    // (b) pushes the symbol to the Pocket Option bridge so its tick reader
    // arms immediately, and (c) replays its real tick ring -> the stream is
    // live and the "WAITING FOR REAL-TIME TICK" lock clears at handshake.
    const onConnected = () => {
      if (!useTradingStore.getState().activeSymbol) return;
      emitSubscribe();
    };
    socket.on("connect", onConnected);

    return () => {
      socket.off("live_tick", onLiveTick);
      socket.off("symbol_update", onSymbolUpdate);
      socket.off("new_signal", onNewSignal);
      socket.off("live_quant_signal", onLiveQuantSignal);
      socket.off("history", onHistory);
      socket.off("candle", onCandle);
      socket.off("history_candles", onHistoryCandles);
      socket.off("feed_status", onFeedStatus);
      socket.off("connect", onConnected);
    };
  }, [
    socket,
    ingestLiveTick,
    applyLiveSignal,
    ingestQuantDispatch,
    markTick,
    replayTicks,
    applyServerCandle,
    seedServerCandles,
    setFeedStatus,
    emitSubscribe,
  ]);

  // ── RECONNECT RESILIENCE ──
  // After every successful (re)connect, re-join the active symbol's room.
  // Without this, a dropped connection permanently silenced live_tick
  // streaming until the user manually switched symbols. Keyed on BOTH the
  // socket object identity AND its live `socket.id` — a silent transport swap
  // that reconnects without flipping the connected boolean (or a server-side
  // state-recovery restore) still re-emits subscribe on the new session, so
  // the room can never be lost with the client believing it is attached.
  useEffect(() => {
    if (!socket || !socketConnected) return;

    // ── FRESH-FEED GRACE ON EVERY (RE)CONNECT ──
    // `stalePrice` and `streamStalled` compare against the LOCAL RECEIVE clock
    // (the instants real packets physically arrived). A freshly negotiated
    // handshake IS contact with the feed pipeline, so BOTH clocks restart from
    // NOW: the 2s price-age rule and the 6s stall rule each get a full grace
    // window on join. Combined with the backend's 2000-tick replay on subscribe
    // (below), a reconnected chart clears the "Live Data Stream Disconnected"
    // banner IMMEDIATELY at handshake instead of lingering until the first
    // post-reconnect live_tick lands on a quiet tape. If the rejoin then
    // delivers no real packets inside the grace window, the honest stale/stall
    // rules re-engage — no fabrication, the banner only ever reflects reality.
    lastPriceTsRef.current = Date.now();
    lastTickAtRef.current = Date.now();
    if (stalePriceRef.current) {
      stalePriceRef.current = false;
      setStalePrice(false);
    }
    if (streamStalledRef.current) {
      streamStalledRef.current = false;
      setStreamStalled(false);
    }

    const norm = canonicalSymbol(useTradingStore.getState().activeSymbol);

    // Re-join the ACTIVE resolution on every (re)connect — carries the
    // current { symbol, timeframe } so the backend replays the real tick ring
    // AND seeds the current chart resolution's closed candles.
    emitSubscribe();

    // ── INSTANT RE-ARM ON RECONNECT ──
    // Every (re)connect re-subscribes above, and the backend replays its real
    // 2000-tick ring on that join (folds into the aggregator via `history` →
    // replayTicks → seedBatch). Syncing the aggregator wall-clock forces those
    // freshly seeded bars to roll onto the leading grid IMMEDIATELY, and a
    // store-coalesced /predict re-poll refreshes the forecast anchor — so a
    // "WAITING FOR REAL-TIME TICK" pane flips live within ONE reconnect instead
    // of idling until the coarse 6s stall-recovery pass notices. getPrediction
    // is coalescing + debounced per (symbol, timeframe) at the store level, so
    // rapid reconnect cycles can never storm the backend.
    const store = useTradingStore.getState();
    store.syncAggregatorWallClock();
    if (norm) void store.getPrediction(norm);
  }, [socket, socketConnected, socket?.id, emitSubscribe]);

  // ── CHART TIMEFRAME SWITCH → CLEAN STATE SWAP + HISTORY SEED ──
  // The instant the user changes the chart timeframe, re-subscribe with the
  // new resolution: the backend joins the `${symbol}:${timeframe}` candle room
  // and replays `history_candles` for THAT grid. The store's serverCandles +
  // serverCandleVersion bump (via seedServerCandles) then triggers the chart's
  // clean state swap — the selected bucket's closed bars are RE-SEEDED from
  // the server's authoritative ring, so no stale bar from the previous
  // resolution survives the switch. Trade expiry is never involved.
  useEffect(() => {
    if (!socket || !socketConnected) return;
    const tf = normalizeTimeframe(selectedTimeframe) ?? "M1";
    if (lastSubscribedTfRef.current === null) {
      // Mount baseline — the connect handshake already emitted it.
      lastSubscribedTfRef.current = tf;
      return;
    }
    if (lastSubscribedTfRef.current !== tf) {
      lastSubscribedTfRef.current = tf;
      emitSubscribe();
    }
  }, [socket, socketConnected, selectedTimeframe, emitSubscribe]);

  // ── HARD FEED RESET (dataEpoch) ──
  // A `hardResetLiveData` call wipes every cache, aggregator symbol state and
  // series buffer, then bumps the epoch. This effect tears the transport down
  // and rebuilds it so the join handshake re-subscribes and the backend replays
  // its REAL tick ring into the now-empty aggregator — every candle that
  // renders after a reset is re-derived from verified broker ticks, with no
  // cached or synthetic residue surviving the handshake.
  const dataEpoch = useTradingStore((s) => s.dataEpoch);
  const lastEpochRef = useRef(dataEpoch);
  useEffect(() => {
    if (!socket || dataEpoch === lastEpochRef.current) return;
    lastEpochRef.current = dataEpoch;
    lastHardReconnectAtRef.current = 0;
    lastSoftRecoveryAtRef.current = 0;
    stallStartedAtRef.current = 0;
    try {
      socket.disconnect();
      socket.connect();
    } catch {
      // A forced handshake must never crash the orchestrator.
    }
    markTickReceived();
    markPriceReceived();
  }, [socket, dataEpoch, markTickReceived, markPriceReceived]);

  // ── STREAM-STALL RECOVERY + HARD RECONNECT WATCHDOG ──
  // Soft recovery (room re-join + aggregator wall-clock sync + background
  // re-poll) fires on stall onset and re-runs at most every RECOVERY_COOLDOWN_MS
  // while the stream stays silent. If the tape is STILL silent past
  // HARD_RECONNECT_MS — even though the transport reports `connected` — the
  // watchdog tears down and rebuilds the socket so a wedged pipe or lost room
  // membership renegotiates from scratch. Every recovery action is idempotent
  // and the moment a real tick lands (markTickReceived) the stall resets.
  useEffect(() => {
    if (!socket || !socketConnected) return;
    if (streamStalled) {
      if (stallStartedAtRef.current === 0) {
        stallStartedAtRef.current = Date.now();
      }
      const now = Date.now();
      if (now - lastSoftRecoveryAtRef.current >= RECOVERY_COOLDOWN_MS) {
        lastSoftRecoveryAtRef.current = now;
        recoverStalledStream();
      }
      if (
        now - stallStartedAtRef.current >= HARD_RECONNECT_MS &&
        now - lastHardReconnectAtRef.current >= HARD_RECONNECT_COOLDOWN_MS
      ) {
        lastHardReconnectAtRef.current = now;
        try {
          socket.disconnect();
          socket.connect();
        } catch {
          // A watchdog handshake must never crash the orchestrator.
        }
      }
    } else {
      stallStartedAtRef.current = 0;
    }
  }, [socket, socketConnected, streamStalled, recoverStalledStream]);

  const joinSymbolRoom = useCallback(
    (symbol: string) => {
      if (!socket || !symbol) return;
      const normalized = canonicalSymbol(symbol);
      if (subscribedSymbolRef.current !== normalized) {
        emitSubscribe();
        subscribedSymbolRef.current = normalized;
      }
    },
    [socket, emitSubscribe],
  );

  const startSync = useCallback(
    (symbol: string) => {
      setIsScanning(true);

      // Join the WebSocket room for this symbol (idempotent per symbol)
      joinSymbolRoom(symbol);

      // ONE-SHOT initial fetch per symbol change — no polling loop.
      // Subsequent /predict and /signals updates come from WebSocket events.
      // `force` — this is a user-initiated subscribe/re-sync: the first
      // evaluation must fire immediately, not sit behind the 5s /predict
      // debounce (coalescing still dedups concurrent duplicate fetches).
      const store = useTradingStore.getState();
      store.getPrediction(symbol, undefined, undefined, true);
      store.fetchRecentSignals();
    },
    [joinSymbolRoom],
  );

  const stopSync = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsScanning(false);
  }, []);

  useEffect(() => {
    return () => {
      stopSync();
    };
  }, [stopSync]);

  const subscribeSymbol = useCallback(
    (symbol: string) => {
      const normalized = symbol.toUpperCase();
      startSync(normalized);
    },
    [startSync],
  );

  const unsubscribeSymbol = useCallback(
    (symbol: string) => {
      if (socket) {
        const normalized = canonicalSymbol(symbol);
        socket.emit("unsubscribe_symbol", {
          symbol: normalized,
          timeframe: lastSubscribedTfRef.current,
        });
        if (subscribedSymbolRef.current === normalized) {
          subscribedSymbolRef.current = "";
        }
      }
      stopSync();
      // BUGFIX: this previously forced `setConnected(false)` unconditionally —
      // after unsubscribing ONE symbol the dashboard permanently showed
      // Engine: IDLE even while the socket itself stayed connected (other
      // symbols/global feed still live). Sync to the ACTUAL transport health.
      setConnected(Boolean(socket?.connected) || socketConnected);
    },
    [stopSync, socket, socketConnected],
  );

  return {
    connected,
    socketStatus,
    reconnectAttempt,
    lastError,
    isScanning,
    socket,
    streamStalled,
    stalePrice,
    candleParityBreach,
    subscribeSymbol,
    unsubscribeSymbol,
  };
};
