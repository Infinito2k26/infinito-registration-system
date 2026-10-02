-- DropIndex
DROP INDEX "Person_email_idx";

-- DropIndex
DROP INDEX "Person_qrTokenHash_key";

-- AlterTable
ALTER TABLE "EmailOutbox" ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "providerMessageId" TEXT;

-- AlterTable
ALTER TABLE "Person" DROP COLUMN "idDocumentUrl",
DROP COLUMN "photoUrl",
DROP COLUMN "qrTokenHash",
ADD COLUMN     "emailBounceReason" TEXT,
ADD COLUMN     "emailBouncedAt" TIMESTAMP(3),
ADD COLUMN     "idDocumentDriveId" TEXT,
ADD COLUMN     "photoDriveId" TEXT,
ADD COLUMN     "profileCompletedAt" TIMESTAMP(3),
ADD COLUMN     "profileLastRemindedAt" TIMESTAMP(3),
ADD COLUMN     "profileReminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "profileToken" TEXT,
ADD COLUMN     "qrToken" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "enteredAt" TIMESTAMP(3),
ADD COLUMN     "enteredById" UUID,
ADD COLUMN     "responseId" TEXT;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "responseId" TEXT;

-- CreateTable
CREATE TABLE "VolunteerSession" (
    "id" UUID NOT NULL,
    "volunteerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolunteerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerSession_tokenHash_key" ON "VolunteerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "VolunteerSession_volunteerId_idx" ON "VolunteerSession"("volunteerId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_idempotencyKey_key" ON "EmailOutbox"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_providerMessageId_key" ON "EmailOutbox"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_qrToken_key" ON "Person"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "Person_profileToken_key" ON "Person"("profileToken");

-- CreateIndex
CREATE INDEX "Person_profileCompletedAt_idx" ON "Person"("profileCompletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Registration_eventSlug_personId_key" ON "Registration"("eventSlug", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_eventSlug_responseId_key" ON "Team"("eventSlug", "responseId");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "Volunteer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerSession" ADD CONSTRAINT "VolunteerSession_volunteerId_fkey" FOREIGN KEY ("volunteerId") REFERENCES "Volunteer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

