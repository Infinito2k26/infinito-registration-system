-- Expected (planned) arrival/departure dates from the form, and participant gate blocking.
-- Data-preserving: the existing form text columns are RENAMED, not dropped.

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'BLOCKED';
ALTER TYPE "ActivityType" ADD VALUE 'UNBLOCKED';

-- Participant block
ALTER TABLE "Person" ADD COLUMN "blockReason" TEXT,
ADD COLUMN "blockedAt" TIMESTAMP(3),
ADD COLUMN "blockedById" UUID;

-- Form "Check In Date" / "Check Out Date" are planned dates, not gate times.
ALTER TABLE "Registration" RENAME COLUMN "accommodationCheckIn" TO "expectedArrivalText";
ALTER TABLE "Registration" RENAME COLUMN "accommodationCheckOut" TO "expectedDepartureText";
ALTER TABLE "Registration" ADD COLUMN "expectedArrivalDate" DATE,
ADD COLUMN "expectedDepartureDate" DATE;

-- CreateIndex
CREATE INDEX "Person_blockedAt_idx" ON "Person"("blockedAt");
CREATE INDEX "Registration_expectedArrivalDate_idx" ON "Registration"("expectedArrivalDate");
CREATE INDEX "Registration_expectedDepartureDate_idx" ON "Registration"("expectedDepartureDate");

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill parsed dates from the existing text, per row, never failing the migration.
-- Same formats as parseExpectedDate() in src/forms/form-response.parser.ts: YYYY-MM-DD,
-- ISO timestamps (converted to India time), and DD/MM/YYYY (also with - or .).
-- Anything else stays text only and is parsed on the next resync.
CREATE FUNCTION pg_temp.infinito_parse_date(t TEXT) RETURNS DATE AS $$
BEGIN
  t := btrim(t);
  IF t ~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN t::date; END IF;
  IF t ~ '^\d{4}-\d{2}-\d{2}T' THEN RETURN (t::timestamptz AT TIME ZONE 'Asia/Kolkata')::date; END IF;
  IF t ~ '^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$' THEN
    RETURN make_date(
      split_part(regexp_replace(t, '[.-]', '/', 'g'), '/', 3)::int,
      split_part(regexp_replace(t, '[.-]', '/', 'g'), '/', 2)::int,
      split_part(regexp_replace(t, '[.-]', '/', 'g'), '/', 1)::int);
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

UPDATE "Registration"
SET "expectedArrivalDate" = pg_temp.infinito_parse_date("expectedArrivalText")
WHERE "expectedArrivalText" IS NOT NULL;

UPDATE "Registration"
SET "expectedDepartureDate" = pg_temp.infinito_parse_date("expectedDepartureText")
WHERE "expectedDepartureText" IS NOT NULL;
