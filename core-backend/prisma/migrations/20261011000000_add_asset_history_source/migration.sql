-- PART 44 [494] — DATA PROVENANCE ALL THE WAY DOWN.
--
-- AssetHistory gains an authoring-feed column so every persisted bar names the
-- source that produced it (pocket_option / frankfurter / held_stale_real /
-- github_data_provider / ai_engine / …).
--
-- The live collector now writes OTC bars ONLY from PO-sourced ticks: proxy and
-- held prices never create or modify an OTC bar. Without a provenance stamp a
-- proxy-shaped OTC bar is indistinguishable from a genuine PO one, so the [495]
-- audit cannot find them and downstream consumers cannot withhold a verdict on
-- them. NULL is retained for legacy rows written before this column existed.
ALTER TABLE "AssetHistory" ADD COLUMN "source" TEXT;

CREATE INDEX "AssetHistory_source_idx" ON "AssetHistory"("source");
