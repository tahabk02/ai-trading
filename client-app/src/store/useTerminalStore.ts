"use client";

import { create } from "zustand";
import {
  useTradingStore,
  expirySecondsToHorizonMinutes,
} from "@/store/useTradingStore";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import {
  DEFAULT_EXECUTION_TIER,
  executionFloorPct,
  type TierSelection,
} from "@/lib/signalTiers";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ALPHA.5 PRO TERMINAL STORE — the UI-preference slice for the Pro Terminal.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DELIBERATELY SLIM. This store owns NO market data, NO trade execution, NO
 * WebSocket lifecycle. `useTradingStore` remains the single source of truth for
 * ticks/candles/predictions/execution and `useMarketTerminalStore` for the
 * grid's tier floor. Duplicating any of that here would fork the WS pipeline.
 *
 * What it DOES own:
 *   • isAutoExecutionActive  — Pro-only UI toggle (localStorage)
 *   • serverTimeOffsetMs     — server↔client clock offset (Phase 2 estimator)
 *
 * What it MIRRORS (read-through) for a single terminal-facing import surface:
 *   • activeTier        ⇄ useMarketTerminalStore.minTier
 *   • confidenceFloor   ⇄ useMarketTerminalStore.minConfidencePct (DERIVED)
 *   • activeExpirySeconds ⇄ useTradingStore.selectedExpirationSeconds
 *   • leadOffsetMs      ⇄ useTradingStore.selectedLeadOffsetMs
 *
 * The mirrors are kept in sync by module-level subscriptions on the source
 * stores, so an external write (settings page, deep link `?tf=`, aggregation
 * hydrate) lands here too — never a one-way stale copy. Writes go THROUGH the
 * source store's action first, then the mirror is refreshed from its result.
 */

const LS_AUTO_EXEC_KEY = "alpha5.pro.autoExecution";

/**
 * The platform's baseline floor. NOT an arbitrary slider value.
 *
 * `minConfidencePct` is DERIVED from the tier (see useMarketTerminalStore
 * L147–160): a free-floating floor could express a bar below the lowest
 * tradable band and violate the engine's floor. So `confidenceFloor` here is a
 * MIRROR of the derived value, and "reset floor" means "restore the default
 * TIER", which re-derives the honest baseline (T1 → 96.5%).
 */
export const DEFAULT_CONFIDENCE_FLOOR = executionFloorPct(DEFAULT_EXECUTION_TIER);

function readPersistedAutoExecution(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(LS_AUTO_EXEC_KEY) === "true";
  } catch {
    return false;
  }
}

function persistAutoExecution(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_AUTO_EXEC_KEY, value ? "true" : "false");
  } catch {
    // localStorage may be unavailable (SSR, privacy mode)
  }
}

export interface TerminalState {
  // ── Pro-only state ──
  isAutoExecutionActive: boolean;
  serverTimeOffsetMs: number;

  // ── Read-through mirrors (do not set directly) ──
  activeTier: TierSelection;
  confidenceFloor: number;
  activeExpirySeconds: number;
  leadOffsetMs: number | null;

  // ── Actions ──
  setActiveTier: (tier: TierSelection) => void;
  setExpirySeconds: (seconds: number) => void;
  setLeadOffset: (offsetMs: number | null) => void;
  toggleAutoExecution: () => void;
  setAutoExecution: (active: boolean) => void;
  resetFloorSettings: () => void;
  setServerTimeOffsetMs: (offsetMs: number) => void;
  /** Hydrate localStorage-derived Pro state AFTER first paint (client only). */
  hydrateTerminalPreferences: () => void;
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  isAutoExecutionActive: false,
  serverTimeOffsetMs: 0,

  // Deterministic mirrors from the source stores' SSR-safe defaults, so the
  // first painted frame matches on server and client (no hydration mismatch).
  activeTier: useMarketTerminalStore.getState().minTier,
  confidenceFloor: useMarketTerminalStore.getState().minConfidencePct,
  activeExpirySeconds: useTradingStore.getState().selectedExpirationSeconds,
  leadOffsetMs: useTradingStore.getState().selectedLeadOffsetMs,

  setActiveTier: (tier) => {
    // Source store first — it owns the tier→floor derivation AND the persisted
    // key. The mirror is then refreshed from its result (never assumed).
    useMarketTerminalStore.getState().setMinTier(tier);
    set({
      activeTier: useMarketTerminalStore.getState().minTier,
      confidenceFloor: useMarketTerminalStore.getState().minConfidencePct,
    });
  },

  setExpirySeconds: (seconds) => {
    const trading = useTradingStore.getState();
    // ONE click drives BOTH horizons (chart projection + /predict evaluation),
    // exactly as the Pro expiry bar does — see pro-expiry-bar.tsx.
    trading.setSelectedExpirationSeconds(seconds);
    // Sub-minute expiries have NO AI horizon bucket (the horizon grid is 1–10
    // minutes). Propagate only minute-scale selections, so a 1s projection
    // never resets the /predict evaluation horizon to the 5m default.
    if (seconds >= 60) {
      trading.setSelectedHorizonMinutes(
        expirySecondsToHorizonMinutes(seconds),
      );
    }
    set({ activeExpirySeconds: useTradingStore.getState().selectedExpirationSeconds });
  },

  setLeadOffset: (offsetMs) => {
    useTradingStore.getState().setLeadOffset(offsetMs);
    set({ leadOffsetMs: useTradingStore.getState().selectedLeadOffsetMs });
  },

  toggleAutoExecution: () => {
    const next = !get().isAutoExecutionActive;
    persistAutoExecution(next);
    set({ isAutoExecutionActive: next });
  },

  setAutoExecution: (active) => {
    if (active === get().isAutoExecutionActive) return;
    persistAutoExecution(active);
    set({ isAutoExecutionActive: active });
  },

  resetFloorSettings: () => {
    // Restore the default TIER (the confidence floor is derived from it). The
    // lead offset returns to AUTO (null = exact PO floor grid).
    useMarketTerminalStore.getState().setMinTier(DEFAULT_EXECUTION_TIER);
    useTradingStore.getState().setLeadOffset(null);
    set({
      activeTier: useMarketTerminalStore.getState().minTier,
      confidenceFloor: useMarketTerminalStore.getState().minConfidencePct,
      leadOffsetMs: useTradingStore.getState().selectedLeadOffsetMs,
    });
  },

  setServerTimeOffsetMs: (offsetMs) => {
    if (!Number.isFinite(offsetMs)) return;
    if (offsetMs === get().serverTimeOffsetMs) return;
    set({ serverTimeOffsetMs: offsetMs });
  },

  hydrateTerminalPreferences: () => {
    if (typeof window === "undefined") return;
    set({ isAutoExecutionActive: readPersistedAutoExecution() });
  },
}));

// ── EXTERNAL SYNC ──────────────────────────────────────────────────────────
// Keep the mirrors truthful when the SOURCE stores change from anywhere else
// (settings page, deep link `?tf=`, aggregator hydration, WS re-subscribe).
// Guarded on equality so a no-op change never notifies, and never loops back
// into the source store (these callbacks only touch this store's `set`).

useMarketTerminalStore.subscribe((state) => {
  const terminal = useTerminalStore.getState();
  if (state.minTier !== terminal.activeTier || state.minConfidencePct !== terminal.confidenceFloor) {
    useTerminalStore.setState({
      activeTier: state.minTier,
      confidenceFloor: state.minConfidencePct,
    });
  }
});

useTradingStore.subscribe((state) => {
  const terminal = useTerminalStore.getState();
  const patch: Partial<TerminalState> = {};
  if (state.selectedExpirationSeconds !== terminal.activeExpirySeconds) {
    patch.activeExpirySeconds = state.selectedExpirationSeconds;
  }
  if (state.selectedLeadOffsetMs !== terminal.leadOffsetMs) {
    patch.leadOffsetMs = state.selectedLeadOffsetMs;
  }
  if (Object.keys(patch).length > 0) {
    useTerminalStore.setState(patch);
  }
});

// ── SELECTORS ──
export const selectActiveTier = (s: TerminalState) => s.activeTier;
export const selectConfidenceFloor = (s: TerminalState) => s.confidenceFloor;
export const selectActiveExpirySeconds = (s: TerminalState) => s.activeExpirySeconds;
export const selectLeadOffsetMs = (s: TerminalState) => s.leadOffsetMs;
export const selectIsAutoExecutionActive = (s: TerminalState) => s.isAutoExecutionActive;
export const selectServerTimeOffsetMs = (s: TerminalState) => s.serverTimeOffsetMs;
