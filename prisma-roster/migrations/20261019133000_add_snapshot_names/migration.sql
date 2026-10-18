-- Per-date names: a rename must not rewrite what an older snapshot says.
-- Nullable, so every row ingested before this column keeps working; readers
-- fall back to the live name on the lord/alliance row until a re-ingest
-- fills the date in.
ALTER TABLE "alliance_snapshots" ADD COLUMN "name" VARCHAR(160);
ALTER TABLE "lord_snapshots" ADD COLUMN "name" VARCHAR(160);
