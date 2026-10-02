import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, StaffRole } from '@prisma/client';

/**
 * Idempotent bootstrap: ensures every address in BOOTSTRAP_ADMIN_EMAILS exists as an
 * active ADMIN (the app does the same on every start). Never deletes or downgrades anyone.
 *
 *   npx prisma db seed
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const emails = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (emails.length === 0) {
    console.log('Seed: BOOTSTRAP_ADMIN_EMAILS is empty; nothing to do.');
    return;
  }
  for (const email of emails) {
    await prisma.staffUser.upsert({
      where: { email },
      create: { email, role: StaffRole.ADMIN },
      update: { role: StaffRole.ADMIN, active: true },
    });
  }
  console.log(`Seed: ensured ${emails.length} admin account(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
