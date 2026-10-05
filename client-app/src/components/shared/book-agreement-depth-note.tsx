"use client";

import React from "react";
import { cn } from "@/utils/cn";
import { useLangContext } from "@/hooks/useLangContext";
import {
  orderBookDepthState,
  type BookConfluenceLike,
} from "@/lib/bookAgreementDepth";

interface BookAgreementDepthNoteProps {
  /** The `book_confluence` slice carrying the engine's depth flag. */
  bookConfluence?: BookConfluenceLike | null;
  size?: "xs" | "sm";
  className?: string;
}

/**
 * PART 35.3 [359][360] — states, in the open, whether the displayed
 * strategy-book-agreement score actually used order-book depth.
 *
 * - depth contributed  -> a positive "+ order-book confirmed" chip.
 * - depth NOT used     -> a visible "L1 quote only" note, so the number is
 *                         never read as order-book evidence.
 * - flag absent        -> renders nothing (we will not guess either way).
 *
 * Deliberately inline text rather than a tooltip: PART 19.2's precedent is
 * that a caveat hidden behind hover does not count as disclosed.
 */
export const BookAgreementDepthNote: React.FC<
  BookAgreementDepthNoteProps
> = ({ bookConfluence, size = "xs", className }) => {
  const { t } = useLangContext();
  const state = orderBookDepthState(bookConfluence);

  if (state === "unknown") return null;

  const text =
    size === "sm" ? "text-[10px]" : "text-[9px]";

  if (state === "verified") {
    return (
      <span
        data-testid="book-depth-verified"
        className={cn(
          "inline-flex items-center gap-1 rounded-full border font-semibold uppercase tracking-wider",
          "bg-st-pos/15 text-st-pos border-st-pos/40",
          text,
          className,
        )}
      >
        {t("bookDepthVerifiedChip")}
      </span>
    );
  }

  return (
    <span
      data-testid="book-depth-unverified"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-semibold",
        "bg-st-caution/15 text-st-caution border-st-caution/40",
        text,
        className,
      )}
    >
      {t("bookDepthUnverifiedNote")}
    </span>
  );
};