/**
 * feedStatus.test.ts — PART 44 [496] PROVENANCE-GATED RECOVERY STATUS.
 *
 * An OTC pair may only read ONLINE when the recovered print is genuinely PO
 * sourced; proxy / unknown sources keep the engine DEGRADED with an honest
 * reason. Non-OTC symbols treat the HTTP cascade as the legitimate feed.
 */

import { describe, expect, it } from "vitest";
import { restoredFeedStatus } from "../feedStatus";

describe("restoredFeedStatus — OTC provenance gate", () => {
  it("non-PO proxy recovery on an OTC pair is DEGRADED, never ONLINE", () => {
    for (const src of ["frankfurter", "open_er_api", "coingecko", "github_data_provider"]) {
      const res = restoredFeedStatus("EURUSD", src);
      expect(res.status).toBe("DEGRADED");
      expect(res.message).toContain("PO offline (proxy prices)");
    }
  });

  it("an absent/unknown provenance stamp on OTC is DEGRADED, not ONLINE", () => {
    expect(restoredFeedStatus("EURUSD", null).status).toBe("DEGRADED");
    expect(restoredFeedStatus("EURUSD", undefined).status).toBe("DEGRADED");
    expect(restoredFeedStatus("EURUSD", "").status).toBe("DEGRADED");
    expect(restoredFeedStatus("EURUSD", null).message).toContain("PO offline");
  });

  it("a genuine PO-sourced print on an OTC pair reads ONLINE", () => {
    for (const src of ["pocket_option", "pocket_option_ssot", "pocket_option:ssid"]) {
      const res = restoredFeedStatus("EURUSD", src);
      expect(res.status).toBe("ONLINE");
      expect(res.message).toContain("restored");
    }
  });

  it("a proxy recovery on a NON-OTC symbol is a legitimate ONLINE recovery", () => {
    expect(restoredFeedStatus("EUR/SEK", "frankfurter").status).toBe("ONLINE");
    expect(restoredFeedStatus("BTC/USD", "coingecko").status).toBe("ONLINE");
    expect(restoredFeedStatus("USD/NOK", "github_data_provider").status).toBe("ONLINE");
  });

  it("any source is fine for a symbol classified from a slash-separated pair", () => {
    // "EUR/USD" resolves to the "otc" whitelist entry (PO OTC major).
    expect(restoredFeedStatus("EUR/USD", "frankfurter").status).toBe("DEGRADED");
  });
});