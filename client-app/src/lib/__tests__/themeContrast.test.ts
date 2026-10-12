/**
 * themeContrast.test.ts — LIGHT MODE TOKEN COMPLETENESS + WCAG CONTRAST.
 *
 * The light-mode bug: the eight `--term-*` tokens were declared ONLY in
 * `:root` (dark obsidian values) and were never overridden under `html.light`.
 * Because Tailwind resolves them via `rgb(var(--term-*) / <alpha-value>)`, the
 * browser had NO light value to fall back to, so `bg-term-panel` stayed
 * #0D101A and `text-term-ink` stayed #E8EDF6 on a #f8fafc page.
 *
 * These tests parse the actual stylesheet rather than trusting a comment, so a
 * future edit that deletes a light override fails the suite instead of
 * silently shipping unreadable UI.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getStoredTheme,
  resolveTheme,
  THEME_PREPAINT_SCRIPT,
  THEME_STORAGE_KEY,
} from "@/hooks/useTheme";

const CSS_PATH = join(process.cwd(), "src", "styles", "globals.css");
const css = readFileSync(CSS_PATH, "utf8");

/** Extract the body of a top-level `html.dark` / `html.light` block. */
function blockFor(selector: "html.light" | "html.dark"): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block must exist`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${selector} block`);
}

const lightBlock = blockFor("html.light");
const darkBlock = blockFor("html.dark");

/** Parse `--name: R G B;` triplets → { name: [r,g,b] }. */
function triplets(scope: string): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  const re = /--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Minimal recursive `**\/*.tsx` walker (avoids adding a glob dependency). */
function globFiles(root: string, ext = ".tsx"): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out = out.concat(globFiles(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

function parseHexColor(input: string): [number, number, number] {
  const m = input.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a 6-digit hex: ${input}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const ch = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The terminal families that MUST be redefined for light mode. */
const REQUIRED_LIGHT_TOKENS = [
  "term-canvas",
  "term-panel",
  "term-line",
  "term-ink",
  "term-ink-dim",
  "term-ink-faint",
  "term-gold",
  "term-crypto",
  // ── STATUS HUE CHANNELS (the Order Book / signal-card wash-out) ──
  "st-pos",
  "st-neg",
  "st-warn",
  "st-caution",
  "st-info",
  "st-teal",
] as const;

describe("light mode token completeness", () => {
  it.each(REQUIRED_LIGHT_TOKENS)("--%s is overridden under html.light", (token) => {
    // This is the exact assertion that catches the original bug: the token
    // existed in :root only, so the light theme silently inherited the dark
    // obsidian value.
    expect(lightBlock).toContain(`--${token}:`);
  });

  it("declares every required token as a valid RGB triplet", () => {
    const light = triplets(lightBlock);
    for (const token of REQUIRED_LIGHT_TOKENS) {
      expect(light[token], `--${token} must be an "R G B" triplet`).toBeDefined();
      for (const ch of light[token]) expect(ch).toBeGreaterThanOrEqual(0);
    }
  });

  it("light values actually DIFFER from the dark values (no copy-paste)", () => {
    // A verbatim copy of the dark block would pass the "is it defined" test
    // while reproducing the exact bug, so require a real inversion.
    const rootScope = css.slice(css.indexOf(":root {"), css.indexOf("html.dark {"));
    const dark = triplets(rootScope);
    const light = triplets(lightBlock);
    for (const token of [
      "term-panel",
      "term-ink",
      "term-ink-dim",
      "st-pos",
      "st-neg",
      "st-warn",
      "st-caution",
      "st-info",
      "st-teal",
    ] as const) {
      expect(hex(light[token])).not.toBe(hex(dark[token]));
    }
  });

  it("sets color-scheme for native form controls and scrollbars", () => {
    expect(lightBlock).toContain("color-scheme: light");
    expect(darkBlock).toContain("color-scheme: dark");
  });
});

describe("light mode WCAG contrast", () => {
  const light = triplets(lightBlock);
  const panel = light["term-panel"];
  const canvas = light["term-canvas"];

  const ratios: Array<[string, number]> = [
    ["term-ink on term-panel", contrastRatio(light["term-ink"], panel)],
    ["term-ink on term-canvas", contrastRatio(light["term-ink"], canvas)],
    ["term-ink-dim on term-panel", contrastRatio(light["term-ink-dim"], panel)],
    ["term-ink-faint on term-panel", contrastRatio(light["term-ink-faint"], panel)],
    ["term-gold on term-panel", contrastRatio(light["term-gold"], panel)],
    ["term-crypto on term-panel", contrastRatio(light["term-crypto"], panel)],
  ];

  it.each(ratios)("%s meets WCAG AA body text (>= 4.5:1)", (_label, ratio) => {
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("term-line is a visible hairline on both light surfaces (>= 1.4:1)", () => {
    // A 1px hairline's job is separation, not state. WCAG 1.4.11 wants 3:1 for
    // UI boundaries, but a full-strength border on every grid cell is visually
    // heavy in a dense blotter; we hold a floor that still rejects a line
    // color indistinguishable from the surface behind it.
    expect(contrastRatio(light["term-line"], panel)).toBeGreaterThanOrEqual(1.4);
  });

  it("the original dark gold/cyan would have FAILED on white (regression proof)", () => {
    // The pre-fix light block reused the dark channel colors, which are tuned
    // for a #06070B bed. Pin the failure so nobody re-introduces them.
    expect(contrastRatio(parseHexColor("#D8A048"), parseHexColor("#FFFFFF")))
      .toBeLessThan(4.5);
    expect(contrastRatio(parseHexColor("#00B3C9"), parseHexColor("#FFFFFF")))
      .toBeLessThan(4.5);
  });
});

/**
 * ── STATUS HUE CHANNELS ──
 * The second light-mode failure, independent of the `--term-*` leak above.
 * `--sl-*` and `--ob*` INVERT under `html.light`, so slate ink re-themes
 * itself for free. Tailwind's stock accents do NOT: `text-emerald-400`
 * compiles to a literal `#34D399` that resolves identically in both themes and
 * lands at 1.84:1 on a white panel. The Order Book ladder, the signal-card tier
 * colours and the LIVE dot were all built from those literals.
 */
describe("status hue channels survive light mode", () => {
  const light = triplets(lightBlock);
  const rootScope = css.slice(css.indexOf(":root {"), css.indexOf("html.dark {"));
  const dark = triplets(rootScope);

  // Every light surface a status hue can land on in the terminal.
  const LIGHT_SURFACES: Array<[string, string]> = [
    ["white panel", "#FFFFFF"],
    ["canvas", "#F8FAFC"],
    ["elevated", "#F1F5F9"],
  ];

  const STATUS = ["st-pos", "st-neg", "st-warn", "st-caution", "st-info", "st-teal"] as const;

  it.each(STATUS)("%s meets WCAG AA body text on every light surface (>= 4.5:1)", (token) => {
    for (const [name, surface] of LIGHT_SURFACES) {
      const ratio = contrastRatio(light[token], parseHexColor(surface));
      expect(ratio, `${token} on ${name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(STATUS)("%s dark value is the exact literal it replaced (dark mode unchanged)", (token) => {
    // Dark mode must be pixel-identical to the pre-refactor UI: the dark
    // channel has to resolve to the very hex that used to be hard-coded.
    const EXPECTED_DARK: Record<(typeof STATUS)[number], string> = {
      "st-pos": "#34D399",
      "st-neg": "#FB7184",
      "st-warn": "#FBBF24",
      "st-caution": "#FB923C",
      "st-info": "#60A5FA",
      "st-teal": "#5EEAD4",
    };
    expect(hex(dark[token])).toBe(EXPECTED_DARK[token]);
  });

  it("the stock Tailwind accents we removed would have FAILED on white (regression proof)", () => {
    // These are the exact pre-fix literals. Pin the failure so a future edit
    // that re-inlines `text-emerald-400` is visibly wrong rather than subtle.
    const preFix: Array<[string, string]> = [
      ["emerald-400 (T1 / bid / LIVE)", "#34D399"],
      ["rose-400 (ask)", "#FB7184"],
      ["amber-400 (warn / L1)", "#FBBF24"],
      ["orange-400 (T4)", "#FB923C"],
      ["teal-300 (T2)", "#5EEAD4"],
      ["blue-400 (info)", "#60A5FA"],
    ];
    for (const [label, hexColor] of preFix) {
      expect(
        contrastRatio(parseHexColor(hexColor), parseHexColor("#FFFFFF")),
        `${label} must be unusable on white`,
      ).toBeLessThan(4.5);
    }
  });

  it("ink on a light panel is strong enough to read as 'dark text'", () => {
    // Guards the second half of the report: the faint 9-10px timestamp/execution
    // labels that were rendering as mid-grey on white.
    expect(contrastRatio(light["term-ink-dim"], parseHexColor("#FFFFFF")))
      .toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * ── COMPONENT AUDIT ──
 * Token availability is necessary but not sufficient: a component can have a
 * perfectly good light value available and still hard-code the literal. These
 * assertions read the actual source of the two panels named in the light-mode
 * bug report and fail if a wash-out literal creeps back in.
 */
describe("terminal panels do not re-inline light-mode wash-out literals", () => {
  const PANELS = [
    "src/components/trading/order-book.tsx",
    "src/components/trading/signal-widget.tsx",
    "src/components/shared/tier-badge.tsx",
  ] as const;

  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  // Status literals that MUST be routed through the `st-*` channels.
  const BANNED_STATUS = [
    "emerald-400",
    "emerald-500",
    "rose-400",
    "rose-500",
    "amber-400",
    "amber-500",
    "orange-400",
    "orange-500",
    "teal-300",
    "teal-400",
    "teal-500",
    "blue-400",
  ] as const;

  it.each(PANELS)("%s routes every status hue through a token", (panel) => {
    const src = read(panel);
    for (const literal of BANNED_STATUS) {
      expect(
        new RegExp(`\\b(text|bg|border)-${literal}\\b`).test(src),
        `${panel} still uses ${literal}; use the matching --st-* channel instead`,
      ).toBe(false);
    }
  });

  it.each(PANELS)("%s never pairs text-white with a theme-inverting surface", (panel) => {
    // `text-white` is a literal and does not follow the theme, so it is only
    // legitimate on a surface that stays dark in BOTH themes. Two lists:
    //
    //  • SATURATED/FIXED backgrounds (bg-blue-600, bg-rose-600, bg-slate-50):
    //    white-on-solid is correct in light and dark alike — the signal card's
    //    "View Chart" button and the Order Book spread bar both qualify.
    //  • THEME-INVERTING backgrounds (bg-obsidian*, bg-slate-100..900): these
    //    resolve to white/near-white under `html.light`, so `text-white` on
    //    them is 1.0:1 — the exact wash-out being fixed.
    //
    // Scoped per element (a single className string) rather than per line, so a
    // solid `bg-blue-600 text-white` button is not mistaken for a bare span.
    const STAYS_DARK = /\bbg-(black|slate-50|slate-950)\b/;
    const INVERTS = /\bbg-(obsidian(?:-?\d*)?|slate-(?:100|200|300|400|500|600|700|800|900)|surface|elevated|well|term-panel)\b/;

    const offenders = [...read(panel).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
      .filter((cls) => /\btext-white\b/.test(cls) && INVERTS.test(cls) && !STAYS_DARK.test(cls));

    expect(
      offenders.join("\n"),
      `${panel}: text-white sits on a surface that turns white in light mode; use text-slate-50 / text-ink`,
    ).toBe("");
  });

  it("the panels source body ink from the inverted scale", () => {
    // Positive assertion: the two data panels must actually reach for themed
    // ink. This is what turns `text-white` into `text-slate-50` (light #020617 /
    // dark #F8FAFC) and the faint 9-10px labels into `text-ink-muted`
    // (light #475569 at 7.6:1 / dark #94A3B8).
    //
    // tier-badge is deliberately excluded: it is a status pill with no neutral
    // body ink, so its correct contract is the `st-*` channels, asserted below.
    for (const panel of [
      "src/components/trading/order-book.tsx",
      "src/components/trading/signal-widget.tsx",
    ] as const) {
      expect(
        read(panel),
        `${panel} must use inverted-scale ink (text-slate-50 / text-ink-muted)`,
      ).toMatch(/\b(text-slate-50|text-ink|text-ink-muted)\b/);
    }
  });

  it("tier-badge draws every tier colour from the status channels", () => {
    // A pure status pill: all five tiers must be channel-driven so the badge
    // re-themes with the rest of the terminal.
    const src = read("src/components/shared/tier-badge.tsx");
    for (const tier of ["pos", "teal", "warn", "caution"] as const) {
      expect(src, `tier-badge must use the --st-${tier} channel`).toContain(`st-${tier}`);
    }
  });

  it("the Order Book spread bar keeps white ink on its self-darkening surface", () => {
    // Pins the one legitimate `text-white` in order-book.tsx so a well-meaning
    // "invert everything" sweep does not flip it to dark-on-dark. The bar uses
    // `bg-slate-50`, which resolves to #020617 in light mode.
    expect(read("src/components/trading/order-book.tsx")).toMatch(
      /bg-slate-50 dark:bg-slate-800/,
    );
  });
});

/**
 * ── OPACITY-MODIFIER FOOTGUN ──
 * A silent, build-clean failure mode. `colors.elevated` is the raw string
 * `var(--tp-elevated)` with no `<alpha-value>` placeholder, so Tailwind cannot
 * synthesise an alpha channel and DROPS the utility entirely:
 *
 *     bg-elevated/70   ->  no rule emitted at all
 *     bg-st-pos/10     ->  background-color: rgb(var(--st-pos) / 0.1)
 *
 * `tsc` and `eslint` both pass, the class is simply absent from the stylesheet.
 * That is how the Order Book footer lost its inset background during this
 * refactor. Only the channel-triplet families accept `/opacity`.
 */
describe("semantic tokens are not used with an opacity modifier", () => {
  // tailwind.config.js `colors.extend` entries that are plain `var(--x)`.
  const NON_CHANNEL = [
    "app",
    "surface",
    "elevated",
    "well",
    "line",
    "line-strong",
    "ink",
    "ink-muted",
    "ink-faint",
    "accent",
    "accent-2",
  ] as const;

  it("the config really does declare them without an <alpha-value> placeholder", () => {
    // If someone later converts these to channel triplets this whole suite
    // becomes inert, so assert the premise rather than assuming it. Matching
    // the `var(--tp-` prefix is unambiguous: a channel triplet is written
    // `rgb(var(--x) / <alpha-value>)` and can never match. Anchoring on the
    // prefix also avoids colliding with the nested `term.line` family key.
    const config = readFileSync(join(process.cwd(), "tailwind.config.js"), "utf8");
    for (const name of NON_CHANNEL) {
      expect(
        config,
        `tailwind.config must declare "${name}" as a plain var(--tp-*) token`,
      ).toMatch(new RegExp(`"?${name}"?:\\s*"var\\(--tp-[\\w-]+\\)"`));
    }
  });

  it("no source file applies /opacity to a non-channel semantic token", () => {
    const offenders: string[] = [];
    for (const file of globFiles(join(process.cwd(), "src"))) {
      const src = readFileSync(file, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        for (const name of NON_CHANNEL) {
          if (new RegExp(`\\b(?:bg|text|border|from|to|ring)-${name}/[0-9]`).test(line)) {
            offenders.push(
              `${file.replace(process.cwd(), ".")}:${i + 1} — ${name} is not a channel triplet: ${line.trim().slice(0, 90)}`,
            );
          }
        }
      }
    }
    expect(
      offenders.join("\n"),
      "These utilities compile to NOTHING. Use the token without /opacity, or route through a channel family (slate/obsidian/st/term/bull/bear).",
    ).toBe("");
  });
});

describe("theme engine wiring", () => {
  it("pre-paint script stamps a dark/light class before first paint", () => {
    expect(THEME_PREPAINT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_PREPAINT_SCRIPT).toContain("classList.add(m)");
    expect(THEME_PREPAINT_SCRIPT).toContain("colorScheme");
    // "system" must resolve through the media query, not hardcode dark.
    expect(resolveTheme("system")).toMatch(/^(dark|light)$/);
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(getStoredTheme()).toBe("dark"); // node ⇒ DEFAULT_THEME
  });
});

describe("pre-paint script is actually EXECUTABLE (zero-flash)", () => {
  const layoutRaw = readFileSync(
    join(process.cwd(), "src", "app", "layout.tsx"),
    "utf8",
  );
  // Strip comments before asserting on source text: the rationale comment above
  // the injection legitimately NAMES the forbidden API, and a naive substring
  // check would fail on its own documentation.
  const layout = layoutRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("injects the pre-paint IIFE as a raw inline <script>", () => {
    // A raw inline <script> runs during parse, BEFORE first paint and without
    // the Next runtime. This is the assertion that would have caught the
    // original bug, where <Script strategy="beforeInteractive"> emitted the
    // markup but deferred execution to Next's bootstrap: with JS blocked the
    // stamp never ran, and a light-mode user got a full dark first paint.
    expect(layout).toMatch(/<script[^>]*dangerouslySetInnerHTML/);
    expect(layout).toContain("THEME_PREPAINT_SCRIPT");
    expect(layout).toContain("LANG_PREPAINT_SCRIPT");
  });

  it("does NOT use next/script beforeInteractive for the pre-paint stamp", () => {
    // beforeInteractive inside a hand-authored <head> delegates execution to
    // the Next client bootstrap, which defeats the zero-flash guarantee.
    expect(layout).not.toMatch(/strategy=["']beforeInteractive["']/);
    expect(layout).not.toMatch(/import\s+Script\s+from\s+["']next\/script["']/);
    expect(layout).not.toMatch(/<Script\b/);
  });

  it("keeps suppressHydrationWarning so React adopts the stamped class", () => {
    // The stamped class intentionally differs from the SSR className; without
    // this, hydration logs a mismatch for every light-mode user.
    expect(layoutRaw).toMatch(/<html[^>]*suppressHydrationWarning/);
  });
});

/**
 * "DOUBLY-INVERTED SLATE PAIRS"
 *
 * globals.css INVERTS the slate scale between themes, so a slate class
 * already flips on its own. Three legacy pages were written against STOCK
 * Tailwind semantics (low number = light) and hand-rolled `dark:` prefixes,
 * which under the inversion means light mode resolved `bg-slate-50` to
 * `--sl-50: #020617` -- a near-black panel on a near-white page, while dark
 * mode still looked correct and hid the fault.
 *
 * The repair is to DELETE the base and unprefix the dark shade (each half is
 * the auto-inverse of the other, so dark output is unchanged). This guard
 * fails if the stock convention creeps back into these pages.
 */
describe("legacy dark: prefixes collapsed for the inverted slate scale", () => {
  const readSrc = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  const PAGES = [
    "src/app/(dashboard)/settings/page.tsx",
    "src/app/(dashboard)/history/page.tsx",
    "src/app/(dashboard)/risk-rules/page.tsx",
  ];
  // Same colour family on both halves is what makes these collapse-able.
  const DOUBLY_INVERTED =
    /(bg|text|border|divide|ring|placeholder)-(slate|obsidian)-\d+[^\s"]*\s+dark:\1-\2-\d+/g;

  for (const page of PAGES) {
    it(`${page} carries no doubly-inverted slate pair`, () => {
      const offenders = readSrc(page).match(DOUBLY_INVERTED) ?? [];
      expect(
        offenders,
        `remove the base shade and unprefix the dark shade: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("keeps the one deliberate self-darkening Order Book bar", () => {
    // order-book.tsx pairs a near-black spread bar with white ink in BOTH
    // themes on purpose; flipping it would put white ink on a white bar.
    expect(readSrc("src/components/trading/order-book.tsx")).toMatch(
      /bg-slate-50 dark:bg-slate-800/,
    );
  });
});

/**
 * ── DARK-MODE INK ON THE DARK-FIRST PRO TERMINAL PAGES ──
 *
 * The light-mode suites above all assert the LIGHT block, because the original
 * bug report was a white page with invisible ink. That left the mirror-image
 * failure completely unguarded: these three pages set `bg-obsidian` on their
 * root, and `--ob` is the DARK value under `:root`, so in dark mode they render
 * near-black while the ink still follows the inverted slate scale.
 *
 * Measured against the real tokens (page = --ob):
 *
 *   text-slate-700  #334155  1.87:1 dark / 1.42:1 light   unreadable, BOTH
 *   text-slate-500  #64748b  4.06:1 dark / 4.55:1 light   sub-AA in dark
 *   text-slate-400  #94a3b8  7.53:1 dark / 7.24:1 light   AA, both
 *
 * So `text-slate-700` section headings ("Risk guardrails", "Performance",
 * "Risk Rules") were invisible in *every* theme, and `hover:text-slate-700` made
 * a control darker exactly when the operator aimed at it. These assertions pin
 * the repair so a future edit cannot reintroduce either step.
 */
describe("Pro Terminal pages keep AA slate ink in BOTH themes", () => {
  const readSrc = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  const PAGES = [
    "src/app/(dashboard)/settings/page.tsx",
    "src/app/(dashboard)/history/page.tsx",
    "src/app/(dashboard)/risk-rules/page.tsx",
  ];

  // `:root` carries the dark values; `html.light` re-inverts the slate scale.
  const dark = triplets(css.slice(css.indexOf(":root {"), css.indexOf("html.dark {")));
  const light = triplets(lightBlock);

  it("both themes define the page background these pages paint", () => {
    // If `--ob` ever stops being a triplet this whole suite would compare
    // against `undefined` and silently pass, so assert the premise.
    expect(dark["ob"], "dark --ob").toBeDefined();
    expect(light["ob"], "light --ob").toBeDefined();
  });

  it.each(["sl-300", "sl-400"] as const)(
    "text-%s meets AA on the page in both themes",
    (token) => {
      const d = contrastRatio(dark[token], dark["ob"]);
      const l = contrastRatio(light[token], light["ob"]);
      expect(d, `${token} dark on page = ${d.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      expect(l, `${token} light on page = ${l.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("regression proof: slate-700 headings were unreadable in BOTH themes", () => {
    expect(contrastRatio(dark["sl-700"], dark["ob"])).toBeLessThan(4.5);
    expect(contrastRatio(light["sl-700"], light["ob"])).toBeLessThan(4.5);
  });

  it("regression proof: slate-500 labels were sub-AA in dark mode", () => {
    expect(contrastRatio(dark["sl-500"], dark["ob"])).toBeLessThan(4.5);
  });

  for (const page of PAGES) {
    it(`${page} uses no sub-AA slate ink`, () => {
      // `text-slate-600` is intentionally allowed: the only occurrence is the
      // decorative " / " separator in history, which carries no information.
      const offenders =
        readSrc(page).match(/(?<![\w-])(?:hover:)?text-slate-(?:500|700|800|900)\b/g) ?? [];
      expect(
        offenders,
        `${page} pairs text-slate-500/700/800/900 with the page background; use text-slate-400 or darker`,
      ).toEqual([]);
    });

    it(`${page} has no theme-inverting bg-white surface left`, () => {
      // `bg-white` is a literal that does NOT follow the inverted scale, so a
      // `bg-white dark:bg-slate-900` pair painted a white panel in light mode
      // and a near-black one in dark — the same element in two unrelated
      // themes. The repair is to keep only the dark shade, matching the
      // `bg-slate-950/40` siblings these pages already use.
      // Match a STANDALONE `bg-white` token only. `\b` alone is not enough: it
      // also fires inside the toggle knob's `after:bg-white`, which is a
      // legitimate white fill on the amber track.
      expect(
        readSrc(page).match(/(?<![\w:-])\bbg-white\b/g) ?? [],
        `${page} still carries a non-inverting bg-white surface`,
      ).toEqual([]);
    });
  }

  it("every near-page fill keeps a border for definition", () => {
    // After the collapse, `bg-slate-950`/`bg-slate-900/x` resolve to the SAME
    // colour as the page in both themes (~1.0:1). That is the established
    // convention on these pages, so separation comes entirely from the outline.
    // A borderless near-page fill would silently vanish into the background.
    for (const page of PAGES) {
      const offenders: string[] = [];
      for (const m of readSrc(page).matchAll(
        /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g,
      )) {
        const cls = m[1] ?? m[2] ?? m[3] ?? "";
        if (/\bbg-slate-9[0-9]{2}(?:\/[0-9]+)?\b/.test(cls) && !/\bborder-(?!0\b)[a-z]/.test(cls)) {
          offenders.push(cls.slice(0, 90));
        }
      }
      expect(offenders, `${page} has a borderless near-page fill`).toEqual([]);
    }
  });
});