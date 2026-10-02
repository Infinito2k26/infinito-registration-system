import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import request, { Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { EmailWorkerService } from '../src/emails/email-worker.service';
import { PrismaService } from '../src/prisma/prisma.service';

export interface Staff {
  cookie: string;
  csrf: string;
  id: string;
}

/** Boots the real AppModule on one listening port (stable Host, like a browser). */
export async function startApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app);
  await app.init();
  const server = app.getHttpServer();
  server.setMaxListeners(50);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    app,
    http: request(server),
    prisma: app.get(PrismaService),
    worker: app.get(EmailWorkerService),
    auth: app.get(AuthService),
  };
}

export type Ctx = Awaited<ReturnType<typeof startApp>>;

export async function resetDatabase(ctx: Ctx) {
  const throttle = ctx.app.get<ThrottlerStorageService>(ThrottlerStorage) as unknown as Record<
    'storage' | 'hitExpirations',
    Map<string, unknown> | undefined
  >;
  throttle.storage?.clear();
  throttle.hitExpirations?.clear();
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE "RegistrationActivity","EmailOutbox","EmailBatch","EntryLog","Registration","TeamMember","Team","PersonEmailAlias","Person","College","StaffSession","StaffUser" CASCADE',
  );
}

/** Signs a staff member in by creating a session directly. */
export async function staff(ctx: Ctx, role: StaffRole, email = `${role.toLowerCase()}@staff.test`): Promise<Staff> {
  const user = await ctx.prisma.staffUser.create({ data: { email, name: role.toLowerCase(), role } });
  const token = randomBytes(32).toString('base64url');
  const session = await ctx.prisma.staffSession.create({
    data: {
      staffUserId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { cookie: `inf_staff=${token}`, csrf: ctx.auth.csrfToken(session.id), id: user.id };
}

export const postAs = (ctx: Ctx, who: Staff, path: string, form: Record<string, string> = {}) =>
  ctx.http.post(path).set('Cookie', who.cookie).type('form').send({ _csrf: who.csrf, ...form });

export const getAs = (ctx: Ctx, who: Staff, path: string) => ctx.http.get(path).set('Cookie', who.cookie);

/** The one-shot flash message set by a POST (post/redirect/get). */
export function flash(res: Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const raw = cookies.find((c) => c.startsWith('inf_flash='))?.split(';')[0].slice('inf_flash='.length);
  if (!raw) return undefined;
  return (JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8')) as { text: string }).text;
}

/**
 * POSTs a sheet row the way the Apps Script does (no EVENT_SLUG: the event is the row's Sports
 * answer). `legacyEventSlug` imitates an old script that still sends one; it is ignored.
 */
export const submitRow = (ctx: Ctx, responseId: string, answers: Record<string, string>, legacyEventSlug?: string) =>
  ctx.http
    .post('/webhooks/forms/submit')
    .set('X-Webhook-Secret', 'e2e-webhook-secret')
    .send({ ...(legacyEventSlug ? { eventSlug: legacyEventSlug } : {}), sourceForm: 'sheet-e2e', sourceRow: 2, responseId, answers });
