-- AlterTable
ALTER TABLE "alliance_snapshots" ADD COLUMN     "scanned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "lord_snapshots" ADD COLUMN     "scanned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "roster_snapshots" ADD COLUMN     "scanned_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "snapshot_metrics" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "subject_type" VARCHAR(16) NOT NULL,
    "subject_id" TEXT NOT NULL DEFAULT '',
    "section" VARCHAR(64) NOT NULL DEFAULT '',
    "label" VARCHAR(160) NOT NULL,
    "value_text" TEXT,
    "value_number" DOUBLE PRECISION,
    "unit" VARCHAR(16),

    CONSTRAINT "snapshot_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lord_achievements" (
    "id" TEXT NOT NULL,
    "lord_snapshot_id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "progress" BIGINT,
    "target" BIGINT,
    "completed_text" TEXT,
    "completed_at" DATE,

    CONSTRAINT "lord_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lord_name_history" (
    "id" TEXT NOT NULL,
    "lord_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "first_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lord_name_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "snapshot_metrics_snapshot_id_subject_type_idx" ON "snapshot_metrics"("snapshot_id", "subject_type");

-- CreateIndex
CREATE INDEX "snapshot_metrics_snapshot_id_subject_id_idx" ON "snapshot_metrics"("snapshot_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_metrics_snapshot_id_subject_type_subject_id_sectio_key" ON "snapshot_metrics"("snapshot_id", "subject_type", "subject_id", "section", "label");

-- CreateIndex
CREATE UNIQUE INDEX "lord_achievements_lord_snapshot_id_name_key" ON "lord_achievements"("lord_snapshot_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "lord_name_history_lord_id_name_key" ON "lord_name_history"("lord_id", "name");

-- AddForeignKey
ALTER TABLE "snapshot_metrics" ADD CONSTRAINT "snapshot_metrics_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "roster_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lord_achievements" ADD CONSTRAINT "lord_achievements_lord_snapshot_id_fkey" FOREIGN KEY ("lord_snapshot_id") REFERENCES "lord_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lord_name_history" ADD CONSTRAINT "lord_name_history_lord_id_fkey" FOREIGN KEY ("lord_id") REFERENCES "lords"("id") ON DELETE CASCADE ON UPDATE CASCADE;
