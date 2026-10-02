-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('CHECK_IN', 'CHECK_OUT');

-- CreateEnum
CREATE TYPE "EmailBatchKind" AS ENUM ('COLLEGE_EACH', 'COLLEGE_TO_ONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'EMAIL_CHANGED';
ALTER TYPE "ActivityType" ADD VALUE 'QR_EMAIL_BULK_QUEUED';
ALTER TYPE "ActivityType" ADD VALUE 'QR_PASSES_FORWARDED';
ALTER TYPE "ActivityType" ADD VALUE 'CHECKED_OUT';
ALTER TYPE "ActivityType" ADD VALUE 'CHECKOUT_DENIED';

-- AlterTable
ALTER TABLE "EmailOutbox" ADD COLUMN     "batchId" UUID;

-- AlterTable
ALTER TABLE "EntryLog" ADD COLUMN     "kind" "EntryKind" NOT NULL DEFAULT 'CHECK_IN';

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "aadhaarDriveId" TEXT,
ADD COLUMN     "aadhaarLast4" TEXT,
ADD COLUMN     "collegeId" UUID,
ADD COLUMN     "rollNumber" TEXT;

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "accommodation" TEXT,
ADD COLUMN     "accommodationCheckIn" TEXT,
ADD COLUMN     "accommodationCheckOut" TEXT,
ADD COLUMN     "accommodationPeriod" TEXT,
ADD COLUMN     "insideSince" TIMESTAMP(3),
ADD COLUMN     "lastCheckInAt" TIMESTAMP(3),
ADD COLUMN     "lastCheckOutAt" TIMESTAMP(3),
ADD COLUMN     "remark" TEXT;

-- CreateTable
CREATE TABLE "College" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "College_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonEmailAlias" (
    "email" TEXT NOT NULL,
    "personId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonEmailAlias_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "EmailBatch" (
    "id" UUID NOT NULL,
    "kind" "EmailBatchKind" NOT NULL,
    "collegeId" UUID NOT NULL,
    "eventSlug" TEXT,
    "recipientPersonId" UUID,
    "recipientEmail" TEXT,
    "triggeredById" UUID,
    "eligibleCount" INTEGER NOT NULL,
    "queuedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "College_nameKey_key" ON "College"("nameKey");

-- CreateIndex
CREATE INDEX "PersonEmailAlias_personId_idx" ON "PersonEmailAlias"("personId");

-- CreateIndex
CREATE INDEX "EmailBatch_collegeId_createdAt_idx" ON "EmailBatch"("collegeId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_batchId_idx" ON "EmailOutbox"("batchId");

-- CreateIndex
CREATE INDEX "Person_collegeId_idx" ON "Person"("collegeId");

-- CreateIndex
CREATE INDEX "Person_phone_idx" ON "Person"("phone");

-- CreateIndex
CREATE INDEX "Person_rollNumber_idx" ON "Person"("rollNumber");

-- CreateIndex
CREATE INDEX "Registration_insideSince_idx" ON "Registration"("insideSince");

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_collegeId_fkey" FOREIGN KEY ("collegeId") REFERENCES "College"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonEmailAlias" ADD CONSTRAINT "PersonEmailAlias_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "EmailBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailBatch" ADD CONSTRAINT "EmailBatch_collegeId_fkey" FOREIGN KEY ("collegeId") REFERENCES "College"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailBatch" ADD CONSTRAINT "EmailBatch_recipientPersonId_fkey" FOREIGN KEY ("recipientPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailBatch" ADD CONSTRAINT "EmailBatch_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill (data-preserving) -------------------------------------------------
-- Colleges from existing participants. nameKey must match collegeNameKey() in
-- src/registrations/college.ts: trimmed, single spaces, lowercase.
INSERT INTO "College" ("id", "name", "nameKey")
SELECT gen_random_uuid(), MIN(btrim(regexp_replace("college", '\s+', ' ', 'g'))), lower(btrim(regexp_replace("college", '\s+', ' ', 'g')))
FROM "Person"
WHERE "college" IS NOT NULL AND btrim("college") <> ''
GROUP BY lower(btrim(regexp_replace("college", '\s+', ' ', 'g')))
ON CONFLICT ("nameKey") DO NOTHING;

UPDATE "Person" p
SET "collegeId" = c."id"
FROM "College" c
WHERE p."college" IS NOT NULL
  AND c."nameKey" = lower(btrim(regexp_replace(p."college", '\s+', ' ', 'g')));

-- Anyone already marked entered (before check-out existed) is inside.
UPDATE "Registration"
SET "insideSince" = "enteredAt", "lastCheckInAt" = "enteredAt"
WHERE "enteredAt" IS NOT NULL AND "insideSince" IS NULL;
