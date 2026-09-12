"use client";

import React from "react";

/**
 * ErrorBoundary — REAL React render/commit error boundary.
 *
 * A class boundary is the ONLY thing that catches errors thrown while a
 * component below it *renders* (or in lifecycle methods / effects during
 * commit). The previous `GlobalErrorBoundary` only attached global
 * window listeners — it never stopped React from unmounting the entire root
 * when a child threw during render, which produced the classic symptom of a
 * totally blank dark screen (the <body> keeps its background but every
 * mounted UI component disappears).
 *
 * By default React tears down the WHOLE tree on an uncaught render error.
 * Wrapping subtrees in this boundary confines the blast radius: a failing
 * chart, order book, or trading panel shows a graceful fallback card instead
 * of blanking the terminal.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered in place of `children` after an error is caught. */
  fallback?: React.ReactNode;
  /** Optional stable key — bump it to force a reset (e.g. on symbol change). */
  resetKey?: string | number;
  /** Log the error to console (default true). */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface the real cause instead of letting silent teardown hide it.
    console.error("[ErrorBoundary] Caught render/commit error:", error, info);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Allow the boundary to recover when the subtree's inputs change (e.g.
    // after switching symbol/timeframe). Avoid a setState-in-render loop by
    // only resetting when the resets key actually changed.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="flex flex-col items-center justify-center gap-2 min-h-[160px] w-full rounded-xl border border-rose-600/40 bg-rose-950/20 p-4 text-center"
        >
          <p className="text-[11px] font-mono text-rose-300 uppercase tracking-widest">
            This panel could not be rendered
          </p>
          <p className="text-[10px] font-mono text-slate-400 max-w-sm break-words">
            {this.state.error?.message ?? "Unknown render error"}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-bold uppercase tracking-wider"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
