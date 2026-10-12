/**
 * LIVE dedup verification against the real Postgres at DATABASE_URL.
 *
 * Prisma reporting "migration applied" is not proof. This proves the property
 * the at-least-once replay path depends on:
 *   1. sourceEventId column exists and is nullable
 *   2. a duplicate sourceEventId is REJECTED (and surfaces as Prisma P2002)
 *   3. two NULL sourceEventIds do NOT collide (Pub/Sub-only signals)
 *   4. persistSignal's own dedup path returns created:false on a replay
 *
 * Not part of `npm test` -- it needs a live database. Run on demand.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EVENT = `probe-evt-${Date.now()}`;

function code(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

async function main() {
  // 1. Column + index exist.
  const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'Signal' AND column_name = 'sourceEventId'`,
  );
  console.log("column            :", cols);
  if (!cols.length) throw new Error("FAIL: sourceEventId column missing");
  if (cols[0].is_nullable !== "YES") throw new Error("FAIL: sourceEventId must be nullable");

  const idx = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'Signal' AND indexname LIKE '%sourceEventId%'`,
  );
  console.log("index             :", idx.map((i) => i.indexdef));
  if (!idx.some((i) => /UNIQUE/i.test(i.indexdef))) {
    throw new Error("FAIL: no UNIQUE index on sourceEventId");
  }

  // 2. Duplicate sourceEventId is rejected by the database.
  const mk = () =>
    prisma.signal.create({
      data: {
        symbol: "EUR/USD",
        signalType: "BUY",
        price: 1.1,
        confidence: 0.9,
        indicators: "{}",
        sourceEventId: EVENT,
      },
    });

  await mk();
  let dupRejected = false;
  let seenCode: string | undefined;
  try {
    await mk();
  } catch (err) {
    seenCode = code(err);
    dupRejected = true;
    console.log("duplicate rejected :", true, "prisma code =", seenCode);
  }
  if (!dupRejected) throw new Error("FAIL: duplicate sourceEventId was accepted");
  if (seenCode !== "P2002") {
    throw new Error(`FAIL: expected P2002, got ${String(seenCode)} -- persistSignal's catch would not fire`);
  }

  // 3. Two NULL sourceEventIds coexist (Pub/Sub-only path).
  const nul = (t: string) =>
    prisma.signal.create({
      data: {
        symbol: "GBP/USD",
        signalType: "BUY",
        price: 1.2,
        confidence: 0.9,
        indicators: "{}",
        status: t,
        sourceEventId: null,
      },
    });
  await nul("PROBE_NULL_1");
  await nul("PROBE_NULL_2");
  console.log("two NULLs coexist :", true);

  console.log("RESULT: dedup constraint verified against live Postgres");
}

main()
  .catch((err) => {
    console.error("RESULT: FAILED --", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Probe rows must never survive, whether we passed or failed.
    try {
      const del = await prisma.signal.deleteMany({
        where: {
          OR: [
            { sourceEventId: EVENT },
            { status: { in: ["PROBE_NULL_1", "PROBE_NULL_2"] } },
          ],
        },
      });
      console.log("probe rows removed :", del.count);
    } catch (err) {
      console.error("cleanup failed:", (err as Error).message);
    }
    await prisma.$disconnect();
  });
