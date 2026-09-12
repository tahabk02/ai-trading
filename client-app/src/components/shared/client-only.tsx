"use client";

import React, { useEffect, useState } from "react";

/**
 * CLIENT-ONLY MOUNTING GUARD (parent-level hydration isolation).
 *
 * Renders `fallback` during SSR **and** the browser's first render commit,
 * then swaps to `children` after mount. Because both server HTML and the
 * first client paint produce byte-identical markup (the skeleton), React
 * hydration always succeeds — even when children contain values that can
 * legitimately differ between server and browser (live clocks, locale/TZ-
 * dependent formatting, store state restored from localStorage, canvas /
 * DOM-measuring engines like lightweight-charts, …).
 *
 * RULES for `fallback`:
 *   - Deterministic ONLY: no Date.now(), Math.random(), window/localStorage/
 *     navigator access, random IDs, or Intl/locale-dependent output.
 *   - Must match children's layout dimensions to prevent CLS shift.
 */
interface ClientOnlyProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function ClientOnly({ children, fallback = null }: ClientOnlyProps) {
  // ── hasMounted starts false on BOTH server and client ──
  // useState(false) is deterministic; only the effect below (which never
  // runs on the server) flips it, guaranteeing identical hydration input.
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  return <>{hasMounted ? children : fallback}</>;
}

export default ClientOnly;
