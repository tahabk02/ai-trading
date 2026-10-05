/**
 * PART 35.3 [359][360] — resolve whether a strategy-book-agreement score
 * actually consumed real order-book depth.
 *
 * The `book_agreement` number is a confluence score across the ten strategy
 * books (classical technical-analysis instruments) on one tape. Order-book
 * depth is ONE of those inputs, and it is conditional:
 *
 *   - when a genuine one-sided book is present the engine sets
 *     `order_book_verified: true` and applies `verified_lift`;
 *   - when it is not, the order-book factor is EXCLUDED from both the
 *     numerator and the denominator, `order_book_verified` is false and
 *     `verified_lift` is 0 — the score is then pure strategy-book confluence.
 *
 * Because the label "Book Agreement" is ambiguous next to a real order-book
 * panel, the UI must state which case it is in rather than let the reader
 * assume order-book evidence.
 */

export type OrderBookDepthState = "verified" | "unverified" | "unknown";

/**
 * The slice of `PredictionResponse["book_confluence"]` this module reads.
 * Declared structurally (rather than importing the API type) so the resolver
 * stays unit-testable without the service layer; keep it in sync with
 * `services/api.ts`.
 */
export interface BookConfluenceLike {
  book_confirm?: number | null;
  agreement?: number | null;
  magnitude?: number | null;
  active_count?: number | null;
  aligned_count?: number | null;
  factors?: Record<string, number> | null;
  detail?: Record<string, unknown> | null;
  confluence?: {
    order_book_verified?: boolean | null;
    verified_lift?: number | null;
    score?: number | null;
  } | null;
}

/**
 * Resolve the depth state, preferring the engine's authoritative flag.
 *
 * `unknown` is returned when the payload carries neither the flag nor a
 * readable `order_book_depth` factor — the UI must then stay silent rather
 * than claim either "depth confirmed" or "no depth".
 */
export function orderBookDepthState(
  bookConfluence: BookConfluenceLike | null | undefined,
): OrderBookDepthState {
  if (!bookConfluence) return "unknown";

  const verified = bookConfluence.confluence?.order_book_verified;
  if (typeof verified === "boolean") {
    return verified ? "verified" : "unverified";
  }

  // Older/partial payloads may omit the flag but still carry the factor.
  // A zero factor means the order-book input did not contribute.
  const factor = bookConfluence.factors?.order_book_depth;
  if (typeof factor === "number" && Number.isFinite(factor)) {
    return factor > 0 ? "verified" : "unverified";
  }

  return "unknown";
}

/** True only when order-book depth demonstrably contributed to the score. */
export function isOrderBookVerified(
  bookConfluence: BookConfluenceLike | null | undefined,
): boolean {
  return orderBookDepthState(bookConfluence) === "verified";
}