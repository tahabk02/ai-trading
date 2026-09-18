"use client";

import React, { useEffect, useState } from "react";
import { useTradingStore, selectSelectedExpiration } from "@/store/useTradingStore";

export const PRO_EXPIRY_OPTIONS = [
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
] as const;

export function formatProCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface ProExpiryBarProps {
  symbol: string;
  currentPrice: number;
  anchorPrice?: number | null;
  targetPrice?: number | null;
  signal?: "BUY" | "SELL" | null;
  live: boolean;
}

export const ProExpiryBar: React.FC<ProExpiryBarProps> = ({
  symbol,
  currentPrice,
  anchorPrice,
  targetPrice,
  signal,
  live,
}) => {
  const expirationSeconds = useTradingStore(selectSelectedExpiration);
  const setSelectedExpirationSeconds = useTradingStore(
    (s) => s.setSelectedExpirationSeconds,
  );

  const [isMounted, setIsMounted] = useState(false);
  const [remainingS, setRemainingS] = useState<number>(expirationSeconds);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    const deadline = Date.now() + Math.max(1, expirationSeconds) * 1000;
    setRemainingS(Math.max(1, expirationSeconds));
    const iv = setInterval(() => {
      setRemainingS(Math.max(0, (deadline - Date.now()) / 1000));
    }, 250);
    return () => clearInterval(iv);
  }, [expirationSeconds]);

  const price = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;
  const direction = signal === "BUY" ? "UP" : signal === "SELL" ? "DOWN" : "HOLD";
  const dirColor =
    signal === "BUY"
      ? "text-emerald-400"
      : signal === "SELL"
        ? "text-rose-400"
        : "text-slate-400";
  const dirArrow = signal === "BUY" ? "▲" : signal === "SELL" ? "▼" : "·";

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-3 sm:px-4 py-2.5 sm:py-3 bg-obsidian-950/60 border border-slate-800 rounded-xl w-full">
      <div className="flex items-center flex-wrap gap-2 sm:gap-3">
        <span className="text-[9px] sm:text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
          Expiry
        </span>
        <span
          data-testid="pro-expiry-countdown"
          className="text-[10px] sm:text-[11px] font-black font-mono tabular-nums text-white bg-blue-600/20 border border-blue-500/40 rounded-md px-1.5 py-0.5"
        >
          {isMounted ? formatProCountdown(remainingS) : "--:--"}
        </span>
        <div className="flex items-center gap-1">
          {PRO_EXPIRY_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              type="button"
              data-testid={`pro-expiry-${opt.label}`}
              onClick={() => setSelectedExpirationSeconds(opt.seconds)}
              title={`Projection horizon: ${opt.label}`}
              className={`text-[10px] font-bold font-mono rounded-lg px-2 py-1 min-h-[30px] transition-all duration-200 active:scale-95 ${
                expirationSeconds === opt.seconds
                  ? "bg-accent text-white shadow-sm"
                  : "bg-obsidian-950/80 text-slate-400 hover:bg-slate-800 hover:text-white border border-slate-700/40"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <span
          data-testid="pro-tgt"
          className={`text-[10px] sm:text-[11px] font-black font-mono tabular-nums ${dirColor}`}
        >
          TGT {dirArrow} {targetPrice != null && Number.isFinite(targetPrice) ? targetPrice.toFixed(4) : "--"}
        </span>
        <span
          data-testid="pro-anc"
          className="text-[10px] sm:text-[11px] font-black font-mono tabular-nums text-sky-400"
        >
          ANC {anchorPrice != null && Number.isFinite(anchorPrice) ? anchorPrice.toFixed(4) : "--"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-emerald-500 animate-pulse" : "bg-rose-500"}`} />
          <span
            data-testid="pro-live-price"
            className="text-[10px] sm:text-[11px] font-black font-mono tabular-nums text-emerald-400"
          >
            {symbol} {price > 0 ? price.toFixed(4) : "--"}
          </span>
        </span>
      </div>
    </div>
  );
};