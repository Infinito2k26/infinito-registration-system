-- One email address = one participant, case-insensitively, enforced by the database itself
-- (Test@gmail.com and test@gmail.com cannot belong to two people). Emails stay optional:
-- NULLs are not compared. The application already stores emails lowercased; this is the
-- final guard against concurrent writes. Existing rows are not modified.
-- Prisma cannot express expression indexes in schema.prisma and leaves this one alone.
CREATE UNIQUE INDEX "Person_email_lower_key" ON "Person" (lower("email"));
