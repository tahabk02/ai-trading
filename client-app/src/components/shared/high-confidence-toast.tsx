"use client";

/**
 * high-confidence-toast.tsx — HIGH-PRIORITY SIGNAL NOTIFICATION UI
 *
 * Listens to the backend WebSocket `high_confidence_signal` event (fired
 * whenever a dispatched signal's confidence crosses the strict DEFINITIVE
 * 96.5% thermal gate — only an organically converged 10-book confluence can
 * ever reach it) and renders a professional priority toast with an alert
 * sound.
 *
 * Features:
 *  • WebAudio-generated alert chime — no external asset required, works
 *    offline and never 404s. Audio context resumes on first user gesture
 *    per browser autoplay policy; the sound plays when permitted.
 *  • Auto-dismiss after 12 seconds with manual dismiss control.
 *  • Stack of up to 3 concurrent toasts (newest on top).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronUp,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import { useSocket } from "@/hooks/useSocket";
import { useLangContext } from "@/hooks/useLangContext";
import { useTradingStore } from "@/store/useTradingStore";
import { cn } from "@/utils/cn";
import { formatPairPrice } from "@/utils/format";

/** PRODUCTION THRESHOLD — mirrors the v10 AI Engine DEFINITIVE 96.5% thermal
 *  gate; a signal is priority-alerted only when all ten books organically
 *  converge to an actionable CALL/PUT at or above this confidence. */
const HIGH_CONFIDENCE_THRESHOLD = 96.5;

interface HighConfidenceSignal {
  id: string;
  symbol: string;
  signalType: "BUY" | "SELL";
  confidence: number;
  price: number;
  targetPrice: number;
  timeframe: string;
  timestamp: string;
}

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 12_000;

/**
 * DETERMINISTIC TOAST ID GENERATOR — zero-Math.random policy.
 * A monotonic session counter guarantees unique, collision-free IDs without
 * any PRNG usage anywhere in the notification pipeline.
 */
let toastIdCounter = 0;
function nextToastId(): string {
  toastIdCounter += 1;
  return `hc-${Date.now()}-${toastIdCounter}`;
}

/** Generate a crisp two-tone alert chime via the WebAudio API. */
function playAlertSound(): void {
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    // Resume if suspended by browser autoplay policy (best-effort)
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);

    // Two-tone institutional alert: E6 → A6
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(1318.51, now); // E6
    osc1.connect(gain);
    osc1.start(now);
    osc1.stop(now + 0.45);

    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(1760.0, now + 0.22); // A6
    osc2.connect(gain);
    osc2.start(now + 0.22);
    osc2.stop(now + 0.9);

    window.setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    // Audio unavailable (autoplay policy / unsupported) — silent fallback
  }
}

/**
 * DEDUPLICATION LEDGER — remembers recently alerted signals by their
 * symbol|direction|timeframe signature so neither the WebSocket event nor
 * the client-side confidence monitor can double-fire on the same setup
 * within the cooldown window.
 */
const ALERT_COOLDOWN_MS = 30_000;
let lastAlertSignature = "";
let lastAlertAt = 0;

function shouldAlert(signature: string): boolean {
  const now = Date.now();
  if (
    signature === lastAlertSignature &&
    now - lastAlertAt < ALERT_COOLDOWN_MS
  ) {
    return false;
  }
  lastAlertSignature = signature;
  lastAlertAt = now;
  return true;
}

export const HighConfidenceToast: React.FC = () => {
  const { socket } = useSocket();
  const { t } = useLangContext();
  const [toasts, setToasts] = useState<HighConfidenceSignal[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  /** Stable handle for pushing alerts from BOTH listeners below. */
  const pushAlertRef = useRef<(s: Omit<HighConfidenceSignal, "id">) => void>(
    () => undefined,
  );

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // ── CLIENT-SIDE CONFIDENCE MONITOR (defense-in-depth) ──
  // Watches every prediction that lands in the trading store. Whenever the
  // live AI confidence crosses the strict 96.5% DEFINITIVE thermal gate with
  // an active CALL/PUT direction, this monitor raises the same priority alert
  // as the backend WS broadcast — guaranteeing the trader is notified even if
  // the socket event was missed during a reconnect window.
  const predictionData = useTradingStore((s) => s.predictionData);
  useEffect(() => {
    if (!predictionData) return;
    const conf = Number(predictionData.confidence);
    const dir = predictionData.signal;
    if (!Number.isFinite(conf) || conf <= HIGH_CONFIDENCE_THRESHOLD) return;
    if (dir !== "BUY" && dir !== "SELL") return;

    const signature = `${predictionData.symbol}|${dir}|${predictionData.timeframe}`;
    if (!shouldAlert(signature)) return;

    pushAlertRef.current({
      symbol: predictionData.symbol,
      signalType: dir,
      confidence: conf,
      price: Number(predictionData.current_price ?? 0),
      targetPrice: Number(predictionData.target_price ?? 0),
      timeframe: predictionData.timeframe ?? "1d",
      timestamp: predictionData.timestamp ?? new Date().toISOString(),
    });
  }, [predictionData]);

  useEffect(() => {
    // ── Shared alert pipeline — used by BOTH the WS listener and the ──
    // ── client-side confidence monitor above.                        ──
    const pushAlert = (s: Omit<HighConfidenceSignal, "id">) => {
      const id = nextToastId();
      const signal: HighConfidenceSignal = { id, ...s };
      setToasts((prev) => [signal, ...prev].slice(0, MAX_TOASTS));
      playAlertSound();
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    };
    pushAlertRef.current = pushAlert;

    if (!socket) return;

    // Capture the timer map ONCE — stable across this effect's lifetime so
    // the cleanup function never dereferences a mutated ref value.
    const timers = timersRef.current;

    const onHighConfidence = (payload: {
      symbol?: string;
      signalType?: string;
      confidence?: number;
      price?: number;
      targetPrice?: number;
      timeframe?: string;
      timestamp?: string;
    }) => {
      if (!payload?.symbol || !payload?.signalType) return;
      if (payload.signalType !== "BUY" && payload.signalType !== "SELL") return;

      // Enforce the >=96.5% THERMAL-GATE threshold + cooldown dedup on the
      // wire payload too (only organically converged DEFINITIVE alerts).
      const conf = Number(payload.confidence ?? 0);
      if (!Number.isFinite(conf) || conf <= HIGH_CONFIDENCE_THRESHOLD) return;
      const signature = `${payload.symbol}|${payload.signalType}|${payload.timeframe ?? ""}`;
      if (!shouldAlert(signature)) return;

      pushAlert({
        symbol: payload.symbol,
        signalType: payload.signalType,
        confidence: conf,
        price: Number(payload.price ?? 0),
        targetPrice: Number(payload.targetPrice ?? 0),
        timeframe: payload.timeframe ?? "1d",
        timestamp: payload.timestamp ?? new Date().toISOString(),
      });
    };

    socket.on("high_confidence_signal", onHighConfidence);

    return () => {
      socket.off("high_confidence_signal", onHighConfidence);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [socket, dismiss]);

  return (
    <div className="fixed bottom-4 left-4 z-[100] w-[min(calc(100vw-2rem),22rem)] pointer-events-none sm:bottom-5 sm:left-5">
      {toasts.length > 0 && (
        <div className="flex flex-col items-start gap-2">
          {isOpen && (
            <div className="pointer-events-auto flex max-h-[min(70vh,32rem)] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/80 shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl animate-in slide-in-from-bottom-3 fade-in duration-300">
              <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300">
                    <Bell className="h-3.5 w-3.5" />
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-300 px-1 text-[9px] font-black text-slate-950">
                      {toasts.length}
                    </span>
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-black uppercase tracking-[0.18em] text-slate-300">
                      {t("highConfidenceTitle")}
                    </p>
                    <p className="text-[10px] font-mono text-slate-500">
                      {t("highConfidenceBody")}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label={t("dismiss")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
              <div className="custom-scrollbar flex flex-col gap-2 overflow-y-auto p-2">
                {toasts.map((toast) => {
                  const isBuy = toast.signalType === "BUY";
                  return (
                    <div
                      key={toast.id}
                      role="alert"
                      aria-live="assertive"
                      className={cn(
                        "pointer-events-auto overflow-hidden rounded-xl border shadow-lg backdrop-blur-xl",
                        "animate-in slide-in-from-bottom-2 fade-in duration-300",
                        isBuy
                          ? "bg-emerald-950/85 border-emerald-500/60"
                          : "bg-rose-950/85 border-rose-500/60",
                      )}
                    >
                      {/* Priority accent bar */}
                      <div
                        className={cn(
                          "h-1 w-full",
                          isBuy
                            ? "bg-gradient-to-r from-emerald-400 to-emerald-600"
                            : "bg-gradient-to-r from-rose-400 to-rose-600",
                        )}
                      />

                      <div className="px-4 py-3">
                        {/* Header */}
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={cn(
                                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                                isBuy
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : "bg-rose-500/20 text-rose-300",
                              )}
                            >
                              <Zap className="w-4 h-4" />
                            </span>
                            <div className="min-w-0">
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-300 truncate">
                                {t("highConfidenceTitle")}
                              </p>
                              <p className="text-xs font-bold text-white font-mono truncate">
                                {toast.symbol} · {toast.timeframe.toUpperCase()}
                              </p>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => dismiss(toast.id)}
                            aria-label={t("dismiss")}
                            className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Body */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-black uppercase",
                                isBuy
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : "bg-rose-500/20 text-rose-300",
                              )}
                            >
                              {isBuy ? (
                                <TrendingUp className="w-3 h-3" />
                              ) : (
                                <TrendingDown className="w-3 h-3" />
                              )}
                              {isBuy ? "BUY" : "SELL"}
                            </span>
                            <span className="text-lg font-black text-white font-mono tabular-nums">
                              {toast.confidence.toFixed(1)}%
                            </span>
                          </div>

                          <div className="text-right font-mono text-[11px] leading-tight">
                            <p className="text-slate-400">
                              @{" "}
                              <span className="text-slate-200">
                                {formatPairPrice(toast.price, toast.symbol)}
                              </span>
                            </p>
                            <p className="text-slate-400">
                              →{" "}
                              <span
                                className={cn(
                                  isBuy ? "text-emerald-300" : "text-rose-300",
                                )}
                              >
                                {formatPairPrice(
                                  toast.targetPrice,
                                  toast.symbol,
                                )}
                              </span>
                            </p>
                          </div>
                        </div>

                        <p className="mt-2 text-[10px] text-slate-400 uppercase tracking-wider">
                          {t("highConfidenceBody")}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setIsOpen((open) => !open)}
            aria-expanded={isOpen}
            aria-label={t("highConfidenceTitle")}
            className="pointer-events-auto inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-slate-950/85 px-3 py-2 text-left shadow-[0_12px_35px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-all duration-300 hover:border-amber-300/40 hover:bg-slate-900/95 animate-in slide-in-from-bottom-3 fade-in"
          >
            <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
              <Bell className="h-3.5 w-3.5" />
              <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-300 px-0.5 text-[8px] font-black text-slate-950">
                {toasts.length}
              </span>
            </span>
            <span className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-300">
              {isOpen ? "Hide signals" : "Signal center"}
            </span>
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 text-slate-500" />
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default HighConfidenceToast;
