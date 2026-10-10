-- Idempotency key for the durable (Redis Streams) signal transport.
--
-- The stream consumer is AT LEAST ONCE: if it crashes after persisting a
-- signal but before XACK, the entry is reclaimed by XAUTOCLAIM and processed
-- again. Without a unique key that replay writes a second row for one real
-- signal, inflating history and corrupting accuracy accounting.
--
-- The Redis Streams entry id ("<ms>-<seq>") is stable and unique per appended
-- entry, which makes it the natural idempotency key. Nullable so signals that
-- arrive over Pub/Sub only (no stream entry) are unaffected -- and so the
-- unique index does not collapse unrelated rows onto one NULL.
ALTER TABLE "Signal" ADD COLUMN "sourceEventId" TEXT;
CREATE UNIQUE INDEX "Signal_sourceEventId_key" ON "Signal"("sourceEventId");
