"use client";

import React, { memo, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/utils/cn";
import {
  useTerminalStore,
  selectActiveTier,
  selectActiveExpirySeconds,
  selectLeadOffsetMs,
  selectIsAutoExecutionActive,
} from "@/store/useTerminalStore";
import { useTradingStore } from "@/store/useTradingStore";
import { useSocket } from "@/hooks/useSocket";
import {
  TIER_ORDER,
  TIER_LABELS,
  TIER_THRESHOLDS,
  tierRank,
  type SignalTier,
} from "@/lib/signalTiers";
import {
  LEAD_OFFSET_OPTIONS,
  PRO_CONTROL_EXPIRY_OPTIONS,
} from "@/lib/leadOffset";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PRO CONTROL BAR — the terminal's interactive command surface.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three clusters, all reading from `useTerminalStore` (one field per selector,
 * so a flood of live ticks never re-renders this bar):
 *
 *   1. TIER   T1…T5   — writes `activeTier` → the grid + /predict min_tier.
 *   2. MODE   LOAD / AUTO / 20S / 1M / RESET FLOOR.
 *   3. EXPIRY 1s…5m   — writes `activeExpirySeconds` (projection + horizon).
 *
 * ANTI-DEADLOCK INVARIANT (preserved from pro-expiry-bar.tsx): NO control here
 * ever carries a `disabled` attribute. Tiers report their state via a tooltip
 * and a subtle badge; hard-disabling a tier created a circular deadlock where a
 * sub-threshold verdict locked the operator out of the control that would
 * clear the bar. Selection is always free; the engine's gate is reported, not
 * enforced here.
 */

interface ProControlBarProps {
  /** Canonical active symbol (upper-case). */
  symbol: string;
  /** Active chart timeframe (used for the forced LOAD refetch). */
  timeframe: string;
}

function ProControlBarImpl({ symbol, timeframe }: ProControlBarProps) {
  const { socket } = useSocket();

  const activeTier = useTerminalStore(selectActiveTier);
  const activeExpirySeconds = useTerminalStore(selectActiveExpirySeconds);
  const leadOffsetMs = useTerminalStore(selectLeadOffsetMs);
  const isAuto = useTerminalStore(selectIsAutoExecutionActive);
  const setActiveTier = useTerminalStore((s) => s.setActiveTier);
  const setExpirySeconds = useTerminalStore((s) => s.setExpirySeconds);
  const setLeadOffset = useTerminalStore((s) => s.setLeadOffset);
  const toggleAutoExecution = useTerminalStore((s) => s.toggleAutoExecution);
  const resetFloorSettings = useTerminalStore((s) => s.resetFloorSettings);

  const predictionLoading = useTradingStore((s) => s.isLoading);
  const getPrediction = useTradingStore((s) => s.getPrediction);
  // The engine's current verdict tier — used ONLY to annotate a tier control
  // (never to disable it). Low-frequency: changes at most once per evaluation.
  const verdictTier = useTradingStore((s) => s.predictionData?.tier ?? null);

  const handleLoad = useCallback(() => {
    const sym = (symbol || "").trim().toUpperCase();
    if (!sym) return;
    // `force` — a user-initiated LOAD must trigger an IMMEDIATE evaluation, not
    // sit behind the debounce.
    getPrediction(sym, timeframe, undefined, true);
  }, [symbol, timeframe, getPrediction]);

  const handleToggleAuto = useCallback(() => {
    const next = !useTerminalStore.getState().isAutoExecutionActive;
    toggleAutoExecution();
    // Best-effort backend notification. The backend ignores unknown events, so
    // this is a no-op until a handler lands — never a hard dependency.
    try {
      socket?.emit("toggle_auto_exec", {
        active: next,
        symbol: (symbol || "").trim().toUpperCase(),
        timeframe,
      });
    } catch {
      // socket unavailable (SSR / not yet connected) — local state is authority
    }
  }, [toggleAutoExecution, socket, symbol, timeframe]);

  const handleTier = useCallback(
    (tier: SignalTier) => setActiveTier(tier),
    [setActiveTier],
  );
  const handleExpiry = useCallback(
    (seconds: number) => setExpirySeconds(seconds),
    [setExpirySeconds],
  );
  const handleReset = useCallback(() => resetFloorSettings(), [resetFloorSettings]);

  return (
    <div
      data-testid="pro-control-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2 bg-obsidian-950/40 border-b border-slate-800/70"
    >
      {/* ── CLUSTER 1 — TIER SELECTOR ── */}
      <Cluster label="TIER">
        {TIER_ORDER.map((tier) => {
          const active = activeTier === tier;
          const pct = TIER_THRESHOLDS[tier] * 100;
          const verdictWeaker =
            verdictTier != null && tierRank(verdictTier) < tierRank(tier);
          return (
            <ControlPill
              key={tier}
              testId={`pro-tier-${tier}`}
              active={active}
              activeClass="border-cyan-500/50 bg-cyan-500/10 text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.25)]"
              onClick={() => handleTier(tier)}
              aria-pressed={active}
              title={
                `Trade tier ${tier} · ${TIER_LABELS[tier]} · floor ${pct.toFixed(1)}%` +
                (verdictWeaker
                  ? ` — current verdict ${verdictTier} is below this floor (still selectable)`
                  : "")
              }
            >
              {tier}
              {verdictWeaker ? (
                <span
                  aria-hidden
                  className="ml-1 inline-block w-1 h-1 rounded-full bg-amber-400 align-middle"
                />
              ) : null}
            </ControlPill>
          );
        })}
      </Cluster>

      <Divider />

      {/* ── CLUSTER 2 — MODE ACTIONS ── */}
      <Cluster label="MODE">
        <ControlPill
          testId="pro-mode-load"
          active={false}
          activeClass=""
          onClick={handleLoad}
          disabled={predictionLoading}
          aria-busy={predictionLoading}
          title="LOAD: Force refresh the historical bar buffer for this pair"
        >
          <RefreshCw
            size={11}
            className={cn("mr-1", predictionLoading && "animate-spin")}
          />
          LOAD
        </ControlPill>

        <ControlPill
          testId="pro-mode-auto"
          active={isAuto}
          activeClass="border-emerald-500/50 bg-emerald-500/10 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.25)]"
          onClick={handleToggleAuto}
          aria-pressed={isAuto}
          title="AUTO: Enable the automated signal execution pipeline"
        >
          AUTO
        </ControlPill>

        {LEAD_OFFSET_OPTIONS.filter((o) => o.value != null).map((opt) => {
          const active = (leadOffsetMs ?? null) === opt.value;
          return (
            <ControlPill
              key={opt.label}
              testId={`pro-mode-lead-${opt.label}`}
              active={active}
              activeClass="border-sky-500/50 bg-sky-500/10 text-sky-300 shadow-[0_0_10px_rgba(14,165,233,0.25)]"
              onClick={() => setLeadOffset(opt.value)}
              aria-pressed={active}
              title={`${opt.label}: ${opt.hint}`}
            >
              {opt.label}
            </ControlPill>
          );
        })}

        <ControlPill
          testId="pro-mode-reset-floor"
          active={false}
          activeClass=""
          onClick={handleReset}
          title="RESET FLOOR: restore the default tier clamp and confidence floor"
          className="border-rose-500/25 bg-rose-500/5 text-rose-300 hover:border-rose-400/50 hover:text-rose-200"
        >
          RESET FLOOR
        </ControlPill>
      </Cluster>

      <Divider />

      {/* ── CLUSTER 3 — EXPIRY SELECTOR ── */}
      <Cluster label="EXPIRY">
        {PRO_CONTROL_EXPIRY_OPTIONS.map((opt) => {
          const active = activeExpirySeconds === opt.seconds;
          return (
            <ControlPill
              key={opt.seconds}
              testId={`pro-expiry-pill-${opt.label}`}
              active={active}
              activeClass="bg-accent text-white border-accent shadow-[0_0_10px_rgba(59,130,246,0.3)]"
              onClick={() => handleExpiry(opt.seconds)}
              aria-pressed={active}
              title={`Set expiration to ${opt.label}`}
            >
              {opt.label}
            </ControlPill>
          );
        })}
      </Cluster>
    </div>
  );
}

// ── PRESENTATION PRIMITIVES (local, memoized) ──

const Cluster: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-center gap-1.5 min-w-0">
    <span className="text-[8px] sm:text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] shrink-0">
      {label}
    </span>
    <div className="flex items-center gap-1 flex-wrap">{children}</div>
  </div>
);

const Divider = () => <span className="hidden sm:inline-block w-px h-4 bg-slate-800" />;

interface ControlPillProps {
  testId: string;
  active: boolean;
  activeClass: string;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
  ariaPressed?: boolean;
  ariaBusy?: boolean;
  className?: string;
}

const ControlPill: React.FC<ControlPillProps> = ({
  testId,
  active,
  activeClass,
  onClick,
  title,
  children,
  disabled = false,
  ariaPressed,
  ariaBusy,
  className,
}) => (
  <button
    type="button"
    data-testid={testId}
    data-active={active ? "true" : "false"}
    aria-pressed={ariaPressed}
    aria-busy={ariaBusy}
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={cn(
      "inline-flex items-center text-[10px] font-bold font-mono rounded-lg px-2 py-1 min-h-[30px]",
      "transition-[transform,background-color,border-color,color,box-shadow] duration-75",
      "border border-slate-700/50 bg-obsidian-950/80 text-slate-400",
      "hover:border-slate-600 hover:text-slate-200 active:scale-[0.96]",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      active && activeClass,
      className,
    )}
  >
    {children}
  </button>
);

export const ProControlBar = memo(ProControlBarImpl);
export default ProControlBar;
