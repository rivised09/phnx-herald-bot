-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "guild_id" VARCHAR(40) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "entity_type" TEXT NOT NULL DEFAULT 'EXTERNAL',
    "channel_id" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
    "discord_message_id" VARCHAR(40),
    "discord_event_id" VARCHAR(40),
    "ping_one_hour" BOOLEAN NOT NULL DEFAULT false,
    "ping_thirty_min" BOOLEAN NOT NULL DEFAULT false,
    "ping_ten_min" BOOLEAN NOT NULL DEFAULT false,
    "ping_started" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_status_idx" ON "events"("status");

-- CreateIndex
CREATE INDEX "events_start_time_idx" ON "events"("start_time");

-- CreateIndex
CREATE INDEX "events_guild_id_idx" ON "events"("guild_id");
