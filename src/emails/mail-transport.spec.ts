import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { OutgoingEmail, PermanentSendError, ResendTransport, SendPausedError } from './mail-transport';

/** Minimal stand-in for api.resend.com, driven through the real SDK via RESEND_BASE_URL. */
describe('ResendTransport', () => {
  let server: Server;
  let reply: { status: number; body: unknown };
  let lastRequest: { headers: IncomingMessage['headers']; body: Record<string, unknown> } | null;
  const originalBaseUrl = process.env.RESEND_BASE_URL;

  beforeAll(async () => {
    // The SDK logs every API error; the tests trigger them on purpose.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        lastRequest = { headers: req.headers, body: JSON.parse(raw || '{}') as Record<string, unknown> };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    process.env.RESEND_BASE_URL = originalBaseUrl;
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    lastRequest = null;
    reply = { status: 200, body: { id: 'email_123' } };
  });

  const email: OutgoingEmail = {
    to: 'asha@example.com',
    subject: 'Your pass',
    html: '<p>hi</p>',
    text: 'hi',
    idempotencyKey: 'qr-pass:reg-1:initial',
    tags: { template: 'qr-pass', outbox_id: 'a1b2-c3' },
    attachments: [{ filename: 'pass.png', content: Buffer.from('png'), contentType: 'image/png', contentId: 'qr-pass' }],
  };
  const transport = () => new ResendTransport('re_test_key', 'Infinito Dev <dev@example.com>', 'help@example.com');

  it('sends from/reply-to/tags/inline attachment with the idempotency key and returns the id', async () => {
    await expect(transport().send(email)).resolves.toBe('email_123');
    expect(lastRequest!.headers['idempotency-key']).toBe('qr-pass:reg-1:initial');
    expect(lastRequest!.headers.authorization).toBe('Bearer re_test_key');
    expect(lastRequest!.body).toMatchObject({
      from: 'Infinito Dev <dev@example.com>',
      to: 'asha@example.com',
      reply_to: 'help@example.com',
      subject: 'Your pass',
      text: 'hi',
      tags: [
        { name: 'template', value: 'qr-pass' },
        { name: 'outbox_id', value: 'a1b2-c3' },
      ],
    });
    const [attachment] = lastRequest!.body.attachments as Record<string, unknown>[];
    expect(attachment).toMatchObject({ filename: 'pass.png', content_id: 'qr-pass' });
  });

  it.each([
    [429, 'rate_limit_exceeded', 2_000],
    [429, 'daily_quota_exceeded', 3_600_000],
    [403, 'invalid_api_key', 300_000],
    [403, 'invalid_from_address', 300_000],
    [409, 'concurrent_idempotent_requests', 10_000],
  ])('pauses the queue on %s %s', async (status, name, pauseMs) => {
    reply = { status, body: { statusCode: status, name, message: 'nope' } };
    const error = await transport().send(email).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendPausedError);
    expect((error as SendPausedError).pauseMs).toBe(pauseMs);
  });

  it.each([
    [422, 'validation_error'],
    [403, 'validation_error'],
    [409, 'invalid_idempotent_request'],
  ])('fails only this email on %s %s', async (status, name) => {
    reply = { status, body: { statusCode: status, name, message: 'bad recipient' } };
    await expect(transport().send(email)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('treats 5xx as retryable', async () => {
    reply = { status: 500, body: { statusCode: 500, name: 'internal_server_error', message: 'boom' } };
    const error = await transport().send(email).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentSendError);
    expect(error).not.toBeInstanceOf(SendPausedError);
  });
});
