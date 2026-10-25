/**
 * predictive-microstructure.dom.test.tsx
 *
 * The additive predictive panel must render engine-supplied evidence only and
 * must stay completely absent when the engine reports unavailability. These
 * tests pin the visible contract (regime, sweep, ensemble weights, suppression)
 * so the terminal can never present a client-invented microstructure number.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PredictiveMicrostructure } from "@/components/trading/predictive-microstructure";
import type { PredictiveLayer } from "@/services/api";

afterEach(cleanup);

const PAYLOAD: PredictiveLayer = {
  available: true,
  layer: "predictive_microstructure_v1",
  symbol: "EUR/USD",
  microstructure: {
    available: true,
    velocity: {
      available: true,
      velocity: 0.00012,
      acceleration: 0.44,
      units: "per_second",
    },
    sri: 0.32,
    low_volatility: false,
    suppressed: false,
    suppression_reasons: [],
    liquidity: {
      available: true,
      last_sweep: "high",
      sweep_high: true,
      sweep_strength: 0.4,
      pools: [
        {
          price: 1.0867,
          side: "high",
          distance_atr: 0.32,
          touches: 3,
          swept: false,
        },
      ],
    },
  },
  regime: {
    available: true,
    asset_class: "OTC",
    regime: "trend",
    directional_bias: 0.61,
    session: { session: "london_newyork_overlap", liquidity_multiplier: 1.3 },
    suppression: { active: false, reasons: [] },
  },
  ensemble: {
    available: true,
    threshold: 85,
    confidence: 88.4,
    expected_precision: 0.71,
    release: true,
    suppressed: false,
    suppression_reasons: [],
    components: {
      momentum: { score: 0.8, weight: 0.28 },
      microstructure: { score: 0.4, weight: 0.24 },
      order_flow: { score: 0.5, weight: 0.2 },
      volatility: { score: 0.2, weight: 0.14 },
      regime: { score: 0.6, weight: 0.14 },
    },
  },
  authority: { thermal_gate_unchanged: true, threshold: 85 },
};

describe("PredictiveMicrostructure", () => {
  it("renders nothing when the engine did not supply the layer", () => {
    const { container } = render(<PredictiveMicrostructure predictive={null} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("predictive-microstructure")).toBeNull();
  });

  it("renders nothing when the layer is explicitly unavailable", () => {
    render(
      <PredictiveMicrostructure
        predictive={{ available: false, reason: "diagnostics_failed" }}
      />,
    );
    expect(screen.queryByTestId("predictive-microstructure")).toBeNull();
  });

  it("renders regime, sweep and ensemble evidence from the payload", () => {
    render(<PredictiveMicrostructure predictive={PAYLOAD} />);

    expect(screen.getByTestId("predictive-microstructure")).toBeTruthy();
    expect(screen.getByTestId("predictive-regime").textContent).toContain(
      "TREND",
    );
    expect(screen.getByTestId("predictive-sweep").textContent).toContain(
      "SWEEP HIGH",
    );
    expect(screen.getByTestId("predictive-release").textContent).toContain(
      "RELEASE",
    );
    expect(screen.getByText("88.4%")).toBeTruthy();
    expect(screen.getByText("MOMENTUM")).toBeTruthy();
    expect(screen.getByText("1.08670")).toBeTruthy();
  });

  it("names suppression reasons instead of hiding them", () => {
    render(
      <PredictiveMicrostructure
        predictive={{
          ...PAYLOAD,
          microstructure: {
            ...PAYLOAD.microstructure,
            suppressed: true,
            suppression_reasons: ["volume_absorption"],
          },
          ensemble: {
            ...PAYLOAD.ensemble,
            release: false,
            suppressed: true,
            suppression_reasons: ["volume_absorption"],
          },
        }}
      />,
    );
    const suppression = screen.getByTestId("predictive-suppression");
    expect(suppression.textContent).toContain("VOLUME ABSORPTION");
    expect(suppression.textContent).toContain("LONDON NEWYORK OVERLAP");
    expect(screen.getByTestId("predictive-release").textContent).toContain(
      "ABSTAIN",
    );
  });

  it("does not invent regimes, sweeps or thresholds for unavailable fields", () => {
    render(
      <PredictiveMicrostructure
        predictive={{
          available: true,
          microstructure: {
            available: true,
            suppressed: false,
            suppression_reasons: [],
          },
        }}
      />,
    );

    expect(screen.getByTestId("predictive-regime").textContent).toBe("--");
    expect(screen.getByTestId("predictive-release").textContent).toBe("N/A");
    expect(screen.getByTestId("predictive-sweep").textContent).toBe(
      "UNAVAILABLE",
    );
    expect(screen.queryByText("RANGE")).toBeNull();
    expect(screen.queryByText("NO SWEEP")).toBeNull();
    expect(screen.queryByText(/TH 85%/)).toBeNull();
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBeNull();
    expect(meter.getAttribute("aria-valuetext")).toBe("unavailable");
  });

  it("does not show a release badge when the ensemble abstains", () => {
    render(
      <PredictiveMicrostructure
        predictive={{
          ...PAYLOAD,
          ensemble: {
            ...PAYLOAD.ensemble,
            release: false,
            suppressed: false,
            suppression_reasons: [],
            confidence: 62.1,
          },
          microstructure: {
            ...PAYLOAD.microstructure,
            suppressed: false,
            suppression_reasons: [],
          },
        }}
      />,
    );
    expect(screen.getByTestId("predictive-release").textContent).toContain(
      "ABSTAIN",
    );
  });
});
