"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Zap } from "lucide-react";
import apiClient from "@/services/api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Use the tunnel-aware apiClient (relative /api/v1 on Dev Tunnels,
      // proxied through Next.js rewrites — never hardcoded localhost).
      const data = await apiClient.login(email, password);
      localStorage.setItem("token", data.token);
      router.push("/");
    } catch (err) {
      alert("Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-app p-4 text-ink">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl"
      />
      <div className="relative w-full max-w-md space-y-8 tp-card p-8">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-primary shadow-glow-bull">
            <Zap className="fill-current text-white" size={24} />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            Log in to your alpha stream terminal
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="login-email"
                className="mb-2 block text-xs font-bold uppercase tracking-wider text-ink-faint"
              >
                Email Address
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                className="tp-input w-full"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="mb-2 block text-xs font-bold uppercase tracking-wider text-ink-faint"
              >
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                className="tp-input w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="tp-btn tp-btn-primary w-full py-3"
          >
            {loading ? "Authenticating..." : "Sign In"}
          </button>

          <div className="text-center">
            <Link
              href="/register"
              className="text-sm text-ink-muted transition-colors hover:text-primary"
            >
              Don&apos;t have an account? Register
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
