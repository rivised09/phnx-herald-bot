-- CreateTable
CREATE TABLE "source_servers" (
    "id" TEXT NOT NULL,
    "server_number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_snapshots" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "minimum_power" INTEGER NOT NULL DEFAULT 0,
    "lord_count" INTEGER NOT NULL DEFAULT 0,
    "alliance_count" INTEGER NOT NULL DEFAULT 0,
    "source_url" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'COMPLETE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alliances" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alliances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lords" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "source_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alliance_snapshots" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "alliance_id" TEXT NOT NULL,
    "power" BIGINT NOT NULL,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,

    CONSTRAINT "alliance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lord_snapshots" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "lord_id" TEXT NOT NULL,
    "alliance_id" TEXT,
    "power" BIGINT NOT NULL,
    "rank" INTEGER,

    CONSTRAINT "lord_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_servers_server_number_key" ON "source_servers"("server_number");

-- CreateIndex
CREATE INDEX "roster_snapshots_server_id_snapshot_date_idx" ON "roster_snapshots"("server_id", "snapshot_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "roster_snapshots_server_id_snapshot_date_key" ON "roster_snapshots"("server_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "alliances_server_id_name_key" ON "alliances"("server_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "lords_server_id_source_id_key" ON "lords"("server_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "alliance_snapshots_snapshot_id_alliance_id_key" ON "alliance_snapshots"("snapshot_id", "alliance_id");

-- CreateIndex
CREATE INDEX "lord_snapshots_alliance_id_idx" ON "lord_snapshots"("alliance_id");

-- CreateIndex
CREATE UNIQUE INDEX "lord_snapshots_snapshot_id_lord_id_key" ON "lord_snapshots"("snapshot_id", "lord_id");

-- AddForeignKey
ALTER TABLE "roster_snapshots" ADD CONSTRAINT "roster_snapshots_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "source_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alliances" ADD CONSTRAINT "alliances_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "source_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lords" ADD CONSTRAINT "lords_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "source_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alliance_snapshots" ADD CONSTRAINT "alliance_snapshots_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "roster_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alliance_snapshots" ADD CONSTRAINT "alliance_snapshots_alliance_id_fkey" FOREIGN KEY ("alliance_id") REFERENCES "alliances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lord_snapshots" ADD CONSTRAINT "lord_snapshots_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "roster_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lord_snapshots" ADD CONSTRAINT "lord_snapshots_lord_id_fkey" FOREIGN KEY ("lord_id") REFERENCES "lords"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lord_snapshots" ADD CONSTRAINT "lord_snapshots_alliance_id_fkey" FOREIGN KEY ("alliance_id") REFERENCES "alliances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
