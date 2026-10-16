/**
 * departureLine.ts — EXACT DEPARTURE ("Ligne du Départ") resolver (non-fabricating).
 *
 * The engine ships an exact departure contract on the horizon block
 * (`prediction.horizon.departure`, produced by
 * `ai-engine/app/services/expiry_engine.py::compute_departure_line`): the
 * strike (the REAL live price at projection time), the projected target, the
 * entry window in epoch-ms, and the ATR-derived slippage tolerance.
 *
 * This module does NOT compute or invent a level. It:
 *   1. re-evaluates the LIVE status each tick from the real live price + clock
 *      (the engine's `status` is a snapshot at emission time), and
 *   2. translates the status into readable copy for the terminal.
 *
 * It withholds the line entirely — `renderLine === false`, every level null —
 * when the engine had no valid basis (flat tape / short regression), so the UI
 * renders "WAITING FOR VALID ENTRY LEVEL" instead of a synthetic departure.
 */

import type { DepartureContract, DepartureStatus } from "@/services/api";

export interface DepartureView {
  /** True only when real strike + target levels are present. */
  available: boolean;
  status: DepartureStatus;
  side: "CALL" | "PUT" | null;
  strikePrice: number | null;
  targetPrice: number | null;
  entryWindowStartMs: number | null;
  entryWindowEndMs: number | null;
  maxAllowedSlippage: number | null;
  /** |live price − strike| re-derived from the current live tick. */
  slippage: number | null;
  /** Seconds until the entry window opens (0 once open). */
  entryCountdownSec: number;
  /** Seconds until the entry window closes (0 once closed). */
  zoneValidRemainingSec: number;
  /** False ⇒ do not draw a departure line; show the waiting state instead. */
  renderLine: boolean;
  /** Pending windows draw dashed; open/closed draw solid. */
  style: "solid" | "dashed";
  /** Short, uppercase, terminal-sized label. */
  label: string;
  /** One-sentence explanation of the current status. */
  hint: string;
}

interface DepartureCopy {
  label: string;
  hint: string;
}

/**
 * Status → readable copy. Keys are the exact status vocabulary emitted by the
 * engine (never invented here).
 */
export const DEPARTURE_COPY: Record<DepartureStatus, DepartureCopy> = {
  ACTIVE: {
    label: "ENTRY ZONE VALID",
    hint: "Price is within tolerance of the strike — inside the valid entry window.",
  },
  PENDING: {
    label: "ENTRY COUNTDOWN",
    hint: "Waiting for the entry window to open.",
  },
  EXPIRED_ZONE: {
    label: "ENTRY EXPIRED",
    hint: "The entry window has closed for this contract.",
  },
  MISSED_ENTRY: {
    label: "SLIPPAGE TOO HIGH",
    hint: "Price has drifted past the allowed entry tolerance for this strike.",
  },
  WAITING_FOR_VALID_ENTRY_LEVEL: {
    label: "WAITING FOR VALID ENTRY LEVEL",
    hint: "No real regression basis yet — no entry level is drawn.",
  },
};

const WAITING: DepartureStatus = "WAITING_FOR_VALID_ENTRY_LEVEL";

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function finitePositive(value: unknown): number | null {
  const n = finite(value);
  return n != null && n > 0 ? n : null;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function waitingView(): DepartureView {
  return {
    available: false,
    status: WAITING,
    side: null,
    strikePrice: null,
    targetPrice: null,
    entryWindowStartMs: null,
    entryWindowEndMs: null,
    maxAllowedSlippage: null,
    slippage: null,
    entryCountdownSec: 0,
    zoneValidRemainingSec: 0,
    renderLine: false,
    style: "dashed",
    label: DEPARTURE_COPY[WAITING].label,
    hint: DEPARTURE_COPY[WAITING].hint,
  };
}

export interface ResolveDepartureOptions {
  /** The current live price (drives the real slippage re-check). */
  livePrice?: number | null;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Resolve the live departure view from the engine's departure contract.
 *
 * Precedence (mirrors the engine, first match wins):
 *   WAITING_FOR_VALID_ENTRY_LEVEL — no usable contract/levels
 *   EXPIRED_ZONE                  — now is past entry_window_end_ms
 *   MISSED_ENTRY                  — |live − strike| > max_allowed_slippage
 *   PENDING                       — now is before entry_window_start_ms
 *   ACTIVE                        — inside the window and within tolerance
 */
export function resolveDepartureLine(
  departure: DepartureContract | null | undefined,
  opts: ResolveDepartureOptions = {},
): DepartureView {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();

  if (!departure || departure.available !== true) {
    return waitingView();
  }

  const strike = finitePositive(departure.strike_price);
  const target = finitePositive(departure.target_price);
  if (strike == null || target == null) {
    return waitingView();
  }

  const start = finite(departure.entry_window_start_ms);
  const end = finite(departure.entry_window_end_ms);
  const maxSlippage = finitePositive(departure.max_allowed_slippage);
  const live = finitePositive(opts.livePrice);
  const slippage = live != null ? round(Math.abs(live - strike), 5) : null;

  const side: "CALL" | "PUT" | null =
    departure.side === "CALL" || departure.side === "PUT"
      ? departure.side
      : null;

  let status: DepartureStatus;
  if (end != null && nowMs > end) {
    status = "EXPIRED_ZONE";
  } else if (
    slippage != null &&
    maxSlippage != null &&
    slippage > maxSlippage
  ) {
    status = "MISSED_ENTRY";
  } else if (start != null && nowMs < start) {
    status = "PENDING";
  } else {
    status = "ACTIVE";
  }

  const copy = DEPARTURE_COPY[status];

  return {
    available: true,
    status,
    side,
    strikePrice: round(strike, 5),
    targetPrice: round(target, 5),
    entryWindowStartMs: start,
    entryWindowEndMs: end,
    maxAllowedSlippage: maxSlippage,
    slippage,
    entryCountdownSec:
      start != null ? Math.max(0, (start - nowMs) / 1000) : 0,
    zoneValidRemainingSec:
      end != null ? Math.max(0, (end - nowMs) / 1000) : 0,
    renderLine: true,
    style: status === "PENDING" ? "dashed" : "solid",
    label: copy.label,
    hint: copy.hint,
  };
}
