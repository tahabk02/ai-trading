import React from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceMarkerOverlay } from "@/components/trading/price-marker-overlay";
import type { PriceMarkerSet } from "@/lib/priceMarkerOverlay";
import { ui } from "@/test/harness";

function overlayFixture(
  patch: Partial<PriceMarkerSet> = {},
): PriceMarkerSet {
  return {
    markers: [
      {
        id: "depart",
        price: 1.0842,
        y: 120,
        text: "DEPART | 1.08420",
        tone: "depart",
        dashed: true,
      },
      {
        id: "entry",
        price: 1.085,
        y: 160,
        text: "ENTRY | 1.08500",
        tone: "neutral",
      },
      {
        id: "live",
        price: 1.09,
        y: 90,
        text: "LIVE | 1.09000",
        tone: "win",
      },
    ],
    window: {
      x0: 40,
      x1: 240,
      tone: "win",
      countdownSec: 125,
      countdownLabel: "02:05",
    },
    ...patch,
  };
}

describe("PriceMarkerOverlay", () => {
  it("renders the DEPART badge as a dashed cyan marker pinned to its y", () => {
    ui(<PriceMarkerOverlay {...overlayFixture()} />);
    const depart = screen.getByTestId("price-marker-depart");
    expect(depart).toHaveTextContent("DEPART | 1.08420");
    expect(depart).toHaveAttribute("data-tone", "depart");
    expect(depart).toHaveAttribute("data-dashed", "true");
    expect(depart).toHaveAttribute("data-y", "120");
    // Left-anchored so it never collides with the right-side LIVE/ENTRY badges.
    expect(depart.style.left).toBe("8px");
    expect(depart.style.borderStyle).toBe("dashed");
  });

  it("renders ENTRY and LIVE badges right-anchored with their tones", () => {
    ui(<PriceMarkerOverlay {...overlayFixture()} />);
    const entry = screen.getByTestId("price-marker-entry");
    const live = screen.getByTestId("price-marker-live");
    expect(entry).toHaveTextContent("ENTRY | 1.08500");
    expect(entry).toHaveAttribute("data-tone", "neutral");
    expect(live).toHaveTextContent("LIVE | 1.09000");
    expect(live).toHaveAttribute("data-tone", "win");
    expect(live.style.right).toBe("8px");
    expect(live.style.borderStyle).toBe("solid");
  });

  it("shades the trade window across entry→expiry with a live countdown", () => {
    ui(<PriceMarkerOverlay {...overlayFixture()} />);
    const win = screen.getByTestId("trade-window");
    expect(win).toHaveAttribute("data-x0", "40");
    expect(win).toHaveAttribute("data-x1", "240");
    expect(win).toHaveAttribute("data-tone", "win");
    expect(win.style.left).toBe("40px");
    expect(win.style.width).toBe("200px");
    expect(screen.getByTestId("trade-window-countdown")).toHaveTextContent(
      "02:05",
    );
  });

  it("renders no window when the trade is settled", () => {
    ui(<PriceMarkerOverlay {...overlayFixture({ window: null })} />);
    expect(screen.queryByTestId("trade-window")).toBeNull();
    expect(screen.queryByTestId("price-marker-live")).toBeInTheDocument();
  });

  it("renders nothing but the empty layer when there are no markers", () => {
    ui(<PriceMarkerOverlay markers={[]} window={null} />);
    expect(screen.getByTestId("price-marker-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("price-marker-depart")).toBeNull();
    expect(screen.queryByTestId("trade-window")).toBeNull();
  });
});
