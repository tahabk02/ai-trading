/**
 * ── PROJECTION ATR NORMALISATION ─────────────────────────────────────────
 *
 * WHY THIS EXISTS
 * ---------------
 * `buildTargetFrame` (realtimeCandleAggregator.ts) sizes each projected candle's
 * wick as:
 *
 *     wick = min(atr * 0.35 * taper, safetyCap)
 *     safetyCap = max(|baseline|, |target|) * 0.5     // 50% OF THE PRICE
 *
 * The `safetyCap` is documented as the guard that "kills pathological ATR
 * values". It does not — it is the *only* thing shaping the geometry once ATR is
 * out of scale, and because it sits at **50% of the price level** it converts a
 * unit error into a wick that reaches half the chart. On a shared right price
 * scale that renders as exactly the reported symptom: projected candles with
 * vertical spikes shooting up to the ceiling.
 *
 * A "safety" clamp loose enough to reach the top of the chart is not a safety
 * clamp. So the real fix is to stop out-of-scale ATR from ever reaching the
 * projector, and to make the cap unreachable by normal inputs.
 *
 * WHAT IS REJECTED, AND WHY IT IS SAFE TO REJECT IT
 * -------------------------------------------------
 * This projection is a SHORT-horizon trajectory (the expiry selector tops out in
 * minutes, not months). For that horizon, an ATR larger than
 * `MAX_ATR_FRACTION_OF_PRICE` of the anchor level is not volatility — it is a
 * unit error: pips instead of price units, percent instead of a fraction, or a
 * field that means something else entirely on the wire. The AI engine already
 * emits `atr` rounded to 8 decimals in price units (ai-engine/app/api/v1/
 * signals.py:1084), and even its own fallback is `close * 0.01` (signals.py:
 * 1057) — a full 1% of price, still inside this bound. Genuine healthy ATR on
 * the instruments in `constants/symbols.ts` is a small fraction of a percent.
 *
 * So a value above the bound is rejected to a FLAT-LINE projection (wick = 0):
 * the arc still renders and still terminates exactly on `target_price`, we just
 * decline to draw an uncertainty envelope we cannot trust. That is the same
 * "never fabricate geometry" rule the rest of the render path follows.
 *
 * NOTE: this is CLIENT-SIDE CONTAINMENT. If the live wire really is sending
 * pips, the correct fix is to normalise it in the engine, not here. This guard
 * exists so a bad payload degrades to a flat projection instead of a broken
 * chart while that is diagnosed.
 */

/**
 * Largest ATR we will honour, as a fraction of the anchor price. 2% is far above
 * any healthy short-horizon ATR and far below the 50% that produces a
 * ceiling-reaching spike.
 */
export const MAX_ATR_FRACTION_OF_PRICE = 0.02;

/**
 * Largest distance a target may sit from the anchor, as a fraction of the
 * anchor. 20% is far wider than any plausible intraday target and far narrower
 * than the runaway values that used to render as clipped vertical spikes.
 */
export const MAX_TARGET_DEVIATION_FRACTION = 0.2;

/**
 * Reject a target price that cannot belong to this anchor.
 *
 * The projection series shares the candles' price scale but is excluded from
 * autoscale, so an out-of-band target is not "out of range" — it is drawn and
 * CLIPPED at the edge of the chart container. That is the reported
 * spike-to-the-top corruption, and because autoscale never sees the target,
 * no autoscale-based check can catch it.
 *
 * Returning 0 means "no target", which suppresses the projection rather than
 * drawing a corrupt one. The trajectory is dropped; the live tape is untouched.
 *
 * @param target   Candidate target price from the engine/props.
 * @param anchor   The anchor the projection grows from.
 */
export function clampTargetToAnchor(target: unknown, anchor: unknown): number {
  const t = typeof target === "number" ? target : Number(target);
  if (!Number.isFinite(t) || t <= 0) return 0;

  const a = typeof anchor === "number" ? anchor : Number(anchor);
  // No anchor means we cannot judge the target. Refuse rather than guess.
  if (!Number.isFinite(a) || a <= 0) return 0;

  const bound = Math.abs(a) * MAX_TARGET_DEVIATION_FRACTION;
  if (Math.abs(t - a) > bound) return 0;

  return t;
}

/**
 * Returns a price-unit ATR that is safe to hand to the projector, or 0 to mean
 * "draw a flat line".
 *
 * @param atr         ATR as received (assumed price units; validated, not assumed)
 * @param referencePrice A price level to validate against — normally the live
 *                       close or the anchor. Supplying it is what makes the check
 *                       possible; without it we return 0 rather than trust the
 *                       value, because an unvalidatable envelope is exactly the
 *                       thing that produced the bug.
 */
export function normalizeProjectionAtr(
  atr: unknown,
  referencePrice: unknown,
): number {
  const value = typeof atr === "number" ? atr : Number(atr);
  if (!Number.isFinite(value) || value <= 0) return 0;

  const reference =
    typeof referencePrice === "number" ? referencePrice : Number(referencePrice);
  if (!Number.isFinite(reference) || reference <= 0) return 0;

  const bound = Math.abs(reference) * MAX_ATR_FRACTION_OF_PRICE;
  // Out of scale (pips / percent / a different field). Reject to a flat line.
  if (value > bound) return 0;

  return value;
}
