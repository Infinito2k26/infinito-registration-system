import { EmailTemplate, renderEmail } from './email-templates';

describe('college passes email', () => {
  it('labels every pass with its owner, attaches each QR, and escapes names', async () => {
    const email = await renderEmail(EmailTemplate.CollegePasses, {
      recipientName: 'Priya',
      college: 'NIT Patna',
      eventName: null,
      part: 1,
      parts: 1,
      passes: [
        { name: 'Priya Sharma', events: 'Table Tennis', qrUrl: 'https://x.test/p/tokenAAAAAAAAAAAAAAAA' },
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
    expect(email.text).toContain('- Priya Sharma (Table Tennis): https://x.test/p/tokenAAAAAAAAAAAAAAAA');
  });

  it('the individual pass names the participant, event and college', async () => {
    const email = await renderEmail(EmailTemplate.QrPass, {
      name: 'Priya',
      eventName: 'Table Tennis',
      team: null,
      college: 'NIT Patna',
      qrUrl: 'https://x.test/p/tokenAAAAAAAAAAAAAAAA',
    });
    expect(email.text).toContain('personal entry pass for Table Tennis (NIT Patna)');
    expect(email.attachments).toHaveLength(1);
  });
});
