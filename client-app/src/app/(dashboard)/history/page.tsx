"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Clock,
  Search,
  Download,
  Filter,
  Minus,
} from "lucide-react";
import apiClient, {
  type SignalData,
  type TradeResponse,
} from "@/services/api";
import { useLangContext } from "@/hooks/useLangContext";
import { cn } from "@/utils/cn";
import { formatPairPrice, formatLocalTime, formatLocalDateTime } from "@/utils/format";
import { Header } from "@/components/shared/header";

interface ExecutedTrade {
  id: string;
  symbol: string;
  type: "CALL" | "PUT" | "HOLD";
  entryPrice: number;
  expiry: string;
  createdAt: string;
  pnl: number;
  status: "WIN" | "LOSS" | "OPEN";
  payout: number;
  confidence: number;
}

type SortKey = "createdAt" | "pnl" | "symbol" | "entryPrice";
type SortDir = "asc" | "desc";

export default function HistoryPage() {
  const { t, rtl } = useLangContext();
  const [items, setItems] = useState<ExecutedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "CALL" | "PUT" | "HOLD">(
    "ALL",
  );
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // ── STRICT LIVE FETCH — NO SILENT EMPTY FALLBACKS ──
        // Both the settled trades feed and the live signal feed must resolve
        // against the real backend. A failure is surfaced to the user instead
        // of quietly rendering an empty history that looks like "no trades".
        let trades: TradeResponse[] = [];
        let tradesError: string | null = null;
        try {
          const res = await apiClient.getTradeHistory(500);
          trades = Array.isArray(res?.trades) ? res.trades : [];
        } catch (err) {
          tradesError =
            err instanceof Error ? err.message : "Failed to load trade history";
        }

        let signals: SignalData[] = [];
        let signalsError: string | null = null;
        try {
          const sig = await apiClient.getSignals(undefined, 100);
          signals = Array.isArray(sig) ? sig : [];
        } catch (err) {
          signalsError =
            err instanceof Error ? err.message : "Failed to load signal feed";
        }

        if (cancelled) return;

        if (!tradesError && !signalsError) {
          setError(null);
        } else {
          const parts = [tradesError, signalsError].filter(Boolean) as string[];
          setError(`Live data feed unavailable: ${parts.join(" · ")}`);
          return;
        }

        const tradeRows: ExecutedTrade[] = trades.map((tr) => {
          const status: ExecutedTrade["status"] = tr.status;
          const pnl =
            status === "WIN"
              ? tr.investment * (tr.payout / 100)
              : status === "LOSS"
                ? -tr.investment
                : 0;
          return {
            id: tr.id ?? `trade-${tr.created_at}`,
            symbol: tr.symbol,
            type: tr.direction,
            entryPrice: Number(tr.entry_price ?? 0),
            expiry: tr.expires_at ?? "",
            createdAt: tr.created_at ?? new Date().toISOString(),
            pnl,
            status,
            payout: Number(tr.payout ?? 0),
            confidence: 0,
          };
        });

        const signalRows: ExecutedTrade[] = signals
          .filter((s) => s && s.symbol)
          .map((s, idx) => {
            const rawType = s.signalType ?? s.signal_type;
            const type: ExecutedTrade["type"] =
              rawType === "SELL" ? "PUT" : rawType === "BUY" ? "CALL" : "HOLD";
            const entry = Number(s.price ?? 0);
            const payout = Number(s.payout ?? 0) / 100;
            const pnl =
              type === "CALL" && entry > 0 ? entry * payout : type === "PUT" ? -entry : 0;
            const created = s.createdAt ?? s.timestamp ?? new Date().toISOString();
            return {
              id: s.id ?? `sig-${idx}-${created}`,
              symbol: s.symbol,
              type,
              entryPrice: entry,
              expiry: created,
              createdAt: created,
              pnl,
              status: pnl >= 0 ? "WIN" : "LOSS",
              payout: payout * 100,
              confidence: Number(s.confidence ?? 0),
            };
          });

        const merged = [...tradeRows, ...signalRows].filter(
          (r) => r.symbol && (r.createdAt || r.id),
        );
        const seen = new Set<string>();
        const unique: ExecutedTrade[] = [];
        for (const row of merged) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            unique.push(row);
          }
        }

        setItems(unique);
        setError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load history",
          );
          setItems([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = items.filter((it) => {
      if (typeFilter !== "ALL" && it.type !== typeFilter) return false;
      if (q && !it.symbol.toLowerCase().includes(q)) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "createdAt")
        cmp = +new Date(a.createdAt) - +new Date(b.createdAt);
      else if (sortKey === "pnl") cmp = a.pnl - b.pnl;
      else if (sortKey === "entryPrice") cmp = a.entryPrice - b.entryPrice;
      else cmp = a.symbol.localeCompare(b.symbol);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [items, search, typeFilter, sortKey, sortDir]);

  const stats = useMemo(() => {
    const settled = items.filter((i) => i.status !== "OPEN");
    const wins = settled.filter((i) => i.status === "WIN").length;
    const losses = settled.filter((i) => i.status === "LOSS").length;
    const netPnl = items.reduce((acc, i) => acc + i.pnl, 0);
    return {
      total: items.length,
      wins,
      losses,
      winRate: settled.length ? (wins / settled.length) * 100 : 0,
      netPnl,
    };
  }, [items]);

  const exportCsv = () => {
    if (filtered.length === 0) return;
    const header = [
      "Symbol",
      "Type",
      "Entry Price",
      "Expiry",
      "Timestamp",
      "P&L",
      "Status",
      "Payout %",
    ];
    const rows = filtered.map((it) =>
      [
        it.symbol,
        it.type,
        it.entryPrice.toFixed(5),
        it.expiry,
        it.createdAt,
        it.pnl.toFixed(2),
        it.status,
        it.payout,
      ].join(","),
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trading-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const dirIcon = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-obsidian text-slate-200 font-sans transition-colors duration-200"
      dir={rtl ? "rtl" : "ltr"}
    >

      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        <Header />

        <main className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-3 sm:p-4 md:p-6 lg:p-8">
          <div className="max-w-7xl mx-auto w-full space-y-6">
            {/* Header Title + CSV Export */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-slate-900 dark:text-white text-lg sm:text-2xl font-black tracking-wider uppercase">
                  {t("tradingHistory")}
                </h1>
                <p className="text-slate-600 dark:text-slate-400 text-xs sm:text-sm mt-1">
                  {t("tradingHistoryDesc")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={filtered.length === 0}
                  className="inline-flex items-center gap-2 bg-blue-600/10 dark:bg-blue-600/20 border border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-600/20 text-xs font-bold uppercase tracking-wider px-4 py-2.5 rounded-xl transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  <Download size={14} />
                  {t("exportCsv")}
                </button>
              </div>
            </div>

            {/* Summary Stat Tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                  {t("trades")}
                </p>
                <p className="text-2xl font-black text-slate-900 dark:text-white font-mono mt-1 tabular-nums">
                  {stats.total}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                  {t("winRate")}
                </p>
                <p className="text-2xl font-black text-emerald-500 dark:text-emerald-400 font-mono mt-1 tabular-nums">
                  {stats.winRate.toFixed(1)}%
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                  {t("netPnl")}
                </p>
                <p
                  className={cn(
                    "text-2xl font-black font-mono mt-1 tabular-nums",
                    stats.netPnl >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400",
                  )}
                >
                  {stats.netPnl >= 0 ? "+" : ""}
                  {stats.netPnl.toFixed(2)}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 shadow-sm">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                  {t("winsLosses")}
                </p>
                <p className="text-2xl font-black font-mono mt-1 tabular-nums">
                  <span className="text-emerald-500 dark:text-emerald-400">{stats.wins}</span>
                  <span className="text-slate-400 dark:text-slate-600"> / </span>
                  <span className="text-rose-500 dark:text-rose-400">{stats.losses}</span>
                </p>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                <p className="text-xs text-rose-600 dark:text-rose-400 font-mono">{error}</p>
              </div>
            )}

            {/* Filter Toolbar */}
            {!loading && items.length > 0 && (
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="relative flex-1">
                  <Search
                    size={15}
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
                  />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("filterBySymbol")}
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-blue-500 font-mono shadow-sm"
                  />
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Filter size={14} className="text-slate-400 mr-1" />
                  {(["ALL", "CALL", "PUT", "HOLD"] as const).map((ft) => {
                    const label =
                      ft === "ALL"
                        ? t("filterAll")
                        : ft === "CALL"
                          ? t("filterCall")
                          : ft === "PUT"
                            ? t("filterPut")
                            : t("filterHold");
                    return (
                      <button
                        key={ft}
                        type="button"
                        onClick={() => setTypeFilter(ft)}
                        className={cn(
                          "px-3.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider border transition-all active:scale-[0.98]",
                          typeFilter === ft
                            ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                            : "bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Trading Table Card */}
            <div className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 rounded-xl overflow-hidden shadow-sm">
              {/* Desktop Table Header */}
              <div className="hidden lg:grid lg:grid-cols-12 gap-2 px-6 py-4 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => toggleSort("symbol")}
                  className="col-span-2 text-left hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  {t("asset")}{dirIcon("symbol")}
                </button>
                <div className="col-span-1">{t("type")}</div>
                <button
                  type="button"
                  onClick={() => toggleSort("entryPrice")}
                  className="col-span-2 text-right hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  {t("entryPriceCol")}{dirIcon("entryPrice")}
                </button>
                <div className="col-span-2">{t("expiryCol")}</div>
                <button
                  type="button"
                  onClick={() => toggleSort("createdAt")}
                  className="col-span-2 text-left hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  {t("timestampCol")}{dirIcon("createdAt")}
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort("pnl")}
                  className="col-span-1 text-right hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  {t("pnlCol")}{dirIcon("pnl")}
                </button>
                <div className="col-span-2 text-right">{t("statusCol")}</div>
              </div>

              {loading ? (
                <div className="px-6 py-12 space-y-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="bg-slate-100 dark:bg-slate-800/40 rounded-xl p-5 animate-pulse"
                    >
                      <div className="h-4 w-1/4 bg-slate-300 dark:bg-slate-700 rounded" />
                      <div className="h-3 w-1/2 bg-slate-200 dark:bg-slate-700/60 rounded mt-3" />
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                    <Clock size={22} className="text-slate-400 dark:text-slate-500" />
                  </div>
                  <p className="text-slate-700 dark:text-slate-300 text-base font-bold">
                    {t("noHistoryYet")}
                  </p>
                  <p className="text-slate-500 text-xs mt-1">
                    {t("historyEmptyHint")}
                  </p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <p className="text-slate-500 dark:text-slate-400 text-sm font-bold">
                    {t("noTradesMatch")}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {filtered.map((it) => {
                    const isCall = it.type === "CALL";
                    const isPut = it.type === "PUT";
                    const isOpen = it.status === "OPEN";
                    const badgeClass = isCall
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : isPut
                        ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                        : "bg-slate-500/15 text-slate-600 dark:text-slate-400";
                    const badgeLabel = isCall
                      ? t("filterCall")
                      : isPut
                        ? t("filterPut")
                        : t("filterHold");
                    const statusLabel = isOpen
                      ? t("openStatus")
                      : it.status === "WIN"
                        ? t("winStatus")
                        : t("lossStatus");
                    const statusClass = isOpen
                      ? "bg-blue-500/15 text-blue-600 dark:text-blue-300"
                      : it.status === "WIN"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                        : "bg-rose-500/15 text-rose-600 dark:text-rose-300";
                    return (
                      <div key={it.id}>
                        {/* Mobile Card */}
                        <div className="lg:hidden px-4 py-3.5 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-slate-900 dark:text-white font-mono text-sm font-bold flex items-center gap-2">
                              {isCall ? (
                                <TrendingUp
                                  size={14}
                                  className="text-emerald-500 shrink-0"
                                />
                              ) : isPut ? (
                                <TrendingDown
                                  size={14}
                                  className="text-rose-500 shrink-0"
                                />
                              ) : (
                                <Minus
                                  size={14}
                                  className="text-slate-400 shrink-0"
                                />
                              )}
                              {it.symbol}
                            </span>
                            <span
                              className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${badgeClass}`}
                            >
                              {badgeLabel}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                            <span>
                              {t("entry")}:{" "}
                              <span className="text-slate-800 dark:text-slate-200 font-mono font-bold">
                                {formatPairPrice(it.entryPrice, it.symbol)}
                              </span>
                            </span>
                            <span className="text-right font-mono">
                              {formatLocalTime(it.createdAt)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <span
                              className={cn(
                                "text-sm font-bold font-mono",
                                it.pnl >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400",
                              )}
                            >
                              {it.pnl >= 0 ? "+" : ""}
                              {it.pnl.toFixed(2)}
                            </span>
                            <span
                              className={cn(
                                "inline-block px-2.5 py-0.5 rounded-full text-[11px] font-black uppercase tracking-wider",
                                statusClass,
                              )}
                            >
                              {statusLabel}
                            </span>
                          </div>
                        </div>

                        {/* Desktop Row */}
                        <div className="hidden lg:grid lg:grid-cols-12 gap-2 px-6 py-4 items-center hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                          <div className="col-span-2 text-slate-900 dark:text-white font-mono text-sm font-bold flex items-center gap-2">
                            {isCall ? (
                              <TrendingUp
                                size={14}
                                className="text-emerald-500 shrink-0"
                              />
                            ) : isPut ? (
                              <TrendingDown
                                size={14}
                                className="text-rose-500 shrink-0"
                              />
                            ) : (
                              <Minus
                                size={14}
                                className="text-slate-400 shrink-0"
                              />
                            )}
                            {it.symbol}
                          </div>
                          <div className="col-span-1">
                            <span
                              className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${badgeClass}`}
                            >
                              {badgeLabel}
                            </span>
                          </div>
                          <div className="col-span-2 text-right text-blue-600 dark:text-blue-400 text-sm font-bold font-mono">
                            {formatPairPrice(it.entryPrice, it.symbol)}
                          </div>
                          <div className="col-span-2 text-slate-500 text-sm font-mono">
                            {it.expiry ? formatLocalTime(it.expiry) : "—"}
                          </div>
                          <div className="col-span-2 text-slate-500 text-sm font-mono">
                            {formatLocalDateTime(it.createdAt)}
                          </div>
                          <div className="col-span-1 text-right text-sm font-mono font-bold">
                            <span
                              className={
                                it.pnl >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"
                              }
                            >
                              {it.pnl >= 0 ? "+" : ""}
                              {it.pnl.toFixed(2)}
                            </span>
                          </div>
                          <div className="col-span-2 text-right">
                            <span
                              className={cn(
                                "inline-block px-2.5 py-0.5 rounded-full text-[11px] font-black uppercase tracking-wider",
                                statusClass,
                              )}
                            >
                              {statusLabel}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}


