"use client";

import { useEffect, useCallback } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { useRouter } from "next/navigation";

/**
 * useAuth
 *
 * A hook that wraps the Zustand auth store with Next.js router awareness.
 * Call `protect()` in layouts or pages that require authentication.
 */
export function useAuth() {
  const router = useRouter();

  const {
    user,
    token,
    isLoading,
    error,
    login,
    register,
    logout,
    hydrate,
    clearError,
  } = useAuthStore();

  // ── Hydrate on mount ──
  useEffect(() => {
    hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Redirect helpers ──
  const protect = useCallback(
    (redirectTo = "/register") => {
      if (!isLoading && !token) {
        router.push(redirectTo);
      }
    },
    [isLoading, token, router],
  );

  const redirectIfAuthenticated = useCallback(
    (redirectTo = "/") => {
      if (token && !isLoading) {
        router.push(redirectTo);
      }
    },
    [token, isLoading, router],
  );

  // ── Auth actions ──
  const handleLogin = useCallback(
    async (email: string, password: string) => {
      await login(email, password);
      if (!useAuthStore.getState().error) {
        router.push("/");
      }
    },
    [login, router],
  );

  const handleRegister = useCallback(
    async (email: string, password: string, name?: string) => {
      await register(email, password, name);
      if (!useAuthStore.getState().error) {
        router.push("/");
      }
    },
    [register, router],
  );

  const handleLogout = useCallback(() => {
    logout();
    router.push("/register");
  }, [logout, router]);

  return {
    user,
    token,
    isAuthenticated: !!token,
    isLoading,
    error,
    login: handleLogin,
    register: handleRegister,
    logout: handleLogout,
    protect,
    redirectIfAuthenticated,
    clearError,
  };
}
