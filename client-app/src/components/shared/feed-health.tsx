"use client";

import { getLastPriceReceiveAtMs } from "@/store/useTradingStore";
import { useFeedHealth, type FeedFreshness } from "@/hooks/useFeedHealth";

/**
 * FEED HEALTH BAR
 * ============================================================================
 * A thin, non-interactive strip under the terminal toolbar answering one
 * question: "is what I'm looking at live tape, or a frozen picture?"
 *
 * RENDER-BUDGET OWNERSHIP (the important part)
 *
 * This component reads the 1 Hz age readout from its OWN hook instance. It is
 * deliberately NOT rendered from the Pro page's state, because a 1 Hz state
 * update at page level would re-render `ProTerminalInner` — and with it the
 * `FinancialChart` subtree — once per second for the life of the session.
 *
 * The page passes only the change-gated booleans, which flip on real
 * transitions, so the page re-renders on state changes but NEVER on the tick
 * clock. All continuous sampling is scoped to this leaf.
 *
 * The booleans are passed in rather than read from `useWebSocket` here on
 * purpose: the hook is per-instance, so a third call to it inside this
 * component would create a THIRD WebSocket + watchdog. The Pro page and the
 * Header already hold one each; that duplication is tracked for Phase 3
 * de-duplication, and this component must not add to it.
 */

export interface FeedHealthProps {
  connected: boolean;
  stale: boolean;
  stalled: boolean;
  /** Optional override for the packet-age source. Tests inject a fake clock. */
  getLastUpdateMs?: () => number | null;
  now?: () => number;
}

const TONE: Record<FeedFreshness, { text: string; dot: string; ring: string }> = {
  live: { text: "text-emerald-400", dot: "bg-emerald-400", ring: "ring-emerald-500/20" },
  delayed: { text: "text-amber-400", dot: "bg-amber-400", ring: "ring-amber-500/20" },
  stale: { text: "text-orange-400", dot: "bg-orange-500", ring: "ring-orange-500/25" },
  dead: { text: "text-rose-400", dot: "bg-rose-500", ring: "ring-rose-500/25" },
};

export function FeedHealthBar({
  connected,
  stale,
  stalled,
  getLastUpdateMs,
  now,
}: FeedHealthProps) {
  // Default source: the store's newest price timestamp, read via getState()
  // INSIDE the sampler's interval. This is not a subscription, so it adds no
  // re-render on tick arrival.
  const read = getLastUpdateMs ?? defaultLastUpdateMs;

  const { freshness, displayAge } = useFeedHealth({
    getLastUpdateMs: read,
    now,
  });

  // Precedence: a hard transport failure outranks an age-derived hint.
  const effective: FeedFreshness = !connected
    ? "dead"
    : stalled || stale
      ? "stale"
      : freshness;

  // SINGLE CLOCK GUARANTEE.
  //
  // `stale` (boolean) and `freshness` (derived from the SAME receive clock) are
  // two readings of one fact, so they agree by construction. The only
  // disagreement they can still exhibit is a SAMPLING artifact: the 1 Hz
  // sampler can be up to 1s behind the 1s heartbeat that sets the boolean, so
  // a feed that stalled mid-second can briefly read `freshness: "live"` while
  // the boolean is already true. We never let that show a green "LIVE" next to a
  // stale boolean — the boolean always wins, and a transport failure always
  // wins over both.
  const transportDown = !connected;
  const tone = TONE[effective];
  const label = transportDown
    ? "FEED DOWN"
    : stalled
      ? "STREAM STALLED"
      : stale
        ? "PRICE STALE"
        : effective === "live"
          ? "LIVE"
          : effective === "delayed"
            ? "DELAYED"
            // Reached only when `stale` is false, so the age really is in the
            // 2-10s band while the boolean has not yet tripped.
            : effective === "stale"
              ? "NO TICK"
              : "NO FEED";

  return (
    <div
      data-testid="feed-health"
      role="status"
      aria-live="off"
      className={`shrink-0 flex items-center gap-2 sm:gap-3 border-b border-[var(--tp-border)] bg-[var(--tp-elevated)]/60 px-3 sm:px-4 md:px-6 py-1.5 text-[9px] sm:text-[10px] font-mono uppercase tracking-widest`}
    >
      <span
        data-testid="feed-health-dot"
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot} ${
          effective === "live" ? "animate-pulse" : ""
        }`}
      />
      <span data-testid="feed-health-label" className={`font-bold ${tone.text}`}>
        {label}
      </span>
      <span className="text-ink-faint">·</span>
      <span data-testid="feed-health-age" className="text-ink-faint tabular-nums">
        {connected ? `last tick ${displayAge}` : "no socket"}
      </span>

      {stalled && (
        <span
          data-testid="feed-health-stalled"
          className="ml-auto text-orange-400 normal-case tracking-normal"
        >
          awaiting packets
        </span>
      )}
    </div>
  );
}

/**
 * Newest price timestamp from the trading store.
 *
 * `getState()` is a non-reactive read: it does not subscribe the caller and
 * does not schedule renders, which is exactly what a 1 Hz sampler wants. The
 * ISO string is the shape the store persists.
 */
function defaultLastUpdateMs(): number | null {
  // LOCAL RECEIVE CLOCK, not the store's `lastPriceUpdate` ISO string.
  //
  // `lastPriceUpdate` is stamped by history/replay bursts and /predict priming
  // and round-trips through `Date.parse`, so it is a DIFFERENT clock from packet
  // arrival. Reading it here let the derived `freshness` disagree with the
  // `stale` boolean in useWebSocket (which is driven by packet arrival), and a
  // disagreement in the 2-10s band rendered as a permanent "NO TICK" on a feed
  // that was demonstrably live. Both now read `getLastPriceReceiveAtMs()`.
  return getLastPriceReceiveAtMs() || null;
}

export default FeedHealthBar;
