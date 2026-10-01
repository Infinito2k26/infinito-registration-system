import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { StaffRole, StaffUser } from '@prisma/client';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { AppConfig } from '../config/app-config.service';
import { EmailTemplate } from '../emails/email-templates';
import { EmailOutboxService } from '../emails/email-outbox.service';
import { EmailWorkerService } from '../emails/email-worker.service';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthStaff {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
  sessionId: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const SEEN_UPDATE_MS = 5 * 60 * 1000;
const LOGIN_LINK_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly worker: EmailWorkerService,
    private readonly config: AppConfig,
  ) {}

  /** Ensures BOOTSTRAP_ADMIN_EMAILS exist as active admins, so the first login is possible. */
  async onApplicationBootstrap() {
    for (const email of this.config.bootstrapAdminEmails) {
      await this.prisma.staffUser.upsert({
        where: { email },
        create: { email, role: StaffRole.ADMIN },
        update: { role: StaffRole.ADMIN, active: true },
      });
    }
  }

  /**
   * Emails a single-use sign-in link if the address belongs to active staff.
   * Callers always show the same response, so this cannot be used to discover staff emails.
   */
  async requestLoginLink(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const staff = await this.prisma.staffUser.findUnique({ where: { email } });
    if (!staff?.active) {
      this.logger.warn(`Login link requested for unknown/inactive ${email}`);
      return;
    }
    const ttlMinutes = this.config.magicLinkTtlMinutes;
    // Per-account cooldown on top of the per-IP throttle, so a staff inbox (and the email
    // quota) cannot be flooded from many IPs. The previous link stays valid meanwhile.
    const issuedAt = staff.tokenExpiry ? staff.tokenExpiry.getTime() - ttlMinutes * 60_000 : 0;
    if (Date.now() - issuedAt < LOGIN_LINK_COOLDOWN_MS) {
      this.logger.warn(`Login link for ${email} requested again within cooldown; not sent`);
      return;
    }
    const token = newToken();
    const tokenHash = sha256(token);
    await this.prisma.$transaction(async (tx) => {
      await tx.staffUser.update({
        where: { id: staff.id },
        data: { magicTokenHash: tokenHash, tokenExpiry: new Date(Date.now() + ttlMinutes * 60_000) },
      });
      await this.outbox.enqueue(
        [
          {
            idempotencyKey: `staff-login:${staff.id}:${tokenHash.slice(0, 16)}`,
            toEmail: staff.email,
            subject: 'Your Infinito staff sign-in link',
            template: EmailTemplate.StaffLogin,
            payload: {
              name: staff.name ?? '',
              ttlMinutes,
              url: `${this.config.baseUrl}/auth/magic?token=${encodeURIComponent(token)}`,
            },
          },
        ],
        tx,
      );
    });
    this.worker.kick();
  }

  /** Consumes a magic-link token and returns a new session token, or null if invalid/expired/used. */
  async signIn(token: string): Promise<{ sessionToken: string; staff: StaffUser } | null> {
    const tokenHash = sha256(token);
    const staff = await this.prisma.staffUser.findUnique({ where: { magicTokenHash: tokenHash } });
    if (!staff || !staff.active || !staff.tokenExpiry || staff.tokenExpiry < new Date()) return null;

    // Clearing the hash conditionally makes the link single-use even under double submits.
    const consumed = await this.prisma.staffUser.updateMany({
      where: { id: staff.id, magicTokenHash: tokenHash },
      data: { magicTokenHash: null, tokenExpiry: null },
    });
    if (consumed.count === 0) return null;

    const sessionToken = newToken();
    await this.prisma.staffSession.create({
      data: {
        staffUserId: staff.id,
        tokenHash: sha256(sessionToken),
        expiresAt: new Date(Date.now() + this.config.sessionTtlHours * 3_600_000),
      },
    });
    return { sessionToken, staff };
  }

  async resolveSession(sessionToken: string): Promise<AuthStaff | null> {
    const session = await this.prisma.staffSession.findUnique({
      where: { tokenHash: sha256(sessionToken) },
      include: { staffUser: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.staffUser.active) {
      return null;
    }
    if (Date.now() - session.lastSeenAt.getTime() > SEEN_UPDATE_MS) {
      await this.prisma.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    const { id, email, name, role } = session.staffUser;
    return { id, email, name, role, sessionId: session.id };
  }

  async signOut(sessionId: string) {
    await this.prisma.staffSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Per-session CSRF token; stateless (HMAC of the session ID). */
  csrfToken(sessionId: string): string {
    return createHmac('sha256', this.config.appSecret).update(`csrf:${sessionId}`).digest('base64url');
  }

  checkCsrf(sessionId: string, provided: unknown): boolean {
    if (typeof provided !== 'string') return false;
    const expected = Buffer.from(this.csrfToken(sessionId));
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
