-- CreateEnum
CREATE TYPE "VerificationBatchOutcome" AS ENUM ('VERIFIED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "VerificationBatch" (
    "id" UUID NOT NULL,
    "triggeredById" UUID,
    "selectedCount" INTEGER NOT NULL,
    "verifiedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "qrEmailsQueued" INTEGER NOT NULL DEFAULT 0,
    "noEmailCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationBatchItem" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "registrationId" UUID,
    "personName" TEXT,
    "email" TEXT,
    "eventSlug" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "outcome" "VerificationBatchOutcome" NOT NULL,
    "reason" TEXT,
    "emailOutboxId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationBatch_createdAt_idx" ON "VerificationBatch"("createdAt");

-- CreateIndex
CREATE INDEX "VerificationBatchItem_batchId_idx" ON "VerificationBatchItem"("batchId");

-- CreateIndex
CREATE INDEX "VerificationBatchItem_registrationId_idx" ON "VerificationBatchItem"("registrationId");

-- AddForeignKey
ALTER TABLE "VerificationBatch" ADD CONSTRAINT "VerificationBatch_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationBatchItem" ADD CONSTRAINT "VerificationBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "VerificationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationBatchItem" ADD CONSTRAINT "VerificationBatchItem_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationBatchItem" ADD CONSTRAINT "VerificationBatchItem_emailOutboxId_fkey" FOREIGN KEY ("emailOutboxId") REFERENCES "EmailOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

