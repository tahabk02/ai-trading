import { describe, expect, it } from "vitest";
import {
  buildExecutionResponse,
  executionDryRunEnabled,
  newExecutionId,
  provenanceFromPriceSource,
  EXECUTION_PROVENANCE,
} from "../executionEngine";

describe("PART 44 [455] executionEngine — unified response contract", () => {
  it("builds a full envelope with sane defaults", () => {
    const env = buildExecutionResponse({ status: "executed", latencyMs: 12.6 });
    expect(env.status).toBe("executed");
    expect(typeof env.executionId).toBe("string");
    expect(env.executionId.length).toBeGreaterThan(0);
    expect(env.provenance).toBe(EXECUTION_PROVENANCE.NONE);
    expect(env.latencyMs).toBe(13); // rounded
    expect(env.error).toBeNull();
    expect(typeof env.timestamp).toBe("string");
    expect("result" in env).toBe(false); // omitted when absent
  });

  it("clamps negative latency and carries provenance + error + result", () => {
    const env = buildExecutionResponse({
      status: "rejected",
      latencyMs: -5,
      provenance: EXECUTION_PROVENANCE.HELD_PRICE,
      error: "held price refused",
      result: { id: "t1" },
    });
    expect(env.latencyMs).toBe(0);
    expect(env.provenance).toBe("held_price");
    expect(env.error).toBe("held price refused");
    expect(env.result).toEqual({ id: "t1" });
  });

  it("newExecutionId returns unique ids", () => {
    const a = newExecutionId();
    const b = newExecutionId();
    expect(a).not.toBe(b);
  });

  it("maps price sources to provenance tags", () => {
    expect(provenanceFromPriceSource("live_ws_tick")).toBe("pocket_option_ws");
    expect(provenanceFromPriceSource("pocket_option_ssot")).toBe(
      "pocket_option_ws",
    );
    expect(provenanceFromPriceSource("pocket_option_held")).toBe("held_price");
    expect(provenanceFromPriceSource("github_repo_cached")).toBe(
      "proxy_fallback",
    );
    expect(provenanceFromPriceSource("frankfurter")).toBe("proxy_fallback");
    expect(provenanceFromPriceSource("")).toBe("none");
    expect(provenanceFromPriceSource(null)).toBe("none");
  });

  it("executionDryRunEnabled obeys EXECUTION_DRY_RUN", () => {
    const before = process.env.EXECUTION_DRY_RUN;
    process.env.EXECUTION_DRY_RUN = "true";
    expect(executionDryRunEnabled()).toBe(true);
    process.env.EXECUTION_DRY_RUN = "0";
    expect(executionDryRunEnabled()).toBe(false);
    if (before === undefined) delete process.env.EXECUTION_DRY_RUN;
    else process.env.EXECUTION_DRY_RUN = before;
  });
});
