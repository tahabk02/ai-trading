"use client";

import { useEffect } from "react";

/**
 * GlobalErrorBoundary
 *
 * A client-side component that attaches global error handlers to silently
 * suppress noise from browser extensions (e.g. MetaMask, wallet connectors)
 * and other non-actionable errors that pollute the console.
 *
 * ── What it catches ──
 *
 * 1. **Unhandled promise rejections** originating from extension code
 *    that tries to inject `window.ethereum` or similar APIs.
 *
 * 2. **Runtime errors** from extensions that are unrelated to our app.
 *
 * ── Strategy ──
 *
 * We check the error message for patterns known to come from browser
 * extensions. If matched, the error is suppressed (no console noise).
 * All other errors pass through normally so genuine bugs remain visible.
 *
 * ── MetaMask / Web3 Safety ──
 *
 * Before relying on `window.ethereum`, we always verify that:
 *   - We are in a browser context (`typeof window !== 'undefined'`)
 *   - The MetaMask extension is actually installed (`window.ethereum` exists)
 * This prevents unhandled runtime errors when users browse without the extension.
 */
const EXTENSION_ERROR_PATTERNS = [
  /ethereum/i,
  /MetaMask/i,
  /window\.ethereum/i,
  /provider not found/i,
  /extension not found/i,
  /Failed to connect to MetaMask/i,
  /walletconnect/i,
  /injected provider/i,
  /WebSocket is closed before the connection is established/i,
  /MaxListenersExceededWarning/i,
  /setMaxListeners/i,
  /chrome-extension:/i,
  /moz-extension:/i,
  /safari-web-extension:/i,
  /monica/i,
  /monica-id/i,
  /monica-version/i,
  // ── Browser-extension RUNTIME MESSAGING noise ──
  // Chrome/Firefox extension messaging channels frequently fire these after a
  // content script has been torn down or a port was closed. Letting them bubble
  // can interrupt the canvas/SVG commit and blank the chart, so they are
  // suppressed as non-actionable extension noise.
  /message port closed before a response was received/i,
  /receiving end does not exist/i,
  /Could not establish connection/i,
  /message channel closed/i,
  /message port closed/i,
  /asynchronous response by returning true, but the message channel closed/i,
  /port (<span class="error">)?\d+.*(disconnected|closed)/i,
  /chrome\.runtime\.sendMessage/i,
  /t\.runtime\.sendMessage/i,
  /The extension may have been removed or disabled/i,
];

function isExtensionError(event: ErrorEvent | PromiseRejectionEvent): boolean {
  let message = "";

  if (event instanceof ErrorEvent) {
    message = event.message ?? "";
    // Also check the source file URL
    if (event.filename) {
      message += ` ${event.filename}`;
    }
  } else if (event instanceof PromiseRejectionEvent) {
    message =
      event.reason?.message ??
      event.reason?.toString?.() ??
      String(event.reason) ??
      "";
  }

  return EXTENSION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function GlobalErrorBoundary() {
  useEffect(() => {
    // ── Intercept unhandled promise rejections ──
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (isExtensionError(event)) {
        event.preventDefault();
        return;
      }
    };

    // ── Intercept runtime errors ──
    const handleError = (event: ErrorEvent) => {
      if (isExtensionError(event)) {
        event.preventDefault();
        return;
      }
    };

    // ── Intercept extension RUNTIME MESSAGING ──
    // Browser extensions communicate over `window.postMessage` / MessagePorts
    // and can broadcast into the page. When a port or content-script target has
    // been torn down, the browser raises an unhandleable messaging exception
    // that, left uncaught, can interrupt the chart canvas/SVG commit and yield a
    // blank rendering state. We stop these messages at the source when they
    // originate from an extension context so they never bubble to the chart.
    const handleMessage = (event: MessageEvent) => {
      // Guard: only consider messages that reference an extension origin or an
      // internal event channel — never touch normal application messages.
      const extOrigin =
        typeof event?.origin === "string" &&
        /^(chrome|moz|safari-web)-extension:/.test(event.origin);
      const extSource =
        (event?.source as unknown as { chrome?: unknown } | null)?.chrome != null ||
        (event?.source as unknown as { mozSourceMap?: unknown } | null)?.mozSourceMap != null;
      if (extOrigin || extSource) {
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("unhandledrejection", handleRejection);
    window.addEventListener("error", handleError);
    window.addEventListener("message", handleMessage, true);

    return () => {
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("error", handleError);
      window.removeEventListener("message", handleMessage, true);
    };
  }, []);

  // This component doesn't render anything visible
  return null;
}

export default GlobalErrorBoundary;
