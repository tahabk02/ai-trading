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

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function signed(value: unknown, digits = 2): string {
  const num = finite(value);
  return `${num >= 0 ? "+" : ""}${num.toFixed(digits)}`;
}

function humanize(reason: string): string {
  return reason.replace(/_/g, " ").toUpperCase();
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

  const momentumScore = finite(ensemble?.components?.momentum?.score);
  const velocity = micro?.velocity;
  const acceleration = finite(velocity?.acceleration);
  const confidence = finite(ensemble?.confidence);
  const threshold = finite(ensemble?.threshold, 85);
  const sweep = micro?.liquidity?.last_sweep ?? "none";
  const pools = micro?.liquidity?.pools?.slice(0, 4) ?? [];
  const session = regime?.session?.session;
  const assetClass = regime?.asset_class;
  const regimeName = String(regime?.regime ?? "range");
  const suppressionReasons = Array.from(
    new Set([
      ...(micro?.suppression_reasons ?? []),
      ...(ensemble?.suppression_reasons ?? []),
    ]),
  );
  const suppressed =
    ensemble?.suppressed === true ||
    micro?.suppressed === true ||
    suppressionReasons.length > 0;

  const components = Object.entries(ensemble?.components ?? {});
  const release = ensemble?.release === true && !suppressed;

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
            {REGIME_LABELS[regimeName] ?? regimeName.toUpperCase()}
          </span>
          <span
            data-testid="predictive-release"
            className={
              "px-1.5 py-0.5 rounded border text-[9px] font-mono font-black " +
              (release
                ? "bg-st-pos/15 text-st-pos border-st-pos/30"
                : "bg-st-warn/15 text-st-warn border-st-warn/30")
            }
          >
            {release ? "RELEASE" : "ABSTAIN"}
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
            aria-valuenow={Math.round(gaugePercent(momentumScore))}
            className="relative h-2 rounded-full bg-elevated overflow-hidden"
          >
            <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
            <div
              className={
                "absolute inset-y-0 rounded-full " +
                (momentumScore >= 0 ? "bg-st-pos" : "bg-st-neg")
              }
              style={{ width: `${gaugePercent(momentumScore)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[10px] font-mono">
            <span className="text-ink font-bold">
              {velocity?.available ? signed(velocity.velocity) : "--"}
            </span>
            <span
              className={
                acceleration >= 0 ? "text-st-pos" : "text-st-neg"
              }
            >
              ACC {signed(acceleration)}
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
              {sweep === "high"
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
              pools.map((pool) => (
                <div
                  key={`${pool.side}-${pool.price}`}
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
                    {pool.price != null ? pool.price.toFixed(5) : "--"}
                  </span>
                  <span className="text-ink-faint">
                    {pool.distance_atr != null
                      ? pool.distance_atr.toFixed(2) + " ATR"
                      : "--"}
                  </span>
                  <span
                    className={
                      pool.swept ? "text-ink-faint" : "text-st-warn"
                    }
                  >
                    {pool.swept ? "SWEPT" : pool.touches + "x"}
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
              TH {threshold.toFixed(0)}%
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono mb-1.5">
            <span className="text-ink font-bold">
              {ensemble?.available ? confidence.toFixed(1) + "%" : "--"}
            </span>
            <span className="text-ink-faint">
              precis{" "}
              {ensemble?.expected_precision != null
                ? (finite(ensemble.expected_precision) * 100).toFixed(0) + "%"
                : "--"}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-elevated overflow-hidden mb-2">
            <div
              className={
                "h-full rounded-full " +
                (release ? "bg-st-pos" : "bg-st-warn")
              }
              style={{ width: `${clamp(confidence, 0, 100)}%` }}
            />
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
