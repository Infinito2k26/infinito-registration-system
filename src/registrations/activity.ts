import { ActivityType, Prisma } from '@prisma/client';

export interface ActivityEntry {
  registrationId: string;
  type: ActivityType;
  actorId?: string | null;
  details?: Prisma.InputJsonValue;
}

/** Appends to RegistrationActivity. Pass the transaction client so history commits with the change. */
export async function recordActivity(
  db: Prisma.TransactionClient,
  entries: ActivityEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.registrationActivity.createMany({ data: entries });
}
