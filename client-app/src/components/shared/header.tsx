"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useLangContext } from "@/hooks/useLangContext";
import { useAuthStore } from "@/store/useAuthStore";
import { ThemeSwitcher, LanguageSwitcher } from "./theme-lang-switcher";
import {
  LayoutGrid,
  LineChart,
  History,
  ShieldCheck,
  Settings,
  Menu,
  X,
  LogOut,
  LogIn,
} from "lucide-react";
import { cn } from "@/utils/cn";

/**
 * Header — THE SINGLE UNIFIED TOP NAVBAR (terminal + dashboard + settings).
 *
 * The legacy left Sidebar is permanently deleted. All navigation now lives
 * here: desktop renders inline links; mobile/tablet renders a slide-in drawer
 * behind a hamburger toggle. This maximizes chart canvas width on every
 * device and keeps theme / language / status controls in one place.
 *
 * Hydration-safe: the drawer is closed during SSR; route changes and Escape
 * close it on the client only.
 */
export const Header: React.FC = () => {
  // No URL passed — useWebSocket auto-detects Dev Tunnel vs localhost via getBaseUrl.ts
  const { connected } = useWebSocket();
  const { t } = useLangContext();
  const pathname = usePathname();

  const [drawerOpen, setDrawerOpen] = useState(false);

  // ── USER PROFILE (hydration-safe) ──
  // The auth store defaults to user=null on BOTH server and client, so the
  // SSR markup is deterministic. hydrate() restores the JWT session in a
  // post-mount effect (same safe pattern as the socket `connected` state).
  const user = useAuthStore((s) => s.user);
  const hydrateAuth = useAuthStore((s) => s.hydrate);
  const logout = useAuthStore((s) => s.logout);
  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);
  const profileInitial = user
    ? (user.name?.trim()?.[0] ?? user.email.trim()?.[0] ?? "U").toUpperCase()
    : null;

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Escape key closes drawer
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    if (drawerOpen) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [drawerOpen]);

  // Body overflow lock while drawer is open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  // ── HYDRATION-SAFE MOUNT GUARD (legacy Sidebar's successor) ──
  // The navigation shell (top navbar + mobile drawer) replaced the deleted
  // left Sidebar and renders interactive <button> nodes. Any SSR/client DOM
  // discrepancy around those buttons (persisted session restored from
  // localStorage, drawer state, HMR re-mounts) crashes hydration with
  // "Expected server HTML to contain a matching <button> in <div>".
  // isMounted is false on BOTH server and first client render → byte-identical
  // hydration input; the nav mounts exclusively in the browser.
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);
  if (!isMounted) return null; // Prevent SSR vs client DOM mismatch on buttons

  // Localized navigation links (EN/FR/AR/ES)
  const navItems = [
    { label: t("marketTerminal"), href: "/dashboard", icon: LayoutGrid },
    { label: t("proTerminal"), href: "/dashboard/pro", icon: LineChart },
    { label: t("tradingHistory"), href: "/history", icon: History },
    { label: t("riskRules"), href: "/risk-rules", icon: ShieldCheck },
    { label: t("systemSettings"), href: "/settings", icon: Settings },
  ];

  const isActive = (href: string) => {
    if (href === "/dashboard/pro") return pathname === "/dashboard/pro";
    if (href === "/dashboard") return pathname === "/" || pathname === "/dashboard";
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };
  return (
    <>
      <nav className="border-b border-[var(--tp-border)] bg-header-sheen backdrop-blur-xl sticky top-0 z-40 transition-colors duration-150">
        <div className="max-w-full mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-3">
          {/* Left: Hamburger (mobile/tablet) + Branding */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              className="lg:hidden flex items-center justify-center w-9 h-9 rounded-lg bg-obsidian-900 border border-slate-700/60 text-slate-300 hover:text-white transition-colors"
              aria-label={drawerOpen ? t("closeNavigation") : t("openNavigation")}
              aria-expanded={drawerOpen}
            >
              {drawerOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-7 h-7 sm:w-8 sm:h-8 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg flex items-center justify-center shadow-lg shadow-blue-600/20 group-hover:shadow-blue-600/40 transition-shadow duration-300">
                <span className="text-white font-black text-[10px] sm:text-xs">T</span>
              </div>
              <span className="text-slate-100 font-bold text-xs sm:text-sm tracking-widest uppercase hidden sm:inline whitespace-nowrap">
                Alpha.5 Pro
              </span>
            </Link>
          </div>

          {/* Center: Desktop nav links (drawer takes over below lg) */}
          <div className="hidden lg:flex items-center gap-1 flex-1 justify-center min-w-0">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors whitespace-nowrap",
                  isActive(item.href)
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/60 border border-transparent",
                )}
              >
                <item.icon size={14} className="shrink-0" />
                {item.label}
              </Link>
            ))}
          </div>

          {/* Right: Profile + Status + Theme + Language */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* User profile chip */}
            {user ? (
              <div className="hidden md:flex items-center gap-2 pl-2 pr-1 py-1 rounded-xl bg-obsidian-900/70 border border-slate-800">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center shrink-0 shadow-sm shadow-blue-600/30">
                  <span className="text-white font-black text-[10px] leading-none">
                    {profileInitial}
                  </span>
                </div>
                <span className="text-[11px] font-semibold text-slate-300 max-w-[130px] truncate">
                  {user.name?.trim() || user.email}
                </span>
                <button
                  type="button"
                  onClick={() => logout()}
                  title={t("logout")}
                  aria-label={t("logout")}
                  className="flex items-center justify-center w-6 h-6 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  <LogOut size={13} />
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold uppercase tracking-wider bg-emerald-600/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/20 transition-colors"
              >
                <LogIn size={13} />
                {t("signIn")}
              </Link>
            )}
            {/* Engine status */}
            <div className="hidden xs:flex items-center gap-1.5 sm:gap-2 pl-2 sm:pl-3 border-l border-slate-800">
              <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-rose-500"} ${connected ? "animate-pulse" : ""} ${connected ? "shadow-emerald-500/40" : "shadow-rose-500/40"}`} />
              <span className="text-[9px] sm:text-xs uppercase tracking-widest font-bold text-slate-400">
                <span className="hidden xs:inline">{connected ? t("sync") : t("error")}</span>
                <span className="xs:hidden">{connected ? "ON" : "OFF"}</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <LanguageSwitcher />
              <ThemeSwitcher />
            </div>
          </div>
        </div>
      </nav>
      {/* MOBILE / TABLET NAV DRAWER (replaces the deleted left Sidebar) */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-[60] lg:hidden bg-black/60 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={cn(
          "lg:hidden fixed inset-y-0 left-0 z-[65] flex flex-col w-[290px] max-w-[85vw]",
          "bg-obsidian border-r border-slate-800/80",
          "transform transition-transform duration-300 ease-in-out",
          drawerOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-hidden={!drawerOpen}
      >
        {/* Engine status */}
        <div className="shrink-0 mx-3 mt-4 mb-2 px-4 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-2.5">
          <div className="relative">
            <div className={cn("w-2.5 h-2.5 rounded-full", connected ? "bg-emerald-500" : "bg-rose-500")} />
            <div className={cn("absolute inset-0 w-2.5 h-2.5 rounded-full opacity-40", connected ? "bg-emerald-500 animate-ping" : "bg-rose-500")} />
          </div>
          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider leading-none">
            {connected ? t("engineActive") : t("engineOffline")}
          </span>
        </div>

        {/* Navigation links */}
        <div className="flex-1 px-3 overflow-y-auto custom-scrollbar">
          <div className="text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em] px-3 pb-2">
            {t("navigation")}
          </div>
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-4 min-h-[44px] rounded-xl transition-all duration-200 group mb-0.5",
                  active
                    ? "bg-emerald-500/15 text-white border border-emerald-500/30 font-bold"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/40 border border-transparent",
                )}
              >
                <item.icon size={18} className={cn("shrink-0 transition-colors duration-200", active ? "text-emerald-400" : "text-slate-500 group-hover:text-emerald-400")} />
                <span className="text-sm font-semibold tracking-wide">{item.label}</span>
                {active && (
                  <div className="ml-auto w-1 h-4 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
                )}
              </Link>
            );
          })}
        </div>

        {/* Theme + Language convenience */}
        <div className="shrink-0 px-4 py-3 border-t border-slate-800/60 flex items-center justify-between">
          <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">
            {t("appearance")}
          </span>
          <div className="flex items-center gap-1.5">
            <LanguageSwitcher />
            <ThemeSwitcher />
          </div>
        </div>
      </div>
    </>
  );
};

export default Header;