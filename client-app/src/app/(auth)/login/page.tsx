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
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8 bg-slate-900/50 p-8 rounded-2xl border border-slate-800 shadow-2xl backdrop-blur-xl">
        <div className="text-center">
          <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-4">
            <Zap className="text-white fill-current" size={24} />
          </div>
          <h2 className="text-3xl font-extrabold text-white">Welcome back</h2>
          <p className="mt-2 text-sm text-slate-500">
            Log in to your alpha stream terminal
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-2">
                Email Address
              </label>
              <input
                type="email"
                required
                className="w-full bg-black/50 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-2">
                Password
              </label>
              <input
                type="password"
                required
                className="w-full bg-black/50 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-lg transition-all shadow-lg shadow-blue-600/20 disabled:opacity-50"
          >
            {loading ? "Authenticating..." : "Sign In"}
          </button>
          <div className="text-center">
            <Link
              href="/register"
              className="text-sm text-slate-500 hover:text-white transition-colors"
            >
              Don&apos;t have an account? Register
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
