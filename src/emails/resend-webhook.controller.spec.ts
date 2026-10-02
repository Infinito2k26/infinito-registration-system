import { BadRequestException } from '@nestjs/common';
import { EmailDeliveryStatus } from '@prisma/client';
import { Webhook } from 'standardwebhooks';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResendWebhookController } from './resend-webhook.controller';

const SECRET = `whsec_${Buffer.from('test-signing-secret-32-bytes-long!').toString('base64')}`;

function signedRequest(event: object, secret = SECRET) {
  const body = JSON.stringify(event);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const signature = new Webhook(secret).sign(id, new Date(), body);
  const headers: Record<string, string> = {
    'svix-id': id,
    'svix-timestamp': String(Math.floor(Date.now() / 1000)),
    'svix-signature': signature,
  };
  return { rawBody: Buffer.from(body), header: (name: string) => headers[name.toLowerCase()] } as never;
}

describe('ResendWebhookController', () => {
  let row: { id: string; personId: string | null; toEmail: string; deliveryStatus: EmailDeliveryStatus | null };
  const prisma = {
    emailOutbox: { findUnique: jest.fn(), update: jest.fn() },
    person: { update: jest.fn() },
  };
  const controller = new ResendWebhookController(
    prisma as unknown as PrismaService,
    { email: { webhookSecret: SECRET } } as AppConfig,
  );
  const event = (type: string, extra: object = {}) => ({
    type,
    created_at: '2026-10-02T10:00:00.000Z',
    data: { email_id: 'email_123', ...extra },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    row = { id: 'row-1', personId: 'person-1', toEmail: 'asha@example.com', deliveryStatus: null };
    prisma.emailOutbox.findUnique.mockImplementation(() => Promise.resolve(row));
  });

  it('rejects a bad signature', async () => {
    const forged = signedRequest(event('email.delivered'), `whsec_${Buffer.from('another-secret-another-secret!!').toString('base64')}`);
    await expect(controller.handle(forged)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.emailOutbox.update).not.toHaveBeenCalled();
  });

  it('records delivery against the outbox row', async () => {
    await expect(controller.handle(signedRequest(event('email.delivered')))).resolves.toEqual({ ok: true });
    expect(prisma.emailOutbox.findUnique).toHaveBeenCalledWith({ where: { providerMessageId: 'email_123' } });
    expect(prisma.emailOutbox.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { deliveryStatus: EmailDeliveryStatus.DELIVERED, deliveryUpdatedAt: new Date('2026-10-02T10:00:00.000Z') },
    });
    expect(prisma.person.update).not.toHaveBeenCalled();
  });

  it('flags the participant on bounce', async () => {
    await controller.handle(signedRequest(event('email.bounced', { bounce: { message: 'Mailbox does not exist', type: 'Permanent' } })));
    expect(prisma.person.update).toHaveBeenCalledWith({
      where: { id: 'person-1' },
      data: { emailBouncedAt: expect.any(Date), emailBounceReason: 'Bounced: Mailbox does not exist' },
    });
  });

  it.each([
    ['email.complained', EmailDeliveryStatus.COMPLAINED, 'Marked as spam by recipient'],
    ['email.suppressed', EmailDeliveryStatus.BOUNCED, 'Suppressed by Resend (address bounced or complained earlier)'],
  ])('flags the participant on %s', async (type, status, reason) => {
    await controller.handle(signedRequest(event(type)));
    expect(prisma.emailOutbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deliveryStatus: status }) }));
    expect(prisma.person.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailBounceReason: reason }) }));
  });

  it('does not let a late "delayed" overwrite a final state', async () => {
    row.deliveryStatus = EmailDeliveryStatus.DELIVERED;
    await controller.handle(signedRequest(event('email.delivery_delayed')));
    expect(prisma.emailOutbox.update).not.toHaveBeenCalled();
  });

  it('ignores unrelated events and unknown emails', async () => {
    await expect(controller.handle(signedRequest(event('email.opened')))).resolves.toEqual({ ok: true, ignored: 'email.opened' });
    prisma.emailOutbox.findUnique.mockResolvedValue(null);
    await expect(controller.handle(signedRequest(event('email.delivered')))).resolves.toEqual({ ok: true, ignored: 'unknown email' });
    expect(prisma.emailOutbox.update).not.toHaveBeenCalled();
  });
});
