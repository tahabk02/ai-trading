/**
 * assetFilter — MARKET TERMINAL ASSET FILTER (multi-select + favorites + search).
 *
 * THREE SEPARATE CONCERNS, DELIBERATELY KEPT APART:
 *
 *   1. ASSET CLASS (otc | real | crypto) — which VENUE a pair trades on.
 *      This is STATIC, authoritative data from `constants/symbols.ts`.
 *   2. CURRENCY (EUR, USD, GBP …) — which CURRENCIES an operator cares about.
 *   3. FAVORITES / EXCLUSIONS — operator curation, persisted.
 *
 * ── WHY THIS MODULE EXISTS (the "Real market is locked" bug) ───────────────
 * The grid previously derived asset class from LIVE QUOTES:
 *
 *     sub: useMarketTerminalStore.getState().quotes[sym]?.assetSubType
 *
 * Two defects made "Real" look broken:
 *
 *   a) BLOCKING RACE — `getState()` inside a `useMemo` is a NON-REACTIVE read.
 *      If the first render happens before any `market_quotes` snapshot lands,
 *      `sub` is `undefined` for every symbol, `byQuote` is empty, and the code
 *      fell back to a hand-rolled REGEX (`/^BTC\/USD$|^ETH\/USD$/`, plus a
 *      `REAL_MARKET_SYMBOLS` membership test) that DUPLICATED classification
 *      logic already owned by `getAssetSubType`. Two sources of truth for one
 *      fact.
 *
 *   b) PARTIAL-SNAPSHOT HANG — when only SOME quotes had landed, `byQuote`
 *      was non-empty, so the fallback never ran and the grid rendered an
 *      arbitrary subset. Select "Real" mid-boot and you could get 3 of 10
 *      pairs, with no error and no way to tell that 7 were missing.
 *
 * Fix: classification is derived from the STATIC REGISTRY (always complete,
 * always identical to the backend's `symbolRegistry.service.ts`), and quotes
 * are used only for PRICE data. Filtering therefore behaves identically before,
 * during and after the first snapshot.
 *
 * ── MULTI-SELECT SEMANTICS ───────────────────────────────────────────────
 * The store keeps a SET of active classes, not a single enum. An EMPTY set is
 * a distinct, meaningful state meaning "show everything" — the default. We
 * deliberately do NOT collapse an empty set back to "all", because that would
 * make it impossible for an operator to un-toggle their last active class
 * (the click that empties the set would immediately re-select everything,
 * reading as "the toggle is stuck"). The `isShowingEverything` helper is the
 * single place that decides that, so the badge count and the grid can never
 * disagree.
 */

import { getAssetSubType, ALL_MARKET_SYMBOLS } from "@/constants/symbols";

export { ALL_MARKET_SYMBOLS };

/** The three selectable venue classes. "all" is a VIEW, never a stored class. */
export type AssetClass = "otc" | "real" | "crypto";

/**
 * The legacy single-select enum. "all" is not a member of `AssetClass` — it
 * means "no isolation" and is expressed as the EMPTY class set. Kept exported
 * so older call sites and the persisted `filter` mirror keep compiling.
 */
export type AssetClassFilter = "all" | AssetClass;

export const ASSET_CLASSES: readonly AssetClass[] = ["otc", "real", "crypto"] as const;

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  otc: "OTC",
  real: "Real",
  crypto: "Crypto",
};

/**
 * Map a registry `assetSubType` onto the operator-facing filter class.
 * The backend vocabulary is "forex" for real wholesale pairs; the UI calls
 * that class "real". Keeping the translation in ONE place is what stops the
 * grid and the pill badges from disagreeing.
 */
function classOfSymbol(symbol: string): AssetClass {
  const sub = getAssetSubType(symbol);
  if (sub === "crypto") return "crypto";
  if (sub === "forex") return "real";
  return "otc";
}

// ════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ════════════════════════════════════════════════════════════════════

export const LS_ASSET_CLASSES_KEY = "terminal_asset_classes";
export const LS_FAVORITES_KEY = "terminal_asset_favorites";
export const LS_HIDDEN_KEY = "terminal_asset_hidden";
export const LS_SYMBOL_QUERY_KEY = "terminal_asset_query";

/** Read a persisted string[] as a valid AssetClass[] (drops junk, dedupes). */
export function sanitizeAssetClasses(raw: unknown): AssetClass[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<AssetClass>();
  for (const item of raw) {
    if (typeof item === "string" && (ASSET_CLASSES as readonly string[]).includes(item)) {
      seen.add(item as AssetClass);
    }
  }
  // Canonical order, never the caller's insertion order — so the pill row and
  // the persisted payload are byte-identical regardless of toggle sequence.
  return ASSET_CLASSES.filter((c) => seen.has(c));
}

function readJson(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable (SSR, privacy mode) — best effort only.
  }
}

export function readPersistedAssetClasses(): AssetClass[] {
  return sanitizeAssetClasses(readJson(LS_ASSET_CLASSES_KEY));
}

export function persistAssetClasses(classes: AssetClass[]): void {
  writeJson(LS_ASSET_CLASSES_KEY, sanitizeAssetClasses(classes));
}

/** Favorites / hidden are stored as canonical "BASE/QUOTE" symbol strings. */
export function readPersistedFavorites(): string[] {
  const raw = readJson(LS_FAVORITES_KEY);
  if (!Array.isArray(raw)) return [];
  return sanitizeSymbolList(raw);
}

export function persistFavorites(symbols: string[]): void {
  writeJson(LS_FAVORITES_KEY, sanitizeSymbolList(symbols));
}

export function readPersistedHidden(): string[] {
  const raw = readJson(LS_HIDDEN_KEY);
  if (!Array.isArray(raw)) return [];
  return sanitizeSymbolList(raw);
}

export function persistHidden(symbols: string[]): void {
  writeJson(LS_HIDDEN_KEY, sanitizeSymbolList(symbols));
}

export function readPersistedSymbolQuery(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LS_SYMBOL_QUERY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistSymbolQuery(query: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_SYMBOL_QUERY_KEY, query);
  } catch {
    // best effort only.
  }
}

/**
 * Normalize a symbol list to canonical UPPER "BASE/QUOTE", deduped, and —
 * critically — CLIPPED TO THE KNOWN UNIVERSE. A stale persisted entry for a
 * delisted symbol is dropped rather than kept forever, which is what would
 * otherwise make a favorites count drift away from reality.
 */
export function sanitizeSymbolList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const universe = new Set(ALL_MARKET_SYMBOLS);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const norm = item.trim().toUpperCase().replace(/[\s\-_.]+/g, "/");
    if (!universe.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// COUNTS
// ════════════════════════════════════════════════════════════════════

/**
 * Authoritative per-class counts, computed ONCE from the static registry.
 *
 * The previous `countByFilter` in the pill component read
 * `OTC_FOREX_PAIRS.filter(p => p.assetSubType === f)` for otc/crypto but
 * returned `OTC_FOREX_PAIRS.length` for "all" and `REAL_FOREX_PAIRS.length`
 * for "real". That happened to total 44, but ONLY because `OTC_FOREX_PAIRS`
 * spreads `REAL_FOREX_PAIRS` — a hidden coupling. It also counted crypto via
 * the "otc" bucket path, so any future symbol whose `assetSubType` drifted
 * would silently mis-report. Deriving every count from ONE map removes the
 * coupling entirely.
 */
export const ASSET_CLASS_COUNTS: Readonly<Record<AssetClass, number>> = (() => {
  const counts: Record<AssetClass, number> = { otc: 0, real: 0, crypto: 0 };
  for (const sym of ALL_MARKET_SYMBOLS) counts[classOfSymbol(sym)] += 1;
  if (process.env.NODE_ENV !== "production") {
    const total = counts.otc + counts.real + counts.crypto;
    if (total !== ALL_MARKET_SYMBOLS.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[assetFilter] class counts (${total}) != universe size (${ALL_MARKET_SYMBOLS.length})`,
      );
    }
  }
  return counts;
})();

export const TOTAL_SYMBOL_COUNT = ALL_MARKET_SYMBOLS.length;

// ════════════════════════════════════════════════════════════════════
// CURRENCY EXTRACTION
// ════════════════════════════════════════════════════════════════════

/** Every distinct currency code present in the universe, alphabetically. */
export const UNIVERSE_CURRENCIES: readonly string[] = (() => {
  const set = new Set<string>();
  for (const sym of ALL_MARKET_SYMBOLS) {
    for (const part of sym.split("/")) if (part) set.add(part);
  }
  return [...set].sort();
})();

/** The currencies quoted on one pair. `EUR/SEK` → ["EUR","SEK"]. */
export function currenciesOf(symbol: string): string[] {
  return symbol
    .trim()
    .toUpperCase()
    .split("/")
    .filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════
// TOGGLE / SET ALGEBRA
// ════════════════════════════════════════════════════════════════════

/**
 * Toggle one class inside a set. Returns a NEW array in canonical order.
 * Toggling the last active class yields `[]` = "show everything", which is
 * the intended (and documented) empty-set state — NOT a snap back to "all".
 */
export function toggleClass(classes: AssetClass[], target: AssetClass): AssetClass[] {
  const current = sanitizeAssetClasses(classes);
  const next = current.includes(target)
    ? current.filter((c) => c !== target)
    : [...current, target];
  return sanitizeAssetClasses(next);
}

/** True when the operator has not isolated any class (empty set = show all). */
export function isShowingEverything(classes: AssetClass[]): boolean {
  return sanitizeAssetClasses(classes).length === 0;
}

/** Single-select legacy behaviour, expressed over the multi-select set. */
export function setSingleClass(target: AssetClassFilter): AssetClass[] {
  return target === "all" ? [] : sanitizeAssetClasses([target]);
}

// ════════════════════════════════════════════════════════════════════
// THE FILTER ITSELF
// ════════════════════════════════════════════════════════════════════

export interface AssetFilterState {
  /** Active venue classes. EMPTY = show everything. */
  classes: AssetClass[];
  /** Pinned symbols. Non-empty ⇒ `favoritesOnly` hides everything else. */
  favorites: string[];
  /** Operator-hidden symbols. Always excluded (unless `favoritesOnly`). */
  hidden: string[];
  /** Free-text pair/currency query. */
  query: string;
  /** When true, ONLY favorites are shown regardless of classes. */
  favoritesOnly: boolean;
}

export const DEFAULT_ASSET_FILTER: AssetFilterState = {
  classes: [],
  favorites: [],
  hidden: [],
  query: "",
  favoritesOnly: false,
};

function normalizeQuery(q: string): string {
  return String(q ?? "")
    .trim()
    .toUpperCase();
}

/**
 * Does a symbol match a free-text query?
 *
 * Matching is separator-insensitive on BOTH sides: the symbol is reduced to a
 * compact "BASEQUOTE" form and the query is stripped of `/`, `-`, `_`, `.` and
 * whitespace, so "EUR SEK", "eur-sek" and "EURSEK" all find `EUR/SEK`. A
 * query is also matched against each currency leg alone, so "SEK" isolates
 * every pair quoting the krona.
 */
export function matchesQuery(symbol: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  const norm = symbol.toUpperCase();
  const compact = norm.replace(/[^A-Z0-9]/g, "");
  const qCompact = q.replace(/[^A-Z0-9]/g, "");
  if (!qCompact) return true;
  if (compact.includes(qCompact)) return true;
  return currenciesOf(symbol).some((c) => c.includes(qCompact));
}

/**
 * THE single filtering predicate. Pure, so the grid, the pill badges and the
 * "N of M shown" counter can never disagree about what is visible.
 *
 * Precedence, in order:
 *   1. `favoritesOnly`  → favorites win over every other rule.
 *   2. hidden           → excluded, unless it is also a favorite.
 *   3. class isolation  → empty class set means no isolation.
 *   4. text query       → substring match on symbol / legs / compact form.
 */
export function isSymbolVisible(
  symbol: string,
  state: AssetFilterState,
): boolean {
  const favSet = new Set(state.favorites);
  if (state.favoritesOnly) return favSet.has(symbol);

  if (state.hidden.includes(symbol) && !favSet.has(symbol)) return false;

  const classes = sanitizeAssetClasses(state.classes);
  if (classes.length > 0 && !classes.includes(classOfSymbol(symbol))) return false;

  return matchesQuery(symbol, state.query);
}

/** Apply the full filter to a symbol list, preserving input order. */
export function applyAssetFilter(
  symbols: string[],
  state: AssetFilterState,
): string[] {
  return symbols.filter((sym) => isSymbolVisible(sym, state));
}

/**
 * How many symbols each class pill should advertise, given the rest of the
 * active filter state. Classes the operator has isolated are counted against
 * the OTHER predicates only — otherwise toggling "Real" would report "0" on
 * every pill and look like a dead control.
 */
export function countVisibleByClass(
  symbols: string[],
  state: AssetFilterState,
): Record<AssetClass, number> {
  const counts: Record<AssetClass, number> = { otc: 0, real: 0, crypto: 0 };
  for (const sym of symbols) {
    if (!isSymbolVisible(sym, { ...state, classes: [] })) continue;
    counts[classOfSymbol(sym)] += 1;
  }
  return counts;
}

/** Total visible count, for the "N of M" readout. */
export function countVisible(symbols: string[], state: AssetFilterState): number {
  return applyAssetFilter(symbols, state).length;
}

/** True when the filter would hide at least one symbol (drives the "Clear" affordance). */
export function isFilterActive(state: AssetFilterState): boolean {
  return (
    sanitizeAssetClasses(state.classes).length > 0 ||
    state.favoritesOnly ||
    state.hidden.length > 0 ||
    normalizeQuery(state.query) !== ""
  );
}

/** Toggle a symbol in a favorites/hidden list, preserving canonical order. */
export function toggleSymbol(list: string[], symbol: string): string[] {
  const norm = symbol.trim().toUpperCase();
  const next = list.includes(norm)
    ? list.filter((s) => s !== norm)
    : [...list, norm];
  return sanitizeSymbolList(next);
}
