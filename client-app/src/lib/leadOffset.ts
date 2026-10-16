/**
 * leadOffset.ts — PREDICTIVE LEAD-TIME OFFSET options for the Pro Terminal.
 *
 * Extracted from `financial-chart.tsx` so the control bar and the chart read
 * ONE option table (the chart no longer renders its own duplicate selector —
 * it reads `selectedLeadOffsetMs` from the store, which the control bar writes).
 *
 *   AUTO (null) → lead 0 = EXACT PO floor grid
 *                 (`floor(ts / interval) * interval`, byte-identical parity
 *                  with the backend aggregator).
 *   20S / 1M    → re-project every candle that far AHEAD of the live feed.
 */
export interface LeadOffsetOption {
  label: string;
  value: number | null;
  hint: string;
}

export const LEAD_OFFSET_OPTIONS: ReadonlyArray<LeadOffsetOption> = [
  {
    label: "AUTO",
    value: null,
    hint: "Auto (default): exact PO floor grid — candles line up 1:1 with the backend",
  },
  {
    label: "20S",
    value: 20_000,
    hint: "Project candles 20s ahead of the live feed",
  },
  {
    label: "1M",
    value: 60_000,
    hint: "Project candles 60s ahead of the live feed",
  },
];

/**
 * EXPIRY SELECTOR options for the Pro Terminal control bar.
 *
 * Every value is drawn from the canonical Pocket-Option expiration set
 * (`PO_EXPIRATION_SECONDS_SET`), so each pill maps 1:1 onto a real settable
 * expiration — ZERO dead-clicks. 2s/3s are deliberately ABSENT: they are not in
 * the PO set, so a `2s` pill would silently snap to 1s and its active
 * highlight could never match.
 */
export const PRO_CONTROL_EXPIRY_OPTIONS: ReadonlyArray<{
  label: string;
  seconds: number;
}> = [
  { label: "1s", seconds: 1 },
  { label: "5s", seconds: 5 },
  { label: "10s", seconds: 10 },
  { label: "15s", seconds: 15 },
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "3m", seconds: 180 },
  { label: "5m", seconds: 300 },
];
