/**
 * dbHealth.test.ts — PHASE 5 shared infrastructure-outage classifiers.
 *
 * These predicates gate the 200-empty fallbacks that keep the terminal alive
 * through a cold Postgres/Redis. A FALSE NEGATIVE turns a recoverable outage
 * into a 500; a FALSE POSITIVE would mask a genuine bug as "infra down". Both
 * directions are pinned here.
 */

import { describe, expect, it } from "vitest";
import { isDbUnavailable, isCacheUnavailable } from "../dbHealth";

function coded(code: string, message = "boom"): unknown {
  return Object.assign(new Error(message), { code });
}

describe("isDbUnavailable", () => {
  it.each(["P1001", "P1008", "P1017", "P2024"])(
    "treats Prisma code %s as an outage",
    (code) => {
      expect(isDbUnavailable(coded(code))).toBe(true);
    },
  );

  it("treats a PrismaClientInitializationError as an outage", () => {
    const err = Object.assign(new Error("init failed"), {
      name: "PrismaClientInitializationError",
    });
    expect(isDbUnavailable(err)).toBe(true);
  });

  it("matches a connection-level message with no code", () => {
    expect(isDbUnavailable(new Error("Can't reach database server at localhost:5433"))).toBe(
      true,
    );
  });

  it("does NOT treat a query/validation bug as an outage", () => {
    expect(isDbUnavailable(new Error("Unique constraint failed on the fields: (`id`)"))).toBe(
      false,
    );
    expect(isDbUnavailable(coded("P2002", "unique constraint"))).toBe(false);
  });

  it("tolerates non-error throwables", () => {
    expect(isDbUnavailable(undefined)).toBe(false);
    expect(isDbUnavailable("string")).toBe(false);
  });
});

describe("isCacheUnavailable", () => {
  it.each(["MaxRetriesPerRequestError", "ReplyError", "RedisError"])(
    "treats %s as a cache outage",
    (name) => {
      expect(isCacheUnavailable(Object.assign(new Error("x"), { name }))).toBe(true);
    },
  );

  it("treats NR_CLOSED as a cache outage", () => {
    expect(isCacheUnavailable(coded("NR_CLOSED"))).toBe(true);
  });

  it("matches a Redis connection message", () => {
    expect(isCacheUnavailable(new Error("connect ECONNREFUSED 127.0.0.1:6379"))).toBe(true);
  });

  it("does NOT flag a generic database error as a cache outage", () => {
    expect(isCacheUnavailable(coded("P1001", "Can't reach database server"))).toBe(false);
  });
});
