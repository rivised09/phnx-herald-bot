-- AlterTable
ALTER TABLE "discord_channels" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "reminder_message_id" VARCHAR(40);
