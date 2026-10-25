"use client";

import React from "react";
import type { PredictiveLayer } from "@/services/api";

const COMPONENT_LABELS: Record<string, string> = {
  momentum: "MOMENTUM",
  microstructure: "MICRO",
  order_flow: "FLOW",
  volatility: "VOL",
  regime: "REGIME",
};

const REGIME_LABELS: Record<string, string> = {
  trend: "TREND",
  range: "RANGE",
  reversal: "REVERSAL",
  expansion: "EXPANSION",
  compression: "COMPRESSION",
};

function finite(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function hasFinite(value: unknown): boolean {
  return value != null && Number.isFinite(Number(value));
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function signed(value: unknown, digits = 2): string {
  const num = finite(value);
  return `${num >= 0 ? "+" : ""}${num.toFixed(digits)}`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function humanize(reason: unknown): string {
  return String(reason).replace(/_/g, " ").toUpperCase();
}

function gaugePercent(score: number): number {
  return clamp((clamp(score, -1, 1) + 1) * 50, 0, 100);
}

export interface PredictiveMicrostructureProps {
  predictive?: PredictiveLayer | null;
}

/**
 * Compact, honest rendering of the additive predictive layer.
 *
 * The panel renders NOTHING unless the engine supplied an available payload.
 * It never derives a confidence, a sweep or a regime on the client; every
 * number is the engine's, and unavailable inputs stay blank.
 */
export const PredictiveMicrostructure: React.FC<
  PredictiveMicrostructureProps
> = ({ predictive }) => {
  if (!predictive?.available) return null;

  const micro = predictive.microstructure;
  const regime = predictive.regime;
  const ensemble = predictive.ensemble;
  if (!micro && !regime && !ensemble) return null;

  const velocity = micro?.velocity;
  const velocityAvailable =
    velocity?.available === true && hasFinite(velocity.velocity);
  const accelerationAvailable =
    velocity?.available === true && hasFinite(velocity.acceleration);
  const momentumScore = finite(ensemble?.components?.momentum?.score);
  const momentumAvailable =
    ensemble?.available === true &&
    hasFinite(ensemble?.components?.momentum?.score);
  const confidence = finite(ensemble?.confidence);
  const confidenceAvailable =
    ensemble?.available === true && hasFinite(ensemble?.confidence);
  const threshold = finite(ensemble?.threshold, 85);
  const thresholdAvailable =
    ensemble?.available === true && hasFinite(ensemble?.threshold);
  const liquidityAvailable = micro?.liquidity?.available === true;
  const sweep = liquidityAvailable
    ? micro?.liquidity?.last_sweep ?? "none"
    : null;
  const pools = liquidityAvailable
    ? (micro?.liquidity?.pools ?? []).slice(0, 4)
    : [];
  const regimeAvailable =
    regime?.available === true &&
    typeof regime.regime === "string" &&
    regime.regime.length > 0;
  const session = regimeAvailable ? regime?.session?.session : undefined;
  const assetClass = regimeAvailable ? regime?.asset_class : undefined;
  const regimeName = regimeAvailable ? String(regime?.regime) : null;
  const suppressionReasons = Array.from(
    new Set([
      ...asStringArray(micro?.suppression_reasons),
      ...asStringArray(ensemble?.suppression_reasons),
    ]),
  );
  const suppressed =
    ensemble?.suppressed === true ||
    micro?.suppressed === true ||
    suppressionReasons.length > 0;

  const components =
    ensemble?.available === true &&
    ensemble.components != null &&
    typeof ensemble.components === "object"
      ? Object.entries(ensemble.components)
      : [];
  const release =
    ensemble?.available === true &&
    ensemble.release === true &&
    !suppressed;

  return (
    <section
      data-testid="predictive-microstructure"
      className="mt-3 bg-well border border-line rounded-card p-3 transition-colors duration-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
          <h4 className="text-[10px] text-ink uppercase tracking-wider font-black">
            Micro-structure engine
          </h4>
        </div>
        <div className="flex items-center gap-1.5">
          {assetClass && (
            <span className="px-1.5 py-0.5 rounded border border-line-strong bg-surface text-[9px] font-mono font-bold text-ink-muted">
              {assetClass}
            </span>
          )}
          <span
            data-testid="predictive-regime"
            className="px-1.5 py-0.5 rounded border border-line-strong bg-surface text-[9px] font-mono font-bold text-ink"
          >
            {regimeName
              ? REGIME_LABELS[regimeName] ?? regimeName.toUpperCase()
              : "--"}
          </span>
          <span
            data-testid="predictive-release"
            className={
              "px-1.5 py-0.5 rounded border text-[9px] font-mono font-black " +
              (release
                ? "bg-st-pos/15 text-st-pos border-st-pos/30"
                : ensemble?.available === true
                  ? "bg-st-warn/15 text-st-warn border-st-warn/30"
                  : "bg-elevated text-ink-faint border-line-strong")
            }
          >
            {ensemble?.available === true
              ? release
                ? "RELEASE"
                : "ABSTAIN"
              : "N/A"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="bg-surface border border-line rounded-card p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[9px] text-ink-faint uppercase font-black">
              Velocity
            </span>
            <span className="text-[9px] font-mono text-ink-muted">
              {velocity?.units === "per_second" ? "px/s" : "px/tick"}
            </span>
          </div>
          <div
            role="meter"
            aria-label="momentum velocity score"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              momentumAvailable
                ? Math.round(gaugePercent(momentumScore))
                : undefined
            }
            aria-valuetext={momentumAvailable ? undefined : "unavailable"}
            className="relative h-2 rounded-full bg-elevated overflow-hidden"
          >
            <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
            {momentumAvailable && (
              <div
                className={
                  "absolute inset-y-0 rounded-full " +
                  (momentumScore >= 0 ? "bg-st-pos" : "bg-st-neg")
                }
                style={{ width: `${gaugePercent(momentumScore)}%` }}
              />
            )}
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[10px] font-mono">
            <span className="text-ink font-bold">
              {velocityAvailable ? signed(velocity.velocity) : "--"}
            </span>
            <span
              className={
                accelerationAvailable
                  ? finite(velocity?.acceleration) >= 0
                    ? "text-st-pos"
                    : "text-st-neg"
                  : "text-ink-faint"
              }
            >
              ACC{" "}
              {accelerationAvailable ? signed(velocity?.acceleration) : "--"}
            </span>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-card p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[9px] text-ink-faint uppercase font-black">
              Liquidity pools
            </span>
            <span
              data-testid="predictive-sweep"
              className={
                "px-1 py-0.5 rounded text-[8px] font-mono font-black " +
                (sweep === "high"
                  ? "bg-st-neg/15 text-st-neg"
                  : sweep === "low"
                    ? "bg-st-pos/15 text-st-pos"
                    : "bg-elevated text-ink-faint")
              }
            >
              {!liquidityAvailable
                ? "UNAVAILABLE"
                : sweep === "high"
                  ? "SWEEP HIGH"
                  : sweep === "low"
                    ? "SWEEP LOW"
                    : "NO SWEEP"}
            </span>
          </div>
          <div className="space-y-1">
            {pools.length === 0 ? (
              <p className="text-[10px] font-mono text-ink-faint">--</p>
            ) : (
              pools.map((pool, index) => (
                <div
                  key={`${pool.side}-${pool.price ?? "na"}-${index}`}
                  className="flex items-center justify-between gap-2 text-[10px] font-mono"
                >
                  <span
                    className={
                      pool.side === "high" ? "text-st-neg" : "text-st-pos"
                    }
                  >
                    {pool.side === "high" ? "H" : "L"}
                  </span>
                  <span className="text-ink flex-1 truncate">
                    {hasFinite(pool.price)
                      ? finite(pool.price).toFixed(5)
                      : "--"}
                  </span>
                  <span className="text-ink-faint">
                    {hasFinite(pool.distance_atr)
                      ? finite(pool.distance_atr).toFixed(2) + " ATR"
                      : "--"}
                  </span>
                  <span
                    className={
                      pool.swept ? "text-ink-faint" : "text-st-warn"
                    }
                  >
                    {pool.swept
                      ? "SWEPT"
                      : hasFinite(pool.touches)
                        ? finite(pool.touches) + "x"
                        : "--"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-surface border border-line rounded-card p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[9px] text-ink-faint uppercase font-black">
              Bayesian ensemble
            </span>
            <span className="text-[9px] font-mono text-ink-faint">
              TH {thresholdAvailable ? threshold.toFixed(0) + "%" : "--"}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono mb-1.5">
            <span className="text-ink font-bold">
              {confidenceAvailable ? confidence.toFixed(1) + "%" : "--"}
            </span>
            <span className="text-ink-faint">
              precis{" "}
              {ensemble?.available === true &&
              hasFinite(ensemble.expected_precision)
                ? (finite(ensemble.expected_precision) * 100).toFixed(0) + "%"
                : "--"}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-elevated overflow-hidden mb-2">
            {confidenceAvailable && (
              <div
                className={
                  "h-full rounded-full " +
                  (release ? "bg-st-pos" : "bg-st-warn")
                }
                style={{ width: `${clamp(confidence, 0, 100)}%` }}
              />
            )}
          </div>
          <div className="space-y-1">
            {components.length === 0 ? (
              <p className="text-[10px] font-mono text-ink-faint">--</p>
            ) : (
              components.map(([key, component]) => {
                const weight = clamp(finite(component.weight) * 100, 0, 100);
                const score = finite(component.score);
                return (
                  <div
                    key={key}
                    className="flex items-center gap-1.5 text-[9px] font-mono"
                  >
                    <span className="w-14 text-ink-faint truncate">
                      {COMPONENT_LABELS[key] ?? key.toUpperCase()}
                    </span>
                    <div className="flex-1 h-1 rounded-full bg-elevated overflow-hidden">
                      <div
                        className={
                          score >= 0 ? "h-full bg-st-pos" : "h-full bg-st-neg"
                        }
                        style={{ width: `${weight}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-ink-muted">
                      {weight.toFixed(0)}%
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {(session || suppressed) && (
        <div
          data-testid="predictive-suppression"
          className={
            "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border px-2.5 py-1.5 text-[9px] font-mono " +
            (suppressed
              ? "bg-st-warn/10 border-st-warn/30 text-st-warn"
              : "bg-surface border-line text-ink-muted")
          }
        >
          {session && (
            <span>
              SESSION {String(session).replace(/_/g, " ").toUpperCase()}
            </span>
          )}
          {suppressed && (
            <span>
              SUPPRESSED{" "}
              {suppressionReasons.length > 0
                ? suppressionReasons.map(humanize).join(" / ")
                : "BY RISK OVERLAY"}
            </span>
          )}
          {!suppressed && !release && ensemble?.available && (
            <span>
              ENSEMBLE BELOW {threshold.toFixed(0)}% - ANNOTATION ONLY
            </span>
          )}
        </div>
      )}
    </section>
  );
};

export default PredictiveMicrostructure;
