-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'FAILED');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ADMIN', 'COORDINATOR', 'VOLUNTEER');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('SUBMITTED', 'UPDATED', 'PAYMENT_VERIFIED', 'PAYMENT_REJECTED', 'PAYMENT_UNVERIFIED', 'QR_EMAIL_QUEUED', 'QR_EMAIL_RESENT', 'ENTERED', 'ENTRY_DENIED');

-- DropForeignKey
ALTER TABLE "EntryLog" DROP CONSTRAINT "EntryLog_volunteerId_fkey";

-- DropForeignKey
ALTER TABLE "Registration" DROP CONSTRAINT "Registration_enteredById_fkey";

-- DropForeignKey
ALTER TABLE "VolunteerSession" DROP CONSTRAINT "VolunteerSession_volunteerId_fkey";

-- AlterTable
ALTER TABLE "EmailOutbox" ADD COLUMN     "deliveryStatus" "EmailDeliveryStatus",
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "registrationId" UUID,
ADD COLUMN     "triggeredById" UUID;

-- AlterTable
ALTER TABLE "EntryLog" ADD COLUMN     "registrationId" UUID;

-- AlterTable
ALTER TABLE "Person" ALTER COLUMN "qrToken" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Registration" DROP COLUMN "verifiedAt",
DROP COLUMN "verifiedBy",
ADD COLUMN     "paymentReviewedAt" TIMESTAMP(3),
ADD COLUMN     "paymentReviewedById" UUID;

-- DropTable
DROP TABLE "Volunteer";

-- DropTable
DROP TABLE "VolunteerSession";

-- CreateTable
CREATE TABLE "RegistrationActivity" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "actorId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "StaffRole" NOT NULL DEFAULT 'VOLUNTEER',
    "magicTokenHash" TEXT,
    "tokenExpiry" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffSession" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegistrationActivity_registrationId_createdAt_idx" ON "RegistrationActivity"("registrationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_magicTokenHash_key" ON "StaffUser"("magicTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "StaffSession_tokenHash_key" ON "StaffSession"("tokenHash");

-- CreateIndex
CREATE INDEX "StaffSession_staffUserId_idx" ON "StaffSession"("staffUserId");

-- CreateIndex
CREATE INDEX "EmailOutbox_registrationId_template_idx" ON "EmailOutbox"("registrationId", "template");

-- CreateIndex
CREATE INDEX "EntryLog_registrationId_idx" ON "EntryLog"("registrationId");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_paymentReviewedById_fkey" FOREIGN KEY ("paymentReviewedById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationActivity" ADD CONSTRAINT "RegistrationActivity_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationActivity" ADD CONSTRAINT "RegistrationActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryLog" ADD CONSTRAINT "EntryLog_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryLog" ADD CONSTRAINT "EntryLog_volunteerId_fkey" FOREIGN KEY ("volunteerId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSession" ADD CONSTRAINT "StaffSession_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

