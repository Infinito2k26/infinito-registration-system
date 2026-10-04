-- Email is optional: a participant without a usable email is still imported.
ALTER TABLE "Person" ALTER COLUMN "email" DROP NOT NULL;

-- Stable form identity for participants created without an email (resync idempotency).
ALTER TABLE "Person" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "Person_sourceKey_key" ON "Person"("sourceKey");

-- "Ever entered" list (Registration.enteredAt = first successful gate check-in).
CREATE INDEX "Registration_enteredAt_idx" ON "Registration"("enteredAt");
