import React from "react";
import { render } from "@testing-library/react";
import { LanguageProvider } from "@/hooks/useLangContext";
import { useMarketTerminalStore } from "@/store/useMarketTerminalStore";
import { useTradingStore } from "@/store/useTradingStore";
import { resetSocket } from "./mocks/socket";

/**
 * Test harness.
 *
 * `LanguageProvider` is MANDATORY, not cosmetic: useLangContext.tsx:86 creates
 * its context as `null` and line 139 returns it verbatim, so any consumer that
 * destructures it (e.g. trading-panel.tsx:83 `const { t, rtl } = useLangContext()`)
 * throws a TypeError without a provider.
 *
 * Both Zustand stores are module-level singletons with no reset action. We
 * snapshot pristine state at module load and restore with `replace: true`,
 * which isolates tests WITHOUT editing either store.
 */

const pristineTerminal = useMarketTerminalStore.getState();
const pristinePro = useTradingStore.getState();

export function resetStores() {
  localStorage.clear();
  useMarketTerminalStore.setState(pristineTerminal, true);
  useTradingStore.setState(pristinePro, true);
}

export function resetAll() {
  resetStores();
  resetSocket();
}

/** render() wrapped in the providers a component actually needs at runtime. */
export function ui(children: React.ReactNode) {
  return render(<LanguageProvider>{children}</LanguageProvider>);
}
