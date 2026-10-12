import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BookAgreementDepthNote } from "@/components/shared/book-agreement-depth-note";
import {
  orderBookDepthState,
  isOrderBookVerified,
  type BookConfluenceLike,
} from "@/lib/bookAgreementDepth";
import { translations, supportedLangs } from "@/utils/i18n";

/**
 * PART 35.3 [359][360][361].
 *
 * The bug this pins: a strategy-book-agreement score was labelled "BOOK
 * AGREEMENT" beside a real order-book panel, so a reader could take it as
 * order-book evidence. On an OTC feed there is NO exchange depth, the
 * order-book factor is excluded from the confluence entirely, and the number
 * is pure strategy-book agreement. The UI must now say which case it is in.
 *
 * The load-bearing assertion is the NEGATIVE one: when depth was not used we
 * must not print the confirmation chip, and when it was we must not print the
 * L1 caveat. A component that always rendered both would pass a positive-only
 * test, so both directions are asserted.
 */

const UNVERIFIED = { confluence: { order_book_verified: false, verified_lift: 0 } };
const VERIFIED = { confluence: { order_book_verified: true, verified_lift: 0.31 } };

/** The exact shape the live API returned during PART 35.2 verification. */
const LIVE_NO_DEPTH_PAYLOAD: BookConfluenceLike = {
  book_confirm: 0.926,
  agreement: 1,
  magnitude: 0.8943,
  active_count: 6,
  aligned_count: 6,
  factors: {
    bollinger_bands: 1,
    atr_volatility: 1,
    donchian_breakout: 1,
    order_book_depth: 0,
  },
  detail: { book_depth: { bid_depth: null, ask_depth: null, factor: 0 } },
  confluence: { order_book_verified: false, verified_lift: 0, score: 98.6 },
};

describe("orderBookDepthState (pure)", () => {
  it("prefers the engine's authoritative flag", () => {
    expect(orderBookDepthState(VERIFIED)).toBe("verified");
    expect(orderBookDepthState(UNVERIFIED)).toBe("unverified");
  });

  it("reads the live no-depth payload as UNVERIFIED — depth added nothing", () => {
    expect(orderBookDepthState(LIVE_NO_DEPTH_PAYLOAD)).toBe("unverified");
    expect(isOrderBookVerified(LIVE_NO_DEPTH_PAYLOAD)).toBe(false);
  });

  it("falls back to the factor when the flag is absent", () => {
    expect(orderBookDepthState({ factors: { order_book_depth: 0 } })).toBe(
      "unverified",
    );
    expect(orderBookDepthState({ factors: { order_book_depth: 0.8 } })).toBe(
      "verified",
    );
  });

  it("says UNKNOWN rather than guessing when the payload proves nothing", () => {
    expect(orderBookDepthState(null)).toBe("unknown");
    expect(orderBookDepthState(undefined)).toBe("unknown");
    expect(orderBookDepthState({})).toBe("unknown");
    expect(orderBookDepthState({ factors: {} })).toBe("unknown");
    expect(
      orderBookDepthState({ confluence: { order_book_verified: null } }),
    ).toBe("unknown");
    // A non-finite factor must not be read as "verified".
    expect(
      orderBookDepthState({ factors: { order_book_depth: Number.NaN } }),
    ).toBe("unknown");
  });

  it("does not treat a zero factor as verified", () => {
    // The regression that motivated [359]: 0 means "did not contribute".
    expect(isOrderBookVerified({ factors: { order_book_depth: 0 } })).toBe(false);
  });
});

describe("BookAgreementDepthNote — both states", () => {
  afterEach(() => cleanup());

  it("shows the L1 caveat and NOT the confirmation when depth was unused", () => {
    render(<BookAgreementDepthNote bookConfluence={LIVE_NO_DEPTH_PAYLOAD} />);
    expect(screen.getByTestId("book-depth-unverified")).toHaveTextContent(
      /L1 quote only/i,
    );
    expect(screen.getByTestId("book-depth-unverified")).toHaveTextContent(
      /no order-book depth in this score/i,
    );
    expect(screen.queryByTestId("book-depth-verified")).toBeNull();
  });

  it("shows the confirmation and NOT the L1 caveat when depth was used", () => {
    render(<BookAgreementDepthNote bookConfluence={VERIFIED} />);
    expect(screen.getByTestId("book-depth-verified")).toHaveTextContent(
      /order-book confirmed/i,
    );
    expect(screen.queryByTestId("book-depth-unverified")).toBeNull();
  });

  it("renders nothing when the flag is unknown — claims neither way", () => {
    const { container } = render(
      <BookAgreementDepthNote bookConfluence={{}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no confluence payload at all", () => {
    const { container } = render(<BookAgreementDepthNote />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("i18n coverage for the renamed label + depth keys", () => {
  const LABEL_KEYS = [
    "signalConfidence",
    "aiConfidence",
    "confidence",
    "highConfidenceTitle",
  ];
  const DEPTH_KEYS = ["bookDepthUnverifiedNote", "bookDepthVerifiedChip"];

  it.each(supportedLangs)("%s defines every depth key", (lang) => {
    for (const key of DEPTH_KEYS) {
      expect(translations[lang][key], `${lang}.${key}`).toBeTruthy();
    }
  });

  it.each(supportedLangs)("%s renames the label away from bare 'Book Agreement'", (lang) => {
    for (const key of LABEL_KEYS) {
      const value = translations[lang][key] ?? "";
      // "Strategy Book Agreement" and its equivalents are fine; a bare
      // "Book Agreement" is the ambiguity this change removes.
      expect(value, `${lang}.${key}`).not.toBe("Book Agreement");
      expect(value, `${lang}.${key}`).not.toBe("BOOK AGREEMENT");
    }
  });

  it("English names strategy books explicitly", () => {
    expect(translations.en.signalConfidence).toBe("Strategy Book Agreement");
    expect(translations.en.aiConfidence).toBe("Strategy Book Agreement");
    expect(translations.en.highConfidenceTitle).toContain("STRATEGY BOOK AGREEMENT");
    expect(translations.en.bookDepthUnverifiedNote).toBe(
      "L1 quote only — no order-book depth in this score",
    );
  });
});