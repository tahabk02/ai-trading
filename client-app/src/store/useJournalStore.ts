"use client";

import { create } from "zustand";
import apiClient from "@/services/api";
import {
  applySettlement,
  journalEntriesToCsv,
  openJournalEntry,
  type JournalEntry,
  type JournalGateSnapshot,
  type JournalSide,
  type JournalTick,
} from "@/lib/tradeJournal";

/**
 * useJournalStore — PART 50 [535]-[538] local trade-journal state.
 *
 * The journal is a stopwatch + scoreboard for trades the operator says they
 * took on Pocket Option. NOTHING is ever sent to PO: the backend `/journal`
 * routes persist rows to OUR database only. Entries are appended optimistically
 * so the UI never stalls on the network.
 */

interface JournalState {
  entries: JournalEntry[];
  /**
   * [537] Rolling buffer of genuine PO ticks. Settlement resolves against this
   * — the LAST tick at or before expiry — so a trade is never scored off the
   * first print that lands after the boundary.
   */
  ticks: JournalTick[];
  hydrated: boolean;
  lastError: string | null;
  /** Load persisted entries on mount (best-effort; local state survives). */
  hydrate: () => Promise<void>;
  /** [536] Append a genuine PO tick to the settlement buffer (deduped by ts). */
  pushTick: (tick: JournalTick) => void;
  /** [535]/[536] Record an entry from a live PO tick. Returns null if refused. */
  record: (args: {
    tick: JournalTick | null;
    side: JournalSide;
    durationSec: number;
    gate: JournalGateSnapshot;
    nowMs: number;
  }) => JournalEntry | null;
  /** [537] Settle every OPEN entry whose expiry has passed, from the buffer. */
  settleDue: (nowMs: number) => void;
  /** [538] Serialize the whole journal to CSV. */
  toCsv: () => string;
  clear: () => void;
}

/** Cap the settlement buffer (~50 min of 1s ticks) to bound memory. */
const JOURNAL_TICK_BUFFER_MAX = 3000;

function persist(entry: JournalEntry): void {
  void apiClient
    .createJournalEntry({
      id: entry.id,
      symbol: entry.symbol,
      side: entry.side,
      entryTs: entry.entryTs,
      entryPrice: entry.entryPrice,
      durationSec: entry.durationSec,
      expiryTs: entry.expiryTs,
      regimeGate: entry.gate.regimeGate,
      tier: entry.gate.tier,
      executable: entry.gate.executable,
      suppressedReason: entry.gate.suppressedReason,
      bookAligned: entry.gate.bookAgreement?.aligned ?? null,
      bookActive: entry.gate.bookAgreement?.active ?? null,
      signal: entry.gate.signal,
      entrySource: entry.provenance.entrySource,
    })
    .catch(() => {
      /* local journal is the source of truth; persistence is best-effort */
    });
}

function persistSettlement(entry: JournalEntry): void {
  if (entry.status === "OPEN") return;
  void apiClient
    .settleJournalEntry(entry.id, {
      status: entry.status,
      settlementPrice: entry.settlementPrice,
      settlementTs: entry.settlementTs,
      voidReason: entry.voidReason,
      settlementSource: entry.provenance.settlementSource,
    })
    .catch(() => {});
}

export const useJournalStore = create<JournalState>((set, get) => ({
  entries: [],
  ticks: [],
  hydrated: false,
  lastError: null,

  pushTick: (tick) => {
    set((state) => {
      const last = state.ticks[state.ticks.length - 1];
      if (last && last.tsMs >= tick.tsMs) return state;
      const ticks = [...state.ticks, tick];
      if (ticks.length > JOURNAL_TICK_BUFFER_MAX) {
        ticks.splice(0, ticks.length - JOURNAL_TICK_BUFFER_MAX);
      }
      return { ticks };
    });
  },

  hydrate: async () => {
    try {
      const res = await apiClient.getJournalEntries(200);
      const remote: JournalEntry[] = (res.entries ?? []).map((r) => ({
        id: r.id,
        symbol: r.symbol,
        side: r.side,
        entryTs: Number(r.entryTs),
        entryPrice: r.entryPrice,
        durationSec: r.durationSec,
        expiryTs: Number(r.expiryTs),
        gate: {
          regimeGate: r.regimeGate ?? null,
          tier: r.tier ?? null,
          executable: r.executable === true,
          suppressedReason: r.suppressedReason ?? null,
          bookAgreement:
            r.bookAligned != null && r.bookActive != null
              ? { aligned: r.bookAligned, active: r.bookActive }
              : null,
          signal: (r.signal as "BUY" | "SELL" | null) ?? null,
        },
        status: r.status,
        settlementPrice: r.settlementPrice ?? null,
        settlementTs: r.settlementTs == null ? null : Number(r.settlementTs),
        voidReason: r.voidReason ?? null,
        provenance: {
          entrySource: r.entrySource,
          settlementSource: r.settlementSource ?? null,
        },
        impliesSignal: false,
      }));
      // Merge: never clobber a local entry the server has not seen yet.
      set((state) => {
        const byId = new Map(remote.map((e) => [e.id, e]));
        for (const local of state.entries) byId.set(local.id, local);
        return {
          entries: [...byId.values()].sort((a, b) => b.entryTs - a.entryTs),
          hydrated: true,
          lastError: null,
        };
      });
    } catch (err) {
      set({
        hydrated: true,
        lastError: err instanceof Error ? err.message : "journal hydrate failed",
      });
    }
  },

  record: ({ tick, side, durationSec, gate, nowMs }) => {
    let entry: JournalEntry | null = null;
    try {
      entry = openJournalEntry({ tick, side, durationSec, gate, nowMs });
    } catch {
      return null;
    }
    set((state) => ({ entries: [entry as JournalEntry, ...state.entries] }));
    persist(entry);
    // Seed the settlement buffer with the entry tick itself.
    if (tick) get().pushTick(tick);
    return entry;
  },

  settleDue: (nowMs) => {
    const { entries, ticks } = get();
    const settledNow: JournalEntry[] = [];
    for (const e of entries) {
      if (e.status !== "OPEN" || nowMs < e.expiryTs) continue;
      const settled = applySettlement(e, ticks, nowMs);
      if (settled.status === "OPEN") continue;
      settledNow.push(settled);
    }
    if (settledNow.length === 0) return;
    const byId = new Map(settledNow.map((e) => [e.id, e]));
    set((state) => ({
      entries: state.entries.map((e) => byId.get(e.id) ?? e),
    }));
    for (const e of settledNow) persistSettlement(e);
  },

  toCsv: () => journalEntriesToCsv(get().entries),

  clear: () => set({ entries: [] }),
}));
