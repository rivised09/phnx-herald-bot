-- CreateTable
CREATE TABLE "discord_channels" (
    "id" VARCHAR(40) NOT NULL,
    "guild_id" VARCHAR(40) NOT NULL,
    "name" TEXT NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discord_channels_guild_id_idx" ON "discord_channels"("guild_id");

-- CreateIndex
CREATE INDEX "discord_channels_type_idx" ON "discord_channels"("type");