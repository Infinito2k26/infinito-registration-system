import { Injectable, Logger } from '@nestjs/common';
import { EmailStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Shown to the admin as-is. Nothing was deleted. */
export class RegistrationDeletionError extends Error {}

/**
 * Permanently deletes ONE registration (ADMIN, Duplicate Aadhaar Check only). Kept: the person,
 * their profile, QR token and other registrations; this registration's gate log entries and
 * email history (unlinked: their registration link becomes empty); and a RegistrationDeletion
 * record with a snapshot of the registration and its activity history. Emails still waiting to
 * be sent for it are cancelled. A resync of the same form row does not recreate it.
 */
@Injectable()
export class RegistrationDeletionService {
  private readonly logger = new Logger(RegistrationDeletionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async delete(registrationId: string, actorId: string): Promise<{ eventSlug: string; personName: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const reg = await tx.registration.findUnique({ where: { id: registrationId }, select: { teamId: true } });
      if (!reg) throw new RegistrationDeletionError('Registration not found (already deleted?)');
      // Same lock as Verify / Reject on this form response: no decision runs half-way through a delete.
      if (reg.teamId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'team:' + reg.teamId}))`;
      const full = await tx.registration.findUnique({
        where: { id: registrationId },
        include: {
          person: { select: { id: true, name: true, email: true, participantProfileId: true } },
          team: { select: { id: true, name: true } },
          activities: { orderBy: { createdAt: 'asc' } },
          _count: { select: { entryLogs: true, emails: true } },
        },
      });
      if (!full) throw new RegistrationDeletionError('Registration not found (already deleted?)');
      const { person, team, activities, _count, ...registration } = full;

      const cancelled = await tx.emailOutbox.updateMany({
        where: { registrationId, status: EmailStatus.PENDING },
        data: { status: EmailStatus.CANCELLED },
      });
      await tx.registrationDeletion.create({
        data: {
          registrationId,
          personId: person.id,
          eventSlug: registration.eventSlug,
          responseId: registration.responseId,
          deletedById: actorId,
          snapshot: JSON.parse(
            JSON.stringify({
              registration,
              person,
              team,
              activities,
              keptUnlinked: { entryLogs: _count.entryLogs, emails: _count.emails },
              cancelledQueuedEmails: cancelled.count,
            }),
          ) as Prisma.InputJsonValue,
        },
      });
      if (registration.teamId) {
        await tx.teamMember.deleteMany({ where: { teamId: registration.teamId, personId: person.id } });
      }
      // Activities go with it (copied into the snapshot); gate logs, emails and bulk-verify items stay, unlinked.
      await tx.registration.delete({ where: { id: registrationId } });
      this.logger.log(`Registration ${registrationId} (${registration.eventSlug}) deleted by ${actorId}`);
      return { eventSlug: registration.eventSlug, personName: person.name };
    });
  }
}
