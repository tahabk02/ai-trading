"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * PURGED — this QA route previously contained:
 *   • fixtureCandles() — synthetic OHLC generator (seeded PRNG with drift)
 *   • TickPump — setInterval fake tick emitter using Math.random()
 *
 * Both violated the ZERO-MOCK policy. This page now redirects to the live
 * dashboard which uses exclusively real backend data.
 */
export default function QaChartPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);
  return null;
}
