-- CreateEnum
CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'READY');

-- AlterTable
ALTER TABLE "EmailOutbox" ADD COLUMN     "noticeRecipientId" UUID;

-- CreateTable
CREATE TABLE "Notice" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticeRecipient" (
    "id" UUID NOT NULL,
    "noticeId" UUID NOT NULL,
    "personId" UUID,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outboxId" UUID,
    "queuedAt" TIMESTAMP(3),

    CONSTRAINT "NoticeRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticeEvent" (
    "id" UUID NOT NULL,
    "noticeId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoticeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notice_createdAt_idx" ON "Notice"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NoticeRecipient_outboxId_key" ON "NoticeRecipient"("outboxId");

-- CreateIndex
CREATE INDEX "NoticeRecipient_personId_idx" ON "NoticeRecipient"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "NoticeRecipient_noticeId_email_key" ON "NoticeRecipient"("noticeId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "NoticeRecipient_noticeId_personId_key" ON "NoticeRecipient"("noticeId", "personId");

-- CreateIndex
CREATE INDEX "NoticeEvent_noticeId_createdAt_idx" ON "NoticeEvent"("noticeId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_noticeRecipientId_idx" ON "EmailOutbox"("noticeRecipientId");

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_noticeRecipientId_fkey" FOREIGN KEY ("noticeRecipientId") REFERENCES "NoticeRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeRecipient" ADD CONSTRAINT "NoticeRecipient_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeRecipient" ADD CONSTRAINT "NoticeRecipient_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeRecipient" ADD CONSTRAINT "NoticeRecipient_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "EmailOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeEvent" ADD CONSTRAINT "NoticeEvent_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeEvent" ADD CONSTRAINT "NoticeEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

