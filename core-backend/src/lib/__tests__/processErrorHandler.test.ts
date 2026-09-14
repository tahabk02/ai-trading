import { describe, it, expect } from "vitest";
import { createProcessErrorReporter } from "../processErrorHandler";

function epipeError(): Error {
  const err = new Error("write EPIPE");
  Object.defineProperty(err, "code", { value: "EPIPE", enumerable: true });
  return err;
}

describe("createProcessErrorReporter — EPIPE handling", () => {
  it("logs the FIRST EPIPE per kind, then silences that kind (test_epipe_is_ignored)", () => {
    const reporter = createProcessErrorReporter({ now: () => 0 });

    const first = reporter.report("stdout", epipeError());
    expect(first.isEpipe).toBe(true);
    expect(first.shouldLog).toBe(true);
    expect(first.correlationId.length).toBeGreaterThan(0);
    expect(first.correlationId).toBe(first.correlationId); // stable string

    const second = reporter.report("stdout", epipeError());
    expect(second.isEpipe).toBe(true);
    expect(second.shouldLog).toBe(false);

    const third = reporter.report("stdout", epipeError());
    expect(third.shouldLog).toBe(false);
  });

  it("tracks EPIPE silencing independently per kind", () => {
    const reporter = createProcessErrorReporter({ now: () => 0 });

    const stdoutFirst = reporter.report("stdout", epipeError());
    const stdoutSecond = reporter.report("stdout", epipeError());
    const stderrFirst = reporter.report("stderr", epipeError());

    expect(stdoutFirst.shouldLog).toBe(true);
    expect(stdoutSecond.shouldLog).toBe(false);
    expect(stderrFirst.shouldLog).toBe(true); // other kind still announces once
  });

  it("detects EPIPE from the message pattern even without a code", () => {
    const reporter = createProcessErrorReporter({ now: () => 0 });
    const report = reporter.report("uncaughtException", new Error("write EPIPE on socket"));
    expect(report.isEpipe).toBe(true);
    expect(report.shouldLog).toBe(true);
  });
});

describe("createProcessErrorReporter — non-EPIPE rate limiting", () => {
  it("logs the first error, rate-limits repeats within the window (test_other_errors_are_logged)", () => {
    let t = 0;
    const reporter = createProcessErrorReporter({ now: () => t });

    const first = reporter.report("unhandledRejection", new Error("boom 1"));
    expect(first.isEpipe).toBe(false);
    expect(first.shouldLog).toBe(true);

    t = 1_000; // inside the 5s window
    const second = reporter.report("unhandledRejection", new Error("boom 2"));
    expect(second.isEpipe).toBe(false);
    expect(second.shouldLog).toBe(false);

    t = 1_000;
    const third = reporter.report("unhandledRejection", new Error("boom 3"));
    expect(third.shouldLog).toBe(false);

    t = 5_100; // past the window
    const fourth = reporter.report("unhandledRejection", new Error("boom 4"));
    expect(fourth.isEpipe).toBe(false);
    expect(fourth.shouldLog).toBe(true);
  });

  it("rate-limits each kind independently", () => {
    let t = 0;
    const reporter = createProcessErrorReporter({ now: () => t });

    expect(reporter.report("stderr", new Error("a")).shouldLog).toBe(true);
    expect(reporter.report("stderr", new Error("b")).shouldLog).toBe(false);
    // a different kind is not starved by stderr's window
    expect(reporter.report("uncaughtException", new Error("c")).shouldLog).toBe(true);
  });

  it("honours a custom rateLimitMs window", () => {
    let t = 0;
    const reporter = createProcessErrorReporter({ now: () => t, rateLimitMs: 100 });

    expect(reporter.report("stdout", new Error("x")).shouldLog).toBe(true);
    t = 90;
    expect(reporter.report("stdout", new Error("y")).shouldLog).toBe(false);
    t = 101;
    expect(reporter.report("stdout", new Error("z")).shouldLog).toBe(true);
  });
});