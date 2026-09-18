"use client";

import { useEffect, useRef, useCallback } from "react";
import { useSocket } from "./useSocket";
import apiClient from "@/services/api";
import {
  useMarketTerminalStore,
  ALL_MARKET_SYMBOLS,
  HORIZON_MINUTES,
  type HorizonMinutes,
} from "@/store/useMarketTerminalStore";

// ── DEBOUNCE ──
// A fast horizon click (1m → 2m → 3m) must never fire three 34-symbol batch
// refreshes. All refreshes collapse onto ONE trailing request ~700ms after the
// last change. Stale results are dropped via a monotonic sequence number so a
// slow /multi-predict can never overwrite a newer refresh's verdicts.
const REFRESH_DEBOUNCE_MS = 700;

/**
 * useMarketTerminal — WebSocket orchestrator for the all-pairs market grid.
 *
 * JOIN:     emits `subscribe_all` on every (re)connect → backend joins the
 *           `market-terminal` room and streams this ONE feed:
 *             • `market_quotes`      — 1Hz all-symbol quote snapshots
 *             • `live_quant_signal`  — 1Hz AI micro-quant verdicts (all pairs)
 *           No per-symbol rooms are joined (no 34× replay bursts).
 * BOOTSTRAP: one REST GET /api/v1/quotes paints prices before the first beat.
 * REFRESH:  `setGlobalHorizon` / `setCardHorizon` fire a debounced
 *           /multi-predict batch at that horizon (hybrid heavier channel).
 */
export function useMarketTerminal() {
  const { socket, connected } = useSocket();
  const bootstrapDoneRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live "latest horizon" so the trailing debounce always uses the newest value.
  const latestHorizonRef = useRef<HorizonMinutes>(
    useMarketTerminalStore.getState().globalHorizon,
  );
  const latestSymbolsRef = useRef<string[]>(ALL_MARKET_SYMBOLS);

  // ── REST BOOTSTRAP (first paint before the 1Hz WS beat) ──
  useEffect(() => {
    if (bootstrapDoneRef.current) return;
    bootstrapDoneRef.current = true;
    apiClient
      .getQuotes()
      .then((resp) => {
        useMarketTerminalStore.getState().setQuotes(resp?.quotes ?? []);
      })
      .catch(() => {
        /* the 1Hz `market_quotes` stream covers bootstrap */
      });
  }, []);

  // ── WS LISTENERS ──
  useEffect(() => {
    if (!socket) return;
    const store = () => useMarketTerminalStore.getState();

    const onMarketQuotes = (payload: any) => {
      if (!payload || !Array.isArray(payload.quotes)) return;
      store().setQuotes(payload.quotes);
    };

    const onLiveQuantSignal = (payload: any) => {
      if (!payload?.symbol) return;
      const direction =
        payload.signalType === "BUY" || payload.signalType === "SELL"
          ? payload.signalType
          : payload.signal === "BUY" || payload.signal === "SELL"
            ? payload.signal
            : null;
      store().ingestVerdict({
        symbol: payload.symbol,
        direction,
        confidence: Number(payload.confidence) || 0,
        current_price:
          Number.isFinite(payload.current_price) ? payload.current_price : undefined,
        target_price:
          Number.isFinite(payload.target_price) ? payload.target_price : undefined,
        market_waiting: payload.market_waiting === true,
        waiting_reason: payload.waiting_reason ?? null,
        waiting_detail: payload.waiting_detail ?? null,
        book_confluence:
          payload.book_confluence != null ? payload.book_confluence : null,
        timestamp: payload.timestamp ?? new Date().toISOString(),
      });
    };

    const onFeedStatus = (payload: any) => {
      if (!payload?.status) return;
      store().setFeedStatus(String(payload.status).toLowerCase());
    };

    const onConnect = () => {
      store().setConnected(true);
      socket.emit("subscribe_all");
    };

    const onDisconnect = () => {
      store().setConnected(false);
    };

    socket.on("market_quotes", onMarketQuotes);
    socket.on("live_quant_signal", onLiveQuantSignal);
    socket.on("feed_status", onFeedStatus);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    if (socket.connected) {
      onConnect();
    }

    return () => {
      socket.emit("unsubscribe_all");
      socket.off("market_quotes", onMarketQuotes);
      socket.off("live_quant_signal", onLiveQuantSignal);
      socket.off("feed_status", onFeedStatus);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [socket]);

  // ── HORIZON REFRESH (debounced /multi-predict fan-out) ──
  const scheduleRefresh = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    const seq = ++refreshSeqRef.current;
    debounceTimerRef.current = setTimeout(() => {
      const symbols = latestSymbolsRef.current;
      const horizon = latestHorizonRef.current;
      if (symbols.length === 0) return;
      // Mark the batch symbols as "pending" so cards show a refreshing state.
      const s = useMarketTerminalStore.getState();
      for (const sym of symbols) {
        s.setPrediction(sym, {
          status: "pending",
          direction: null,
          confidence: null,
          market_waiting: false,
          waiting_reason: null,
          waiting_detail: null,
          data: null,
        });
      }
      apiClient
        .multiPredict(symbols, `${horizon}m`)
        .then((resp) => {
          if (refreshSeqRef.current !== seq) return; // stale — a newer refresh won
          if (resp?.results) {
            useMarketTerminalStore.getState().setPredictionsFromBatch(resp.results);
          }
        })
        .catch(() => {
          if (refreshSeqRef.current !== seq) return;
          const mark = useMarketTerminalStore.getState();
          for (const sym of symbols) {
            const existing = mark.predictions[sym];
            if (existing?.status !== "pending") continue;
            mark.setPrediction(sym, {
              status: "error",
              direction: null,
              confidence: null,
              market_waiting: true,
              waiting_reason: "unavailable",
              waiting_detail: null,
              data: null,
            });
          }
        });
    }, REFRESH_DEBOUNCE_MS);
  }, []);

  const setGlobalHorizon = useCallback(
    (horizon: HorizonMinutes) => {
      latestHorizonRef.current = horizon;
      latestSymbolsRef.current = ALL_MARKET_SYMBOLS;
      useMarketTerminalStore.getState().setGlobalHorizon(horizon);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const setCardHorizon = useCallback(
    (symbol: string, horizon: HorizonMinutes) => {
      latestHorizonRef.current = horizon;
      latestSymbolsRef.current = [symbol.trim().toUpperCase()];
      useMarketTerminalStore.getState().setCardHorizon(symbol.trim().toUpperCase(), horizon);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const refreshNow = useCallback(
    (symbols: string[] = ALL_MARKET_SYMBOLS, horizon?: HorizonMinutes) => {
      latestSymbolsRef.current = symbols.length ? symbols : ALL_MARKET_SYMBOLS;
      if (horizon) latestHorizonRef.current = horizon;
      useMarketTerminalStore.getState().setGlobalHorizon(latestHorizonRef.current);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  // ── CLEANUP on unmount ──
  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    },
    [],
  );

  return {
    connected,
    setGlobalHorizon,
    setCardHorizon,
    refreshNow,
  };
}

export { HORIZON_MINUTES } from "@/store/useMarketTerminalStore";