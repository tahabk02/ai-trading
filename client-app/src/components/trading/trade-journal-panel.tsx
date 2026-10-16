"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  useTradingStore,
  getLastPriceReceiveAtMs,
} from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { useJournalStore } from "@/store/useJournalStore";
import { isPoOfflineOtc } from "@/lib/quoteProvenance";
import {
  computeJournalStats,
  journalMarkerGeometry,
  journalEnabled,
  JOURNAL_NO_BROKER_NOTICE,
  JOURNAL_MEANINGFUL_MIN_N,
  type JournalEntry,
  type JournalGateSnapshot,
  type JournalSide,
  type JournalStats,
  type JournalTick,
} from "@/lib/tradeJournal";
import { cn } from "@/utils/cn";

/**
 * TradeJournalPanel — PART 50 [535]-[538] Pocket-style start/end journal UI.
 *
 * A LOCAL stopwatch + scoreboard. The two recorder buttons say "I took this on
 * PO"; NOTHING is sent to Pocket Option — no order, no broker call. The panel
 * draws the ENTRY dot, the STRIKE line, the EXPIRY vertical line, a live
 * countdown and the above/below-strike relation, plus the gate-split stats and
 * CSV export. The tracker is a journal, never a signal ([540]).
 */

function fmtClock(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtPct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function countdownText(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }
  return `${s}s`;
}

const STATUS_STYLES: Record<string, string> = {
  OPEN: "text-sky-400 border-sky-500/40 bg-sky-500/10",
  WIN: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  LOSS: "text-red-400 border-red-500/40 bg-red-500/10",
  VOID: "text-zinc-400 border-zinc-500/40 bg-zinc-500/10",
};

function scoreColorClass(side: JournalSide, above: boolean | null): string {
  if (above == null) return "text-zinc-400";
  const winning = side === "CALL" ? above : !above;
  return winning ? "text-emerald-400" : "text-red-400";
}

function StatBucket({
  label,
  stats,
}: {
  label: string;
  stats: JournalStats["byGateState"]["tradable"];
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-white/10 bg-black/30 px-2 py-1.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-zinc-400">
        <span>{label}</span>
        <span>{stats.total}</span>
      </div>
      <div className="text-sm font-semibold text-zinc-100">
        {fmtPct(stats.winRate)}
        <span className="ml-1 text-[10px] font-normal text-zinc-500">
          {stats.resolved > 0
            ? `[${fmtPct(stats.wilson.low)}–${fmtPct(stats.wilson.high)}]`
            : "no resolved"}
        </span>
      </div>
      <div className="text-[10px] text-zinc-500">
        {stats.wins}W / {stats.losses}L / {stats.voids}V / {stats.open}open
      </div>
      {!stats.meaningful && (
        <div className="text-[10px] text-amber-400/80">
          {`n<${JOURNAL_MEANINGFUL_MIN_N}: not meaningful`}
        </div>
      )}
    </div>
  );
}

function JournalMarkers({
  entry,
  nowMs,
  livePrice,
}: {
  entry: JournalEntry;
  nowMs: number;
  livePrice: number | null;
}) {
  const geo = journalMarkerGeometry(entry, [], 0, nowMs, livePrice);
  const span = Math.max(1, geo.expiryTs - geo.entryTs);
  const elapsed = Math.min(span, Math.max(0, nowMs - geo.entryTs));
  const progress = elapsed / span;
  const expired = nowMs >= geo.expiryTs;
  const aboveStrike =
    livePrice != null && Number.isFinite(livePrice)
      ? livePrice > entry.entryPrice
      : null;
  // Vertical placement is schematic: above the strike line = price above.
  const dotY = aboveStrike == null ? 24 : aboveStrike ? 10 : 38;
  return (
    <div className="relative mt-1 h-12 w-full rounded border border-white/10 bg-black/40">
      {/* STRIKE line (horizontal) */}
      <div
        className="absolute left-0 right-0 border-t border-dashed border-zinc-500"
        style={{ top: 24 }}
      />
      <span
        className="absolute right-1 text-[9px] text-zinc-400"
        style={{ top: 24 + 1 }}
      >
        strike {entry.entryPrice}
      </span>
      {/* EXPIRY vertical line */}
      <div
        className={cn(
          "absolute top-0 bottom-0 border-l",
          expired ? "border-red-500/70" : "border-amber-400/70",
        )}
        style={{ left: "100%" }}
      />
      {/* ENTRY dot at the entry instant (left edge) */}
      <div
        className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-400"
        style={{ left: 4, top: 24 }}
        title={`Entry ${fmtClock(entry.entryTs)} @ ${entry.entryPrice}`}
      />
      {/* Live price marker */}
      {aboveStrike != null && (
        <div
          className={cn(
            "absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
            aboveStrike ? "bg-emerald-400" : "bg-red-400",
          )}
          style={{ left: `${Math.min(98, progress * 100)}%`, top: dotY }}
          title={`Live ${livePrice}`}
        />
      )}
      {/* Progress fill */}
      <div
        className="absolute bottom-0 left-0 h-0.5 bg-sky-500/50"
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  );
}

export const TradeJournalPanel: React.FC<{ stalePrice: boolean }> = ({
  stalePrice,
}) => {
  const activeSymbol = useTradingStore((s) => s.activeSymbol);
  const currentPrice = useTradingStore((s) => s.currentPrice);
  const selectedExpirationSeconds = useTradingStore(
    (s) => s.selectedExpirationSeconds,
  );
  const predictionData = useTradingStore((s) => s.predictionData);
  const feedStatus = useTradingStore((s) => s.feedStatus);
  const activeQuote = useMarketTerminalStore((s) => s.quotes[activeSymbol]);

  const entries = useJournalStore((s) => s.entries);
  const record = useJournalStore((s) => s.record);
  const pushTick = useJournalStore((s) => s.pushTick);
  const settleDue = useJournalStore((s) => s.settleDue);
  const hydrate = useJournalStore((s) => s.hydrate);
  const hydrated = useJournalStore((s) => s.hydrated);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 250 ms clock drives the countdown, the enable-state and due settlements.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const poOffline = isPoOfflineOtc(activeSymbol, activeQuote ?? null);
  const feedOffline =
    feedStatus === "awaiting_ssid" || feedStatus === "auth_failed";

  const tick: JournalTick | null = useMemo(() => {
    if (currentPrice <= 0) return null;
    const receiveAt = getLastPriceReceiveAtMs();
    if (!receiveAt) return null;
    return {
      symbol: activeSymbol,
      price: currentPrice,
      tsMs: receiveAt,
      source: activeQuote?.source ?? "",
      stale:
        stalePrice ||
        poOffline ||
        activeQuote?.stale === true ||
        activeQuote?.staleLive === true,
    };
  }, [
    currentPrice,
    activeSymbol,
    activeQuote?.source,
    activeQuote?.stale,
    activeQuote?.staleLive,
    stalePrice,
    poOffline,
  ]);

  // Feed the settlement buffer with every genuine live PO tick.
  useEffect(() => {
    if (tick && !tick.stale) pushTick(tick);
  }, [tick, pushTick]);

  // Settle anything whose expiry has passed, from the buffered ticks ([537]).
  useEffect(() => {
    settleDue(nowMs);
  }, [nowMs, settleDue]);

  const enabled = journalEnabled(tick, nowMs);

  const gate: JournalGateSnapshot = useMemo(
    () => ({
      regimeGate: predictionData?.regime_gate ?? null,
      tier: predictionData?.tier ?? null,
      executable: predictionData?.executable === true,
      suppressedReason: predictionData?.suppressed_reason ?? null,
      bookAgreement:
        predictionData?.book_agreement_detail?.aligned_count != null &&
        predictionData?.book_agreement_detail?.active_count != null
          ? {
              aligned: predictionData.book_agreement_detail.aligned_count,
              active: predictionData.book_agreement_detail.active_count,
            }
          : null,
      signal: predictionData?.signal ?? null,
    }),
    [predictionData],
  );

  const stats = useMemo(() => computeJournalStats(entries), [entries]);
  const openEntries = entries.filter((e) => e.status === "OPEN");
  const newest = entries[0] ?? null;

  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4000);
  };

  const onRecord = (side: JournalSide) => {
    const entry = record({
      tick,
      side,
      durationSec: selectedExpirationSeconds,
      gate,
      nowMs: Date.now(),
    });
    if (!entry) {
      showFlash("No live Pocket Option tick — recorder disabled.");
      return;
    }
    showFlash(
      `${side} journaled @ ${entry.entryPrice} — expires ${fmtClock(entry.expiryTs)}`,
    );
  };

  const onExport = () => {
    const csv = useJournalStore.getState().toCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-zinc-950/60 p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
          Trade Journal
        </h4>
        <span className="text-[10px] text-zinc-500">
          {hydrated ? `${entries.length} entries` : "loading…"}
        </span>
      </div>

      <p className="mt-1 text-[10px] italic text-amber-400/80">
        {JOURNAL_NO_BROKER_NOTICE}
      </p>

      {/* [535] recorder buttons — enabled iff a live PO tick, gate-independent */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!enabled}
          onClick={() => onRecord("CALL")}
          className={cn(
            "rounded-md border px-2 py-2 text-xs font-semibold transition",
            enabled
              ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              : "cursor-not-allowed border-white/10 bg-white/5 text-zinc-600",
          )}
          title={
            enabled
              ? "Journal that I took a CALL on Pocket Option"
              : "Disabled: no live Pocket Option tick"
          }
        >
          I took CALL
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => onRecord("PUT")}
          className={cn(
            "rounded-md border px-2 py-2 text-xs font-semibold transition",
            enabled
              ? "border-red-500/50 bg-red-500/15 text-red-300 hover:bg-red-500/25"
              : "cursor-not-allowed border-white/10 bg-white/5 text-zinc-600",
          )}
          title={
            enabled
              ? "Journal that I took a PUT on Pocket Option"
              : "Disabled: no live Pocket Option tick"
          }
        >
          I took PUT
        </button>
      </div>

      {!enabled && (
        <p className="mt-1 text-[10px] text-zinc-500">
          {feedOffline
            ? "Feed offline — journal recorder disabled."
            : poOffline
              ? "OTC priced by a non-PO proxy — not a live PO tick."
              : "Waiting for a live Pocket Option tick…"}
        </p>
      )}

      {flash && (
        <p className="mt-1 text-[10px] text-sky-300">{flash}</p>
      )}

      {/* [536] newest entry: markers + countdown + above/below strike */}
      {newest && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-zinc-200">
              {newest.side} · {newest.entryPrice}
            </span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10px]",
                STATUS_STYLES[newest.status],
              )}
            >
              {newest.status}
            </span>
          </div>
          <JournalMarkers
            entry={newest}
            nowMs={nowMs}
            livePrice={currentPrice > 0 ? currentPrice : null}
          />
          {newest.status === "OPEN" ? (
            <div className="mt-1 flex items-center justify-between text-[10px]">
              <span className="text-zinc-400">
                {countdownText((newest.expiryTs - nowMs) / 1000)} to expiry (
                {fmtClock(newest.expiryTs)})
              </span>
              <span
                className={cn(
                  "font-medium",
                  scoreColorClass(
                    newest.side,
                    currentPrice > 0
                      ? currentPrice > newest.entryPrice
                      : null,
                  ),
                )}
              >
                {currentPrice > 0
                  ? currentPrice > newest.entryPrice
                    ? "above strike"
                    : "below strike"
                  : "no live price"}
              </span>
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-zinc-400">
              {newest.status === "VOID"
                ? `Void (${newest.voidReason ?? "n/a"}) — excluded from win rate`
                : `Settled @ ${newest.settlementPrice ?? "—"} (${
                    newest.provenance.settlementSource ?? "—"
                  })`}
            </div>
          )}
        </div>
      )}

      {openEntries.length > 1 && (
        <p className="mt-1 text-[10px] text-zinc-500">
          {openEntries.length - 1} more open
        </p>
      )}

      {/* [538] stats, split by gate state + "n<30" guard */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <h5 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            Track record
          </h5>
          <button
            type="button"
            onClick={onExport}
            disabled={entries.length === 0}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] transition",
              entries.length > 0
                ? "border-white/15 text-zinc-300 hover:bg-white/10"
                : "cursor-not-allowed border-white/5 text-zinc-600",
            )}
          >
            Export CSV
          </button>
        </div>
        <div className="mt-1 rounded border border-white/10 bg-black/30 px-2 py-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-300">Overall win rate</span>
            <span className="font-semibold text-zinc-100">
              {fmtPct(stats.winRate)}
              <span className="ml-1 text-[10px] font-normal text-zinc-500">
                {stats.resolved > 0
                  ? `[${fmtPct(stats.wilson.low)}–${fmtPct(stats.wilson.high)}]`
                  : ""}
              </span>
            </span>
          </div>
          <div className="text-[10px] text-zinc-500">
            {stats.wins}W / {stats.losses}L / {stats.voids}V / {stats.open}open
            {!stats.meaningful &&
              stats.total > 0 &&
              ` · n<${JOURNAL_MEANINGFUL_MIN_N}: not meaningful`}
          </div>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          <StatBucket label="Engine tradable" stats={stats.byGateState.tradable} />
          <StatBucket label="Withheld" stats={stats.byGateState.withheld} />
        </div>
      </div>
    </div>
  );
};
