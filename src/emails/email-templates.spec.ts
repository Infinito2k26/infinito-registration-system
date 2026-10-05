import jsQR from 'jsqr';
import { EmailTemplate, renderEmail } from './email-templates';

// pngjs ships with the qrcode library (no types of its own); only used here to read QR images back.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as { PNG: { sync: { read(png: Buffer): { width: number; height: number; data: Buffer } } } };

const TOKEN_A = 'tokenAAAAAAAAAAAAAAAA';

/** Decodes a QR PNG back to the exact text it encodes. */
function decodeQr(png: Buffer): string | undefined {
  const image = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data;
}

describe('college passes email', () => {
  it('labels every pass with its owner, attaches each QR, and escapes names', async () => {
    const email = await renderEmail(EmailTemplate.CollegePasses, {
      recipientName: 'Priya',
      college: 'NIT Patna',
      eventName: null,
      part: 1,
      parts: 1,
      passes: [
        { name: 'Priya Sharma', events: 'Table Tennis', qrToken: TOKEN_A },
        // Queued before the token-only change: the token is extracted from the old URL.
        { name: '<b>Arjun</b>', events: 'Football, Cricket', qrUrl: 'https://x.test/p/tokenBBBBBBBBBBBBBBBB' },
      ],
    });
    expect(email.attachments?.map((a) => [a.filename, a.contentId])).toEqual([
      ['01-Priya-Sharma-pass.png', 'pass-0'],
      ['02-b-Arjun-b-pass.png', 'pass-1'],
    ]);
    expect(email.html).toContain('cid:pass-0');
    expect(email.html).toContain('&lt;b&gt;Arjun&lt;/b&gt;');
    expect(email.html).not.toContain('<b>Arjun</b>');
    expect(email.text).toContain('- Priya Sharma (Table Tennis)');
    expect(email.attachments?.map((a) => decodeQr(a.content))).toEqual([TOKEN_A, 'tokenBBBBBBBBBBBBBBBB']);
    for (const body of [email.html, email.text]) expect(body).not.toMatch(/https?:\/\/|\/p\/token/);
  });

  it('the individual pass names the participant, event and college', async () => {
    const email = await renderEmail(EmailTemplate.QrPass, {
      name: 'Priya',
      eventName: 'Table Tennis',
      team: null,
      college: 'NIT Patna',
      qrToken: TOKEN_A,
    });
    expect(email.text).toContain('personal entry pass for Table Tennis (NIT Patna)');
    expect(email.attachments).toHaveLength(1);
  });

  describe('QR payload: only the raw token', () => {
    const token = 'Xr4_k9-qZ2mN7pL0sT1uV3wY5aB8cD6eF2gH4iJ0kLm'; // 43 chars, like a real 32-byte token
    const render = (payload: Record<string, unknown>) =>
      renderEmail(EmailTemplate.QrPass, { name: 'Priya Sharma', eventName: 'Table Tennis', team: null, college: 'NIT Patna', ...payload });

    it('11-13. the QR encodes exactly the token: no URL, domain or personal data', async () => {
      const email = await render({ qrToken: token });
      const content = decodeQr(email.attachments![0].content);
      expect(content).toBe(token);
      expect(content).not.toMatch(/https?:|\/|\./);
      for (const personal of ['Priya', 'Sharma', 'NIT', 'Patna', 'Table', '@']) expect(content).not.toContain(personal);
      // The email no longer carries a pass link either.
      expect(email.text).not.toMatch(/Pass link|https?:\/\//);
      expect(email.html).not.toContain(`/p/${token}`);
    });

    it('21. an email queued before the change (payload with the old URL) still gets a token-only QR', async () => {
      const email = await render({ qrUrl: `https://sirvihostelpali.com/p/${token}` });
      expect(decodeQr(email.attachments![0].content)).toBe(token);
    });
  });
});
