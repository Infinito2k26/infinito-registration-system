-- Aadhaar-based ParticipantProfile (one full Aadhaar = one profile) and admin registration deletions.
-- Schema only: existing rows are untouched. Profiles for existing data are created by
-- 'npm run profiles:backfill' (needs AADHAAR_ENCRYPTION_KEY; dry run by default).
-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "participantProfileId" UUID;

-- CreateTable
CREATE TABLE "ParticipantProfile" (
    "id" UUID NOT NULL,
    "aadhaarFingerprint" TEXT NOT NULL,
    "aadhaarLast4" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParticipantProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationDeletion" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "eventSlug" TEXT NOT NULL,
    "responseId" TEXT,
    "deletedById" UUID,
    "snapshot" JSONB NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantProfile_aadhaarFingerprint_key" ON "ParticipantProfile"("aadhaarFingerprint");

-- CreateIndex
CREATE INDEX "ParticipantProfile_aadhaarLast4_idx" ON "ParticipantProfile"("aadhaarLast4");

-- CreateIndex
CREATE INDEX "RegistrationDeletion_responseId_eventSlug_personId_idx" ON "RegistrationDeletion"("responseId", "eventSlug", "personId");

-- CreateIndex
CREATE INDEX "Person_participantProfileId_idx" ON "Person"("participantProfileId");

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_participantProfileId_fkey" FOREIGN KEY ("participantProfileId") REFERENCES "ParticipantProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationDeletion" ADD CONSTRAINT "RegistrationDeletion_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

