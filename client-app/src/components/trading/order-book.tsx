"use client";

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useLangContext } from "@/hooks/useLangContext";
import apiClient, { type OrderBookResponse } from "@/services/api";
import { cn } from "@/utils/cn";
import { formatPairPrice } from "@/utils/format";
import { getPairLabel } from "@/constants/symbols";
import { AssetClassBadge } from "@/components/shared/asset-class-badge";

interface ParsedSymbol {
  base: string;
  quote: string;
}

interface OrderBookProps {
  symbol?: string;
  currentPrice?: number;
}

const parseSymbol = (symbol?: string): ParsedSymbol => {
  const raw = (symbol ?? "AUD/USD").trim().toUpperCase();
  if (raw.includes("/")) {
    const parts = raw.split("/");
    return { base: parts[0] ?? "AUD", quote: parts[1] ?? "USD" };
  }
  return { base: raw, quote: "USD" };
};

const formatPairPriceLocal = (value: number, symbol?: string): string => {
  if (symbol) {
    return formatPairPrice(value, symbol);
  }
  return value.toFixed(5);
};

const formatQty = (value: number): string => {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
};

const formatTotal = (value: number): string => {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    notation: "compact",
    compactDisplay: "short",
  });
};

export const OrderBook: React.FC<OrderBookProps> = ({
  symbol,
}) => {
  const { t, rtl } = useLangContext();

  const [orderBookData, setOrderBookData] = useState<OrderBookResponse | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrderBook = useCallback(async (sym: string) => {
    if (!sym) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getOrderBook(sym);
      setOrderBookData(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch order book",
      );
      setOrderBookData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (symbol) {
      // One-shot fetch per symbol change only — no polling loop.
      // The order book is a point-in-time snapshot; /orderbook is not streamed,
      // so fetching it in a tight setInterval would hammer the API and risk 429s.
      fetchOrderBook(symbol);
    }
  }, [symbol, fetchOrderBook]);

  const parsed = useMemo<ParsedSymbol>(() => parseSymbol(symbol), [symbol]);
  const { base, quote } = parsed;
  const pairLabel = getPairLabel(symbol);

  const isRightAligned = rtl;

  const asks = orderBookData?.asks ?? [];
  const bids = orderBookData?.bids ?? [];
  const spread = orderBookData?.spread ?? 0;
  const spreadPercent = orderBookData?.spreadPercent ?? 0;
  const midPrice = orderBookData?.midPrice ?? 0;
  const lastPrice = orderBookData?.lastPrice ?? midPrice;
  const isLevel1 = orderBookData?.level1 ?? false;
  // ZERO-MOCK DEPTH GATE (lock-down): the Pocket Option bridge serves a real
  // QUOTE tape with NO exchange depth. hasDepth=true only when the backend
  // delivers genuine size at level — otherwise bids/asks are empty and the UI
  // renders the honest L1 quote panel (never a fabricated ladder).
  const hasDepth =
    orderBookData?.hasDepth === true || bids.length + asks.length > 0;
  const depthLabel =
    orderBookData?.depthLabel ?? "L1 quote — no exchange depth (Pocket Option tape)";

  if (isLoading && !orderBookData) {
    return (
      <div className="bg-obsidian border border-slate-800 rounded-xl overflow-hidden min-w-0 shadow-sm">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-3 h-3 rounded-full bg-slate-700 animate-pulse" />
            <div className="h-3 w-24 bg-slate-800 rounded animate-pulse" />
          </div>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-6 bg-slate-800/50 rounded mb-1 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error && !orderBookData) {
    return (
      <div className="bg-obsidian border border-slate-800 rounded-xl overflow-hidden min-w-0 shadow-sm">
        <div className="p-4">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-2">
            {t("orderBook")}
          </h3>
          <p className="text-[10px] text-rose-400 font-mono">{error}</p>
          <button
            onClick={() => symbol && fetchOrderBook(symbol)}
            className="mt-2 text-[10px] text-blue-400 hover:underline font-mono"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const maxAskTotal =
    asks.length > 0 ? Math.max(...asks.map((a) => a.total)) : 1;
  const maxBidTotal =
    bids.length > 0 ? Math.max(...bids.map((b) => b.total)) : 1;

  // ── HONEST L1 QUOTE PANEL (real depth unavailable on the PO tape) ──
  // Rendered when the backend confirms there is NO exchange depth. Shows the
  // genuine live mid / ATR-derived spread / last print + an explicit note.
  // No invented quantity or total is ever shown.
  if (orderBookData && !hasDepth) {
    return (
      <div
        className="bg-obsidian border border-slate-800 rounded-xl overflow-hidden min-w-0 shadow-sm transition-colors duration-200"
        dir={rtl ? "rtl" : "ltr"}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              {t("orderBook")}
            </h3>
            <p className="text-[10px] text-slate-500 mt-0.5 font-mono tracking-tight">
              {pairLabel}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <AssetClassBadge symbol={pairLabel} />
            <span className="text-[9px] text-slate-500 font-mono">
              {pairLabel}
            </span>
          </div>
        </div>

        {/* LIVE L1 QUOTE — REAL TAPE, NO DEPTH */}
        <div className="px-4 py-4 space-y-2">
          <div className="flex items-center justify-between rounded-lg px-3 py-3 bg-obsidian-950/60 border border-slate-700/50">
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-slate-400 font-mono uppercase tracking-wider">
                {t("liveQuote")}
              </span>
              <span className="text-lg font-bold text-white font-mono tabular-nums">
                {midPrice > 0 ? formatPairPriceLocal(midPrice, symbol) : "—"}
              </span>
              {lastPrice > 0 && midPrice !== lastPrice && (
                <span className="text-[9px] text-slate-500 font-mono">
                  last {formatPairPriceLocal(lastPrice, symbol)}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[10px] text-slate-400 font-mono">
                {t("spread")}:{" "}
                {spread > 0 ? formatPairPriceLocal(spread, symbol) : "—"}
                {spreadPercent > 0 ? ` (${spreadPercent.toFixed(3)}%)` : ""}
              </span>
              <span className="inline-flex items-center gap-1 text-[9px] text-amber-400 font-mono uppercase tracking-wider font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                L1
              </span>
            </div>
          </div>
          <p className="text-[10px] text-slate-400 font-mono leading-relaxed">
            {depthLabel}
          </p>
        </div>

        <div className="mt-2 px-4 py-3 border-t border-slate-800 flex justify-between items-center bg-obsidian-950/80">
          <span className="text-[9px] text-slate-500 font-mono">
            {orderBookData?.source ?? "forex_otc"}
          </span>
          <span className="text-[9px] text-slate-400 font-mono">
            L1 quote · live tape
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-obsidian border border-slate-800 rounded-xl overflow-hidden min-w-0 shadow-sm transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">
            {t("orderBook")}
          </h3>
          <p className="text-[10px] text-slate-500 mt-0.5 font-mono tracking-tight">
            {pairLabel}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <AssetClassBadge symbol={pairLabel} />
          <span className="text-[9px] text-slate-500 font-mono">
            {pairLabel}
          </span>
        </div>
      </div>

      {/* Column Headers */}
      <div className="grid grid-cols-3 gap-0 px-4 pb-1 text-[10px] font-mono text-slate-500 border-b border-slate-800/60">
        <div
          className={`${isRightAligned ? "text-right" : "text-left"} font-bold`}
        >
          {`${t("price")} (${quote})`}
        </div>
        <div
          className={`${isRightAligned ? "text-right" : "text-left"} font-bold`}
        >
          {`${t("quantity")}`}
        </div>
        <div
          className={`${isRightAligned ? "text-right" : "text-left"} font-bold`}
        >
          Total
        </div>
      </div>

      {/* Asks (Sells) */}
      <div className="px-4 py-1 space-y-[1px]">
        {asks.length > 0 ? (
          asks.map((level, i) => (
            <div
              key={`ask-${i}`}
              className="grid grid-cols-3 gap-0 text-[11px] font-mono group cursor-pointer hover:bg-rose-500/10 px-1 py-[2px] rounded transition-colors relative"
            >
              <div
                className="absolute inset-y-0 right-0 bg-rose-500/10 rounded transition-all"
                style={{
                  width: `${(level.total / maxAskTotal) * 100}%`,
                  opacity: 0.3,
                }}
              />
              <span className="text-rose-400 relative z-10 font-bold">
                {formatPairPriceLocal(level.price, symbol)}
              </span>
              <span className="text-slate-300 relative z-10">
                {formatQty(level.quantity)}
              </span>
              <span className="text-slate-500 relative z-10 text-right">
                {formatTotal(level.total)}
              </span>
            </div>
          ))
        ) : (
          <div className="text-[10px] text-slate-400 font-mono text-center py-2">
            No sell orders available
          </div>
        )}
      </div>

      {/* Spread / Current Price Bar */}
      <div className="mx-4 my-2 py-2 px-3 bg-slate-50 dark:bg-slate-800/40 border-y border-slate-200 dark:border-slate-700/50 flex items-center justify-between rounded-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white font-mono">
            {midPrice > 0 ? formatPairPriceLocal(midPrice, symbol) : "—"}
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {pairLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-mono">
            {t("spread")}:{" "}
            {spread > 0 ? formatPairPriceLocal(spread, symbol) : "—"}
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            ({spreadPercent > 0 ? spreadPercent.toFixed(3) : "—"}%)
          </span>
        </div>
      </div>

      {/* Bids (Buys) */}
      <div className="px-4 py-1 space-y-[1px]">
        {bids.length > 0 ? (
          bids.map((level, i) => (
            <div
              key={`bid-${i}`}
              className="grid grid-cols-3 gap-0 text-[11px] font-mono group cursor-pointer hover:bg-emerald-500/10 px-1 py-[2px] rounded transition-colors relative"
            >
              <div
                className="absolute inset-y-0 left-0 bg-emerald-500/10 rounded transition-all"
                style={{
                  width: `${(level.total / maxBidTotal) * 100}%`,
                  opacity: 0.3,
                }}
              />
              <span className="text-emerald-400 relative z-10 font-bold">
                {formatPairPriceLocal(level.price, symbol)}
              </span>
              <span className="text-slate-300 relative z-10">
                {formatQty(level.quantity)}
              </span>
              <span className="text-slate-500 relative z-10 text-right">
                {formatTotal(level.total)}
              </span>
            </div>
          ))
        ) : (
          <div className="text-[10px] text-slate-400 font-mono text-center py-2">
            No buy orders available
          </div>
        )}
      </div>

      {/* Footer Stats */}
      <div className="mt-2 px-4 py-3 border-t border-slate-800 flex justify-between items-center bg-obsidian-950/80">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-[9px] text-emerald-400 font-mono uppercase tracking-wider font-bold">
              {t("buys")}: {bids.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            <span className="text-[9px] text-rose-400 font-mono uppercase tracking-wider font-bold">
              {t("sells")}: {asks.length}
            </span>
          </div>
        </div>
        <div className="text-[9px] text-slate-500 font-mono">
          {isLevel1
            ? "L1"
            : `${bids.length + asks.length} ${t("levels")}`}
        </div>
      </div>
    </div>
  );
};

export default OrderBook;

