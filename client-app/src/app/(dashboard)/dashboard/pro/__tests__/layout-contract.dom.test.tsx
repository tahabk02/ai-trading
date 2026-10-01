import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * PHASE 2 LAYOUT CONTRACT
 * ============================================================================
 * jsdom performs no layout — it cannot tell you whether the chart is 228px or
 * 520px, and it cannot tell you a sticky element has no scroll range to travel.
 * Those facts were established by measuring a real browser, and this file locks
 * in the STRUCTURAL PRECONDITIONS that produced them.
 *
 * This is a source-level guard on purpose, and it mirrors the style already used
 * by `expirySelection.noGating.test.ts`. The failure mode it protects against is
 * real and already happened once during this phase: `xl:items-start` silently
 * collapsed every rail to its content height, which silently made `sticky`
 * inert, which looks fine in every screenshot and breaks the moment the order
 * book grows.
 */

const PRO = "src/app/(dashboard)/dashboard/pro/page.tsx";
const CHART = "src/components/trading/financial-chart.tsx";
const PANEL = "src/components/trading/trading-panel.tsx";

/**
 * Strip comments before matching. The shell is heavily commented, and the prose
 * legitimately names the very patterns being forbidden (e.g. the operator-rail
 * note explains why Phase 1's `xl:items-start` broke sticky). Matching raw text
 * would fail on documentation instead of code. Same approach as
 * `expirySelection.noGating.test.ts`.
 */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const read = (p: string) => readFileSync(p, "utf8");
const proSrc = read(PRO);
const chartSrc = read(CHART);
const pro = strip(proSrc);
const chart = strip(chartSrc);
const panel = strip(read(PANEL));

describe("phase 2 — structural height model", () => {
  it("uses no viewport-subtraction math anywhere in the shell", () => {
    // `calc(100vh - N)` cannot survive a header change, a toolbar change, or a
    // responsive padding change. It silently under/over-shoots all three.
    for (const [name, src] of [
      ["pro/page.tsx", pro],
      ["financial-chart.tsx", chart],
    ] as const) {
      expect(src, name).not.toMatch(/calc\(\s*100v[hd]h\s*-/);
    }
  });

  it("anchors the shell to dvh, not the static vh", () => {
    // 100vh ignores the collapsing mobile toolbar, which is a real jump on
    // phones. 100dvh tracks the actual visual viewport.
    expect(pro).toMatch(/h-\[100dvh\]/);
  });

  it("does NOT use xl:items-start — the sticky-killer", () => {
    // items-start sizes every rail to its own content, so a rail can never
    // overflow, so overflow-y-auto never engages, so sticky has no range.
    // The grid default (stretch) is what gives the rails a definite height.
    expect(pro).not.toMatch(/xl:items-start/);
    expect(pro).toMatch(/xl:grid-cols-\[280px_minmax\(0,1fr\)_320px\]/);
  });

  it("gives the grid a definite height at xl", () => {
    expect(pro).toMatch(/xl:h-full/);
  });

  it("stops page scrolling at xl so the rails own their scrollports", () => {
    expect(pro).toMatch(/xl:overflow-y-hidden/);
  });

  it("every rail is a bounded flex child", () => {
    // min-h-0 is load-bearing: without it a flex item refuses to shrink below
    // its content and re-inflates the shell.
    //
    // The rails are now TEMPLATE-LITERAL classNames (they carry a focus-mode
    // branch), so the opening tag no longer matches a single quoted literal. The
    // bound is generous because the left rail carries a `data-testid` line
    // between `<section` and its className.
    const rails = pro.match(/<section[\s\S]{0,250}?order-[123][^>]*>/g) ?? [];
    expect(rails.length).toBeGreaterThanOrEqual(3);
    for (const rail of rails) {
      if (!/order-[123]/.test(rail)) continue; // skip any non-rail section
      expect(rail, "rail needs min-h-0").toMatch(/min-h-0/);
    }
  });

  it("the CENTRE column is a scrollport with a PINNED, BOUNDED chart", () => {
    // PredictiveIntelligence now lives back in the centre column, full width,
    // below the chart. Its tall `min-h` floor would again starve an unpinned
    // `flex-1` chart to ~228px at 1280x800, so the chart gets a definite
    // viewport-relative height INDEPENDENT of what sits below it.
    const center = pro.match(/order-1 xl:order-2[\s\S]{0,400}?>/)?.[0] ?? "";
    expect(center).toMatch(/min-h-0/);
    expect(center).toMatch(/xl:overflow-y-auto/);
    expect(pro).toMatch(/h-\[clamp\(280px,42vh,520px\)\]/);
  });

  it("the CoherenceStrip and the chart are ONE sticky shell", () => {
    // Regression guard for a MEASURED defect: with the chart `sticky top-0
    // z-10` and the strip only `shrink-0`, scrolling the centre column moved the
    // strip up and UNDER the chart. The strip's z-index is `auto`, so the chart
    // won every overlap and the "TOO LATE TO ACT" badge was occluded (measured:
    // strip top = -79px, centre-point hit test hit the chart, not the badge).
    //
    // The fix is structural: one sticky shell containing BOTH, so they are a
    // single box and cannot overlap each other. The chart must therefore NOT
    // carry its own `sticky` — two independently-sticky siblings is what caused
    // the bug in the first place.
    expect(pro).toMatch(/data-testid="pinned-chart-shell"/);
    // Opaque background is load-bearing: the shell overlaps the AI panel
    // scrolling beneath it, so a transparent box would show it through.
    expect(pro).toMatch(
      /data-testid="pinned-chart-shell"[\s\S]{0,200}?bg-\[var\(--tp-bg\)\]/,
    );
    // z-20 keeps the shell above the AI panel it overlaps.
    expect(pro).toMatch(/sticky top-0 z-20/);
    // The old per-chart sticky/z-10 must not come back.
    expect(pro).not.toMatch(/sticky top-0 z-10/);
    // Strip and chart must both live inside the shell block.
    const shell = pro.slice(
      pro.indexOf('data-testid="pinned-chart-shell"'),
      pro.indexOf('data-testid="ai-panel-below-chart"'),
    );
    expect(shell).toMatch(/<ProExpiryBar/);
    expect(shell).toMatch(/<FinancialChart/);
  });

  it("the matrix sits in the CENTRE column, full width, below the chart", () => {
    // The matrix replaced the narrative AI panel in the same block footprint.
    // The load-bearing STRUCTURE is unchanged: in the centre column, full
    // width, `shrink-0` so its floor is a reachable minimum rather than
    // silently-clipped overflow, and NOT back in the narrow operator rail.
    const centerBlock = pro.slice(
      pro.indexOf("order-1 xl:order-2"),
      pro.indexOf("order-2 xl:order-1"),
    );
    expect(centerBlock).toMatch(/data-testid="ai-panel-below-chart"/);
    expect(centerBlock).toMatch(/<NeuralMatrixVisualizer/);
    expect(pro).toMatch(/shrink-0 w-full min-w-0/);
    // And it must NOT be back in the narrow 320px operator rail.
    const rail = pro.slice(pro.indexOf("order-3 flex flex-col"));
    expect(rail).not.toMatch(/<NeuralMatrixVisualizer/);
  });

  it("INVARIANT 1 — the matrix crosses the page boundary with NO live data", () => {
    // The load-bearing performance contract. A canvas animation that stays
    // "live" in React MUST subscribe to a per-tick field, and that subscription
    // re-renders the entire Pro page once per packet — the render storm this
    // whole system is built to avoid.
    //
    // So the page may pass only change-gated props: `symbol` (changes on a
    // deep link / submit) and `live` (a boolean the socket already gates). If
    // anyone ever adds `currentPrice`, `predictionData` or `liveSignals` here,
    // this test fails — which is the point.
    const block = pro.slice(
      pro.indexOf('data-testid="ai-panel-below-chart"'),
      pro.indexOf("order-2 xl:order-1"),
    );
    expect(block).toMatch(/<NeuralMatrixVisualizer/);
    for (const forbidden of [
      "currentPrice",
      "predictionData",
      "liveSignals",
      "_priceVersion",
      "lastPriceUpdate",
      "realtimeCandles",
    ]) {
      expect(
        block,
        `matrix must not receive the per-tick field "${forbidden}"`,
      ).not.toContain(forbidden);
    }
  });

  it("the matrix engine subscribes to nothing reactive on the tick path", () => {
    // Second half of the same contract, verified at the source. The engine
    // reads the store with `getState()` inside its rAF loop — a non-reactive
    // snapshot that cannot schedule a render — and has no `useState` fed by the
    // frame loop. Telemetry is the ONE value that crosses into React, and it
    // is published at 1 Hz behind a reference-equality bail-out.
    //
    // Both files are comment-stripped first: the engine's header docblock
    // NAMES `useState`/`useEffect` to explain their absence, so a raw-text
    // match would fail on the documentation. Same approach as the assertions
    // above.
    const hook = strip(read("src/hooks/useNeuralMatrix.ts"));
    const engine = strip(read("src/lib/neuralMatrix/engine.ts"));

    // The engine must be free of React entirely: a per-tick render is not
    // merely avoided there, it is structurally impossible.
    expect(engine).not.toMatch(/from ["']react["']/);
    expect(engine).not.toMatch(/useState|useEffect|useSyncExternalStore/);
    expect(engine).not.toMatch(/Math\.random/);

    // The hook must read the feed through the injected non-reactive reader.
    expect(hook).toMatch(/readFeedRef\.current\(\)/);
    // …and gate the only React-visible value behind 1 Hz + change detection.
    expect(hook).toMatch(/TELEMETRY_INTERVAL_MS/);
    expect(hook).toMatch(/sameTelemetry/);
    expect(hook).toMatch(/requestAnimationFrame/);
    // Off-screen + hidden-tab culling: a 60fps canvas nobody is looking at is
    // pure battery burn, and the graph lives below the fold on a laptop.
    expect(hook).toMatch(/IntersectionObserver/);
    expect(hook).toMatch(/visibilitychange/);
  });

  it("FOCUS MODE collapses to one column and hides both rails and the AI panel", () => {
    // Pure layout: a boolean in React state read only by classNames, so the tick
    // paint path and the projection matrix never see it.
    expect(pro).toMatch(/const \[focusMode, setFocusMode\] = useState\(false\)/);
    expect(pro).toMatch(/data-testid="focus-mode-toggle"/);
    expect(pro).toMatch(/aria-pressed=\{focusMode\}/);
    // Single-column grid while focused, 3-pane grid otherwise.
    expect(pro).toMatch(/xl:grid-cols-\[minmax\(0,1fr\)\]/);
    expect(pro).toMatch(/xl:grid-cols-\[280px_minmax\(0,1fr\)_320px\]/);
    // Both rails and the AI panel are gated, so focus is truly chart-only.
    expect(pro.match(/\(focusMode \? "hidden" : ""\)/g) ?? []).toHaveLength(2);
    expect(pro).toMatch(/\{!focusMode && \(\s*<div\s+data-testid="ai-panel-below-chart"/);
    // Focus state is plain UI state, never a store input.
    expect(pro).not.toMatch(/useTradingStore\([^)]*focusMode/);
  });

  it("the operator rail has exactly ONE scrollport — nothing nests", () => {
    // Regression guard for a MEASURED bug: the rail scrolled 208px while
    // containing a panel that independently scrolled 136px — a scrollbar inside
    // a scrollbar, a real pointer/wheel hazard.
    //
    // The rail IS the pane's single scrollport, and neither child adds another.
    // The alternative (make the rail non-scrolling so children scroll) was
    // tried and measured WORSE: the Order Book became clipped and unreachable
    // (rail overflow 103px). Removing a scrollport frees no space.
    expect(pro).toMatch(
      /order-3 flex flex-col gap-4 sm:gap-5 min-w-0 min-h-0 xl:overflow-y-auto/,
    );
    // The panel must NOT be height-capped: the cap existed only because sticky
    // cannot pin an oversized box, and it forced the panel to become a
    // scroller (the nested scrollbar). Uncapped + overflow-clip is the fix.
    expect(pro).not.toMatch(/max-h-\[85%\]/);
    // Panel pinned at the rail top, opaque so the book cannot show through.
    expect(pro).toMatch(
      /data-testid="pinned-execution-panel"[\s\S]{0,160}?sticky top-0 z-20 shrink-0/,
    );
    // Order Book: no inner scroller — the rail's scrollbar reaches it.
    expect(pro).not.toMatch(/xl:max-h-\[320px\]/);
  });

  it("TradingPanel is not a scroll container, so its sticky footer resolves to the rail", () => {
    // The load-bearing detail. Sticky resolves against the NEAREST scroll
    // container, so the panel root's overflow decides where CALL/PUT pin:
    //   - `overflow-hidden` / `overflow-y-auto` on the root => CALL/PUT pin to
    //     the panel (measured: footer 93px below the rail's bottom edge, PUT
    //     hit-tested to the status row behind it — visible but NOT clickable).
    //   - `overflow-clip` => clips the radius without BECOMING a scroll
    //     container, so the footer pins to the rail's bottom edge instead.
    //
    // Scoped to the ROOT element, not the whole file: the expiry-selector grid
    // is intentionally a small bounded list scroller, which is a different
    // concern from the root capturing the sticky footer.
    const root =
      read(PANEL).match(
        /<div\s+className="bg-obsidian border border-slate-800\/80 rounded-2xl[^"]*flex flex-col[^"]*"/,
      )?.[0] ?? "";
    expect(root, "panel root located").not.toBe("");
    expect(root).toMatch(/overflow-clip/);
    expect(root).not.toMatch(/overflow-y-auto/);
    expect(root).not.toMatch(/overflow-hidden/);
    expect(root).not.toMatch(/custom-scrollbar/);
    // `min-h-0` was only needed so the height-capped flex child could shrink.
    expect(root).not.toMatch(/rounded-2xl min-h-0/);
    // The sticky footer itself must still exist.
    expect(read(PANEL)).toMatch(/sticky bottom-0/);
  });

  it("stacks the two operator regions in the required order", () => {
    const rail = pro.slice(pro.indexOf("order-3 flex flex-col"));
    const panel = rail.indexOf("<TradingPanel");
    const book = rail.indexOf("<OrderBook");
    expect(panel, "TradingPanel present in rail").toBeGreaterThan(-1);
    expect(book, "OrderBook present in rail").toBeGreaterThan(-1);
    expect(panel).toBeLessThan(book);
    // The required execution-safety prop is still passed explicitly.
    expect(rail).toMatch(/<TradingPanel stalePrice=\{stalePrice\} \/>/);
  });

  it("keeps CALL/PUT reachable via the panel's own sticky action footer", () => {
    // The action footer is sticky at the BOTTOM of the panel, which is the only
    // sticky relationship here guaranteed to work: the footer is short and
    // always fits its containing block.
    const footer = read("src/components/trading/trading-panel.tsx");
    expect(footer).toMatch(/sticky bottom-0/);
    // ...and it must be opaque, or the scrolling selector grid shows through.
    expect(footer).toMatch(/sticky bottom-0[^"]*bg-\[var\(--tp-surface\)\]/);
  });

  it("the panel root is NOT a scroll container, so the sticky footer is not inert", () => {
    // Regression guard for a subtle, measured failure. The panel root used to be
    // `overflow-hidden` — a scroll CONTAINER with zero scroll range. Sticky
    // resolves against the NEAREST scroll container, so the action footer was
    // pinning itself to that unscrollable root instead of to the operator rail.
    // Measured: the footer sat 93px BELOW the rail's visible bottom edge, and
    // `elementFromPoint` at PUT's centre hit the status row behind it — the
    // buttons were on screen but NOT clickable at 1280x800.
    //
    // Making the root a REAL scroller fixed that but created the nested-scrollbar
    // failure (rail 208px containing a panel scrolling 136px). The resolution is
    // `overflow-clip`: it clips the rounded corners without becoming a scroll
    // container, so the footer's sticky resolves against the rail.
    //
    // Either way the invariant is the same and is what this pins: the panel root
    // must not be a scroll container. Target the REAL panel root, not the
    // Suspense loading skeleton above it (which shares the `bg-obsidian …
    // rounded-2xl` prefix but is a self-closing `animate-pulse` placeholder).
    // `flex flex-col` is unique to the root.
    const raw = read(PANEL);
    const root =
      raw.match(
        /<div\s+className="bg-obsidian border border-slate-800\/80 rounded-2xl[^"]*flex flex-col[^"]*"/,
      )?.[0] ?? "";
    expect(root, "panel root located").not.toBe("");
    expect(root, "panel root must not be a scroll container").not.toMatch(
      /overflow-y-auto/,
    );
    expect(root, "panel root must not be overflow-hidden").not.toMatch(
      /\boverflow-hidden\b/,
    );
    // …but it must still clip the rounded corners, via the non-scrolling value.
    expect(root, "radius clip without a scrollport").toContain("overflow-clip");
    // The footer must still be sticky, and the rail must be the scrollport it
    // resolves against.
    expect(raw).toMatch(/sticky bottom-0/);
    expect(pro).toMatch(/data-testid="right-rail"/);
    expect(pro).toMatch(/xl:overflow-y-auto/);
  });

  it("binds the CoherenceStrip to the ONE coherent signal view, not the raw field", () => {
    // The "SIGNAL: WAITING" gap: the strip read raw `predictionData.signal`
    // while the chart HUD read the SignalHoldBuffer view, so the two panels
    // disagreed whenever the REST/WS writers briefly left the raw field null.
    // All three signal-bearing props must come from the published view as a
    // single read, so a badge can never contradict its own tier.
    expect(pro).toMatch(/useSignalViewStore\(selectSignalView\)/);
    expect(pro).toMatch(/signal=\{coherentSignal\}/);
    expect(pro).toMatch(/tier=\{coherentTier\}/);
    expect(pro).toMatch(/regimeScoredOnly=\{coherentRegimeScoredOnly\}/);
    // The strip must never fall back to the raw field once a view exists.
    const bindings = pro.slice(
      pro.indexOf("const coherentSignal"),
      pro.indexOf("coherentRegimeScoredOnly ="),
    );
    expect(bindings.length, "coherent binding block located").toBeGreaterThan(0);
    expect(bindings).toMatch(/coherentView[\s\S]*\?\s*coherentView\.gatedSignal/);
    // ...and the fallback is a raw read, used ONLY before the chart publishes.
    expect(bindings).toMatch(/predictionData\?\.signal \?\? null/);
  });

  it("publishes the chart's signal view change-gated, off the tick path", () => {
    // Invariant 1: the publish must be a post-render effect on the HUD cadence
    // and gated on all four view fields, so a store write can only happen on a
    // real signal transition — never once per tick, never once per render.
    const store = read("src/lib/signalViewStore.ts");
    for (const field of ["gatedSignal", "tier", "bucketSec", "suppressedReason"]) {
      expect(store, `change gate must compare ${field}`).toMatch(
        new RegExp(`current\\.${field} === next\\.${field}`),
      );
    }
    expect(chart).toMatch(/<SignalViewPublisher view=\{hudView\} \/>/);
    expect(chart).toMatch(/useEffect\(\(\) => \{/);
  });

  it("keeps the chart itself container-sized, not viewport-sized", () => {
    // financial-chart must fill whatever cell it is given.
    expect(chart).toMatch(/xl:h-full/);
    expect(chart).not.toMatch(/100vh/);
  });
});
