import { create } from "zustand";
import apiClient from "@/services/api";

// ── Types ──

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthState {
  /** Authenticated user (null if not logged in) */
  user: User | null;

  /** JWT token */
  token: string | null;

  /** Whether auth is being initialised */
  isLoading: boolean;

  /** Error string from last auth operation */
  error: string | null;

  // ── Actions ──
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => void;
  hydrate: () => void;
  clearError: () => void;
}

// ── Store ──

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isLoading: false,
  error: null,

  // ── Login ──
  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const { token, user } = await apiClient.login(email, password);
      localStorage.setItem("token", token);
      set({ user, token, isLoading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      set({ error: message, isLoading: false });
    }
  },

  // ── Register ──
  register: async (email: string, password: string, name?: string) => {
    set({ isLoading: true, error: null });
    try {
      const { token, user } = await apiClient.register(email, password, name);
      localStorage.setItem("token", token);
      set({ user, token, isLoading: false });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Registration failed";
      set({ error: message, isLoading: false });
    }
  },

  // ── Logout ──
  logout: () => {
    localStorage.removeItem("token");
    set({ user: null, token: null, error: null });
  },

  // ── Hydrate from localStorage on mount ──
  hydrate: () => {
    const token = localStorage.getItem("token");
    if (token) {
      // Decode JWT payload to extract user info
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        set({
          token,
          user: {
            id: payload.id || payload.sub || "",
            email: payload.email || "",
            name: payload.name || null,
          },
        });
      } catch {
        localStorage.removeItem("token");
        set({ token: null, user: null });
      }
    }
  },

  // ── Clear error ──
  clearError: () => set({ error: null }),
}));
