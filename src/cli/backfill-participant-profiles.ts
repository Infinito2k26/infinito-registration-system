/**
 * Groups EXISTING participants into Aadhaar ParticipantProfiles (one full Aadhaar = one profile).
 * Only Person.participantProfileId is written; registrations, QR tokens, emails, gate logs and
 * activity are never touched (counted before and after). Idempotent; safe to run again.
 *
 *   npm run build && npm run profiles:backfill            # dry run: report only, no writes
 *   npm run profiles:backfill -- --apply                  # link people to profiles
 *
 * Needs DATABASE_URL and AADHAAR_ENCRYPTION_KEY (.env). Run after the 20261010090000 migration.
 */
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/app-config.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ParticipantProfileService } from '../registrations/participant-profile.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AppConfigModule, PrismaModule],
  providers: [ParticipantProfileService],
})
class BackfillModule {}

async function main() {
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(BackfillModule, { logger: ['error', 'warn'] });
  try {
    const r = await app.get(ParticipantProfileService).backfill(apply);
    const row = (label: string, before: number, after: number) => `  ${label.padEnd(28)} ${String(before).padStart(7)} ${String(after).padStart(7)}${before === after ? '' : '   CHANGED'}`;
    console.log(`Participant profile backfill: ${apply ? 'APPLIED' : 'DRY RUN (no changes; add --apply)'}`);
    console.log('\nPreserved records               before   after');
    console.log(row('Registrations', r.before.registrations, r.after.registrations));
    console.log(row('Person records', r.before.people, r.after.people));
    console.log(row('QR tokens', r.before.qrTokens, r.after.qrTokens));
    console.log(row('EmailOutbox records', r.before.emailOutbox, r.after.emailOutbox));
    console.log(row('  of which SENT', r.before.emailOutboxSent, r.after.emailOutboxSent));
    console.log(row('Gate logs (EntryLog)', r.before.entryLogs, r.after.entryLogs));
    console.log(row('Activity records', r.before.activities, r.after.activities));
    console.log('\nGrouping');
    console.log(`  People with a full Aadhaar        ${r.peopleWithFullAadhaar}`);
    console.log(`  People without a readable full #  ${r.peopleWithoutReadableAadhaar} (left unlinked)`);
    console.log(`  Distinct full Aadhaar = profiles  ${r.distinctAadhaar}`);
    console.log(`  Profiles ${apply ? 'created' : 'to create'}               ${r.profilesCreated}`);
    console.log(`  People ${apply ? 'linked' : 'to link'}                   ${r.peopleLinked}`);
    console.log(`  Numbers shared by 2+ people       ${r.groupsWithSeveralPeople} (${r.peopleInSharedGroups} Person records grouped, not merged)`);
    console.log(`  Registrations under a profile     ${r.registrationsLinked}`);
    console.log(`\nAll preserved counts unchanged: ${r.countsUnchanged ? 'YES' : 'NO'}`);
    if (!r.countsUnchanged) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
