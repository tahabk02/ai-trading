import { useEffect, useCallback, useRef } from "react";
import { create } from "zustand";

// --- DATA CONTRACT ---
export interface RadarSignal {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  entry_price: number;
  take_profit: number;
  stop_loss: number;
  confidence_score: number;
  timestamp: string;
  reasoning: {
    adx_value: number;
    market_regime: string;
    ml_probability: number;
    logic_audit: string;
  };
}

interface SignalStore {
  signals: RadarSignal[];
  lastSignal: RadarSignal | null;
  addSignal: (signal: RadarSignal) => void;
}

export const useSignalStore = create<SignalStore>((set) => ({
  signals: [],
  lastSignal: null,
  addSignal: (signal) =>
    set((state) => ({
      signals: [signal, ...state.signals].slice(0, 100),
      lastSignal: signal,
    })),
}));

// --- CUSTOM HOOK ---
export const useSignals = (_wsUrl: string) => {
  const addSignal = useSignalStore((state) => state.addSignal);
  const socketRef = useRef<null>(null);
  const connectingRef = useRef(false);

  const playNotification = useCallback(() => {
    try {
      const audio = new Audio("/notification.mp3");
      audio.volume = 0.5;
      audio.play();
    } catch (error) {
      console.warn("Audio notification failed:", error);
    }
  }, []);

  // This hook is disabled — the backend on port 4000 is Python FastAPI
  // (HTTP REST only). Socket.io is not available. Use useWebSocket.ts
  // for HTTP polling instead.
  useEffect(() => {
    console.info(
      "%c[RADAR]%c Socket.io unavailable on port 4000 (FastAPI HTTP only). Using HTTP polling from useWebSocket instead.",
      "color:#f59e0b;font-weight:bold",
      "color:#94a3b8",
    );
    return () => {};
  }, []);

  return { socket: socketRef.current };
};
