"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  useTradingStore,
  selectSelectedExpiration,
  selectSelectedTimeframe,
  expirySecondsToHorizonMinutes,
} from "@/store/useTradingStore";
import {
  expiryCountdownRemainingSeconds,
  expirySelectorState,
  type ExpiryOptionState,
} from "@/lib/expirySelection";
import { timeframeToSeconds } from "@/lib/realtimeCandleAggregator";
import { targetReasonCopy, targetStateForPayload } from "@/lib/signalRender";

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
  /* PART 24 [162] — the selector itself must reflect the gate: a scored_only
     or sub-zone symbol dims every expiry instead of staying fully interactive
     next to a WEAK/SCORED-ONLY badge. */
  tier?: string | null;
  regimeScoredOnly?: boolean;
  /* PART 40 [394]/[395] — the engine regime gate + sub-reason that decide
     whether a target may render at all, plus the reason the TGT slot is held. */
  regimeGate?: string | null;
  regimeDetail?: string | null;
}

export const ProExpiryBar: React.FC<ProExpiryBarProps> = ({
  symbol,
  currentPrice,
  anchorPrice,
  targetPrice,
  signal,
  live,
  tier = null,
  regimeScoredOnly = false,
  regimeGate = null,
  regimeDetail = null,
}) => {
  const expirationSeconds = useTradingStore(selectSelectedExpiration);
  const setSelectedExpirationSeconds = useTradingStore(
    (s) => s.setSelectedExpirationSeconds,
  );
  const selectedTimeframe = useTradingStore(selectSelectedTimeframe);
  // The AI prediction horizon. Kept in lock-step with the expiry buttons so the
  // TGT/ANC on screen always belong to the horizon the operator selected.
  const selectedHorizonMinutes = useTradingStore(
    (s) => s.selectedHorizonMinutes,
  );
  const setSelectedHorizonMinutes = useTradingStore(
    (s) => s.setSelectedHorizonMinutes,
  );

  const [isMounted, setIsMounted] = useState(false);
  const [remainingS, setRemainingS] = useState<number>(expirationSeconds);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const countdownAnchorRef = useRef(0);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    const anchorMs = Date.now();
    countdownAnchorRef.current = anchorMs;
    setRemainingS(
      expiryCountdownRemainingSeconds(anchorMs, anchorMs, expirationSeconds),
    );
    const iv = setInterval(() => {
      const tickMs = Date.now();
      setRemainingS(
        expiryCountdownRemainingSeconds(
          tickMs,
          countdownAnchorRef.current,
          expirationSeconds,
        ),
      );
      // PART 24 [161] — every 250ms tick re-evaluates the per-expiry action
      // window against the SAME wall clock the countdown runs on, so the
      // selector reflects the live "too late to act" boundary as it sweeps.
      setNowMs(tickMs);
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

  // PART 24 [162] — SELECTION IS NEVER GATED. The selector reports the
  // engine's regime/tier + bucket-timing state; it never enforces it. Every
  // option stays clickable at every point in the bucket sweep and at every
  // tier, because feeding this state into `disabled` created a circular
  // deadlock (a sub-threshold verdict disabled every option, so the operator
  // could never switch to a horizon that would clear the bar).
  const tfSeconds = timeframeToSeconds(selectedTimeframe) || 60;
  // PART 40 [395] — the regime reason rides the SAME channel the selector
  // already folds over the timing gate. The engine puts `pending_high_precision`
  // in `regime_gate` (the old check read it off `suppressed_reason`, so the
  // reason never reached this chip and it fell through to "BELOW TIER").
  const regimeReason = regimeScoredOnly
    ? "regime_scored_only"
    : regimeGate === "pending_high_precision"
      ? "pending_high_precision"
      : regimeGate === "scored_only"
        ? "regime_scored_only"
        : null;
  const selector = expirySelectorState(
    regimeScoredOnly ? "T5" : tier,
    regimeReason,
    tfSeconds,
    nowMs,
    PRO_EXPIRY_OPTIONS,
  );
  const bySeconds = new Map(
    selector.options.map((o) => [o.seconds as number, o]),
  );

  // PART 40 [394]/[395] — the SAME pure gate the chart runs: the TGT slot
  // shows the engine target only while regime_gate is "tradable" AND the tier
  // clears T1–T3; otherwise it states WHY it is held instead of printing "--".
  const targetState = targetStateForPayload({
    tier,
    regime_gate: regimeGate,
    suppressed_reason: regimeDetail,
    target_price: targetPrice ?? undefined,
  });
  const targetCopy = targetReasonCopy(targetState.reason, targetState.detail);
  const targetShown =
    targetState.showTarget &&
    targetPrice != null &&
    Number.isFinite(targetPrice) &&
    targetPrice > 0;

  // Status is reported for the horizon the operator actually SELECTED — not
  // preemptively for every option.
  const selectedOption = bySeconds.get(expirationSeconds as number) ?? null;

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
        {/* role=group + aria-pressed: a toggle group that is never disabled. */}
        <div
          role="group"
          aria-label="Target expiry horizon"
          data-testid="pro-expiry-options"
          className="flex items-center gap-1"
        >
          {PRO_EXPIRY_OPTIONS.map((opt) => {
            const st = bySeconds.get(opt.seconds);
            const tooLate = st?.tooLate ?? false;
            const horizonMinutes = expirySecondsToHorizonMinutes(opt.seconds);
            // A button is ACTIVE when BOTH store fields agree: the chart
            // projection horizon AND the AI evaluation horizon. Deliberately
            // NOT gated on the action-readiness state.
            const active =
              expirationSeconds === opt.seconds &&
              selectedHorizonMinutes === horizonMinutes;
            return (
              <button
                key={opt.seconds}
                type="button"
                data-testid={`pro-expiry-${opt.label}`}
                data-too-late={tooLate ? "true" : "false"}
                aria-pressed={active}
                // ALWAYS ENABLED. No `disabled` attribute exists in this
                // component by design — see the module note in expirySelection.ts.
                onClick={() => {
                  // ONE click drives BOTH horizons: the chart projection and the
                  // /predict evaluation. setSelectedHorizonMinutes clears the
                  // stale prediction and force-refetches for the new horizon, so
                  // TGT/ANC are recomputed for exactly this expiry.
                  setSelectedExpirationSeconds(opt.seconds);
                  setSelectedHorizonMinutes(horizonMinutes);
                }}
                title={
                  tooLate
                    ? `${opt.label} — bucket-aligned landing too close to act on; still selectable`
                    : `Projection horizon: ${opt.label}`
                }
                className={`text-[10px] font-bold font-mono rounded-lg px-2 py-1 min-h-[30px] transition-[transform,background-color,color] duration-75 active:scale-95 ${
                  active
                    ? "bg-accent text-white shadow-sm"
                    : tooLate
                      ? // Informational, NOT a lock: an amber underline marks the
                        // option as timing-constrained while staying fully usable.
                        "bg-obsidian-950/80 text-slate-300 hover:bg-slate-800 hover:text-white border border-amber-500/40 border-b-2"
                      : "bg-obsidian-950/80 text-slate-400 hover:bg-slate-800 hover:text-white border border-slate-700/40"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* PER-HORIZON STATUS — describes the SELECTED option only, and is
          informational. It is rendered next to the bar, never in place of it. */}
      <ExpiryHorizonStatus option={selectedOption} />

      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <span
          data-testid="pro-tgt"
          data-state={targetShown ? "target" : "withheld"}
          data-reason={targetState.reason ?? ""}
          data-detail={targetState.detail ?? ""}
          className={`text-[10px] sm:text-[11px] font-black font-mono tabular-nums ${
            targetShown ? dirColor : "text-amber-300"
          }`}
          title={targetShown ? undefined : targetCopy.hint}
        >
          {targetShown ? (
            <>
              TGT {dirArrow}{" "}
              {targetPrice != null && Number.isFinite(targetPrice)
                ? targetPrice.toFixed(4)
                : "--"}
            </>
          ) : (
            <>
              TGT — <span className="uppercase tracking-wider">{targetCopy.label}</span>
            </>
          )}
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

/**
 * Per-horizon status chip. Reports why the SELECTED expiry is (or is not)
 * action-ready right now, without ever implying the other options are closed.
 *
 * The distinction that matters:
 *   • `no_tier`        → EVALUATING. No verdict has landed yet; this is a
 *                         loading state, NOT a "no signal" alarm.
 *   • `regime_*`       → the engine's regime gate is closed for this symbol at
 *                         EVERY horizon (stated explicitly so the operator
 *                         knows switching will not help).
 *   • `too_late`       → transient; we say how long to wait.
 *   • ready            → nothing to say, chip hidden.
 */
const ExpiryHorizonStatus: React.FC<{
  option: ExpiryOptionState | null;
}> = ({ option }) => {
  if (!option) return null;

  if (option.actionReady) return null;

  const waitSeconds = Math.max(1, Math.ceil(option.retryInMs / 1000));
  let tone: "amber" | "slate" = "amber";
  let text: string;

  switch (option.reason) {
    case "no_tier":
      // Awaiting the first /predict for this horizon — not a failure.
      tone = "slate";
      text = "EVALUATING HORIZON…";
      break;
    case "regime_scored_only":
      text = "SCORED-ONLY — RANDOM WALK · ALL EXPIRIES";
      break;
    case "regime_pending_high_precision":
      // PART 40 [395] — the gate value, not an inference: the engine withholds
      // for many sub-reasons (otc_hf_fail, insufficient_history, …), so
      // claiming "below 96.5%" here would state a reason the engine never gave.
      text = "PENDING HIGH PRECISION · ALL EXPIRIES";
      break;
    case "low_tier":
      text = "BELOW TIER THRESHOLD · ALL EXPIRIES";
      break;
    case "too_late":
      text = `TOO LATE TO ACT — NEXT BUCKET IN ${waitSeconds}s`;
      break;
    default:
      tone = "slate";
      text = "NO VERDICT FOR THIS HORIZON";
  }

  const isAmber = tone === "amber";
  return (
    <div
      data-testid="pro-expiry-status"
      data-reason={option.reason ?? "unknown"}
      className={`w-full sm:w-auto flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${
        isAmber
          ? "border-amber-400/30 bg-amber-500/10"
          : "border-slate-700/50 bg-slate-800/30"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          isAmber ? "bg-amber-400" : "bg-slate-500 animate-pulse"
        }`}
      />
      <span className={isAmber ? "font-black text-amber-300" : "font-black text-slate-400"}>
        {text}
      </span>
    </div>
  );
};