import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom gap-filling for the components that actually exist in this app.
 *
 * Deliberately NOT stubbed: HTMLCanvasElement.prototype.getContext. jsdom
 * returns null and logs, so any test that transitively pulls in
 * `lightweight-charts` fails loudly and is fixed with an explicit
 * `vi.mock(...)` rather than silently rendering against a null canvas.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// financial-chart.tsx — ResizeObserver -> chart.applyOptions({ width, height })
globalThis.ResizeObserver ??= ResizeObserverStub as never;
globalThis.IntersectionObserver ??= IntersectionObserverStub as never;

// useTheme.tsx — matchMedia("(prefers-color-scheme: dark)")
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as never;
}

// realtimeCandleAggregator — pending-paint queue drains on rAF
globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 16)) as never;
globalThis.cancelAnimationFrame ??= ((id: number) => clearTimeout(id)) as never;

// high-confidence-toast.tsx — WebAudio chime
globalThis.AudioContext ??= (class {
  currentTime = 0;
  state = "running";
  destination = {};
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect() {},
      start() {},
      stop() {},
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  resume() {}
  close() {}
}) as never;

window.scrollTo = (() => {}) as never;

afterEach(() => {
  cleanup();
  localStorage.clear();
});
