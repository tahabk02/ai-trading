/**
 * terminalLightMode.test.ts — LIGHT-MODE + PRESS-FEEDBACK CONTRACT for the
 * Market Terminal control surface (Alpha.5 Pro, 2026-09-30).
 *
 * Two classes of bug this prevents, both of which shipped before this file
 * existed:
 *
 * 1. **Stock Tailwind accents are literal hex.** `text-amber-400`, `text-teal-300`
 *    etc. compile to fixed values in CSS and do NOT follow the `html.light`
 *    class, so they render at 1.48-2.57:1 on a white panel — effectively
 *    invisible in light mode. The design system already provides theme-driven
 *    `st-*` status channels for exactly this, and `globals.css` documents that
 *    the terminal must use them. This suite pins that.
 *
 * 2. **`transition-colors` cannot animate `scale`.** A button styled with
 *    `transition-colors` and no `active:` variant gives the trader NO press
 *    feedback, which reads as input lag even when the JS work is trivial. A
 *    second, subtler trap is `transition-all duration-200 active:scale-*`: the
 *    press response is an eased 200ms tween, so at 60ms after mousedown the
 *    button has barely moved. This suite pins a fast press response.
 *
 * These are static class-string assertions: cheap, deterministic, and they fail
 * the build rather than shipping a regression to production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/**
 * Stock Tailwind accent shades that compile to LITERAL hex and therefore do not
 * follow the theme. `amber-500`/`teal-500` in a `bg-`/`border-` slot are fine —
 * they are saturated fills carrying inverted ink — so only TEXT is policed.
 */
const LITERAL_TEXT_ACCENTS = [
  "text-amber-300",
  "text-amber-400",
  "text-emerald-300",
  "text-emerald-400",
  "text-rose-300",
  "text-rose-400",
  "text-teal-300",
  "text-teal-400",
  "text-sky-400",
  "text-violet-300",
  "text-sky-300",
];

/** Every interactive control in the terminal header surface. */
const INTERACTIVE_CONTROLS = [
  "components/terminal/tier-selector.tsx",
  "components/terminal/horizon-selector.tsx",
  "components/terminal/confidence-filter.tsx",
  "components/terminal/asset-class-filter.tsx",
];

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("terminal controls use theme-driven status hues, not literal accents", () => {
  it.each(INTERACTIVE_CONTROLS)("%s has no literal text accents", (rel) => {
    const src = read(rel);
    const offenders = LITERAL_TEXT_ACCENTS.filter((cls) =>
      new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(src),
    );
    expect(
      offenders,
      `${rel} uses literal accent text ${offenders.join(", ")}. These do not ` +
        `follow html.light and fail contrast on a white panel — use the ` +
        `theme-driven st-* channels instead.`,
    ).toEqual([]);
  });

  it("the amber confidence chip routes through the st-warn channel", () => {
    const src = read("components/terminal/confidence-filter.tsx");
    expect(src).toMatch(/text-st-warn/);
  });

  it("the teal tier chip routes through the st-teal channel", () => {
    const src = read("components/terminal/tier-selector.tsx");
    expect(src).toMatch(/text-st-teal/);
  });
});

describe("every terminal button gives instant press feedback", () => {
  it.each(INTERACTIVE_CONTROLS)("%s declares an active: press state", (rel) => {
    const src = read(rel);
    expect(
      /active:(scale|translate|opacity|brightness|ring)/.test(src),
      `${rel} has no \`active:\` variant. \`transition-colors\` alone gives no ` +
        `transform feedback, so the button appears unresponsive on press.`,
    ).toBe(true);
  });

  it.each(INTERACTIVE_CONTROLS)("%s uses a fast press transition", (rel) => {
    const src = read(rel);
    // A `duration-200`/`duration-300` tween is what makes an `active:scale-95`
    // read as lag. Flag the slow ones explicitly.
    expect(
      /duration-(200|300|500|700|1000)\b/.test(src),
      `${rel} uses a slow transition duration on a press animation. Keep press ` +
        `feedback at or below ~100ms or it reads as click latency.`,
    ).toBe(false);
  });
});

describe("store setters keep localStorage out of the Zustand updater", () => {
  const store = read("store/useMarketTerminalStore.ts");

  it("does not call a persist helper inside a set() updater", () => {
    // Zustand updaters must be pure: React StrictMode double-invokes them, so a
    // write inside the updater fires twice per change.
    const updaterWithWrite = /set\(\(\)\s*=>\s*\{[^}]*persist\w*\(/;
    expect(
      updaterWithWrite.test(store),
      "a localStorage write was found inside a set() updater — move it before set()",
    ).toBe(false);
  });

  it("still persists the tier and confidence selections", () => {
    // The optimization above must not silently drop persistence.
    expect(store).toMatch(/persistMinConfidencePct\(/);
    expect(store).toMatch(/persistTierSelection\(/);
  });
});
