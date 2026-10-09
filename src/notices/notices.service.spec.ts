import { EmailStatus, NoticeStatus } from '@prisma/client';
import { EmailTemplate, noticeBodyHtml, renderEmail } from '../emails/email-templates';
import { NoticeCounts, NoticesService, VALID_EMAIL, noticeDisplayStatus, recipientState } from './notices.service';

const counts = (c: Partial<NoticeCounts>): NoticeCounts => ({ selected: 0, awaiting: 0, pending: 0, sent: 0, failed: 0, firstSentAt: null, lastSentAt: null, ...c });

describe('notices', () => {
  describe('recipient state comes only from the delivery row', () => {
    it.each([
      [null, 'SELECTED'],
      [EmailStatus.PENDING, 'PENDING'],
      [EmailStatus.PROCESSING, 'PENDING'],
      [EmailStatus.SENT, 'SENT'],
      [EmailStatus.FAILED, 'FAILED'],
      [EmailStatus.CANCELLED, 'FAILED'],
    ])('%s -> %s', (status, state) => {
      expect(recipientState(status ? { status } : null)).toBe(state);
    });
  });

  describe('notice status', () => {
    const draft = { status: NoticeStatus.DRAFT };
    const ready = { status: NoticeStatus.READY };
    it('Draft / Ready until something is queued (selecting recipients sends nothing)', () => {
      expect(noticeDisplayStatus(draft, counts({ selected: 10, awaiting: 10 }))).toBe('Draft');
      expect(noticeDisplayStatus(ready, counts({ selected: 10, awaiting: 10 }))).toBe('Ready');
    });
    it('Sending while anything is pending; then Completed / Partially sent / Failed', () => {
      expect(noticeDisplayStatus(ready, counts({ selected: 100, sent: 60, pending: 35, failed: 5 }))).toBe('Sending');
      expect(noticeDisplayStatus(ready, counts({ selected: 100, sent: 95, failed: 5 }))).toBe('Partially sent');
      expect(noticeDisplayStatus(ready, counts({ selected: 150, sent: 100, awaiting: 50 }))).toBe('Partially sent');
      expect(noticeDisplayStatus(ready, counts({ selected: 100, sent: 100 }))).toBe('Completed');
      expect(noticeDisplayStatus(ready, counts({ selected: 3, failed: 3 }))).toBe('Failed');
    });
  });

  it('valid email rule', () => {
    for (const ok of ['a@b.co', 'first.last+tag@college.ac.in']) expect(VALID_EMAIL.test(ok)).toBe(true);
    for (const bad of ['', 'abc', 'a@b', 'a b@c.com', '@b.com', 'a@b.c d']) expect(VALID_EMAIL.test(bad)).toBe(false);
  });

  it('validates and normalises the notice fields', () => {
    const service = new NoticesService(null as never, null as never, null as never);
    expect(service.validate({ title: '  T ', subject: ' Hello\n  world ', body: '\r\nLine 1\r\nLine 2\r\n' })).toEqual({
      input: { title: 'T', subject: 'Hello world', body: 'Line 1\nLine 2' },
      errors: [],
    });
    expect(service.validate({}).errors).toEqual(['Enter a notice title', 'Enter the email subject', 'Enter the message']);
    expect(service.validate({ title: 'x'.repeat(201), subject: 's', body: 'b' }).errors).toEqual(['The title can be at most 200 characters']);
  });

  describe('message rendering', () => {
    it('escapes HTML, keeps paragraphs and line breaks, links only http(s) URLs', () => {
      const out = noticeBodyHtml('Hi <b>all</b> & "friends"\nline two\n\nSee https://infinito.iitp.ac.in/schedule?a=1&b=2. Or javascript:alert(1) <script>alert(1)</script>');
      expect(out).toBe(
        '<p>Hi &lt;b&gt;all&lt;/b&gt; &amp; &quot;friends&quot;<br>line two</p>\n' +
          '<p>See <a href="https://infinito.iitp.ac.in/schedule?a=1&amp;b=2" style="color:#3b4cca">https://infinito.iitp.ac.in/schedule?a=1&amp;b=2</a>. Or javascript:alert(1) &lt;script&gt;alert(1)&lt;/script&gt;</p>',
      );
    });
    it('a quoted link cannot break out of the attribute', () => {
      expect(noticeBodyHtml('"https://x.test/a"onmouseover="x"')).toBe('<p>&quot;<a href="https://x.test/a" style="color:#3b4cca">https://x.test/a</a>&quot;onmouseover=&quot;x&quot;</p>');
    });
    it('the notice email: the same text in both parts, no attachments', async () => {
      const email = await renderEmail(EmailTemplate.Notice, { subject: 'S', body: 'Hello\r\n\r\n<i>World</i>' });
      expect(email.text).toBe('Hello\n\n<i>World</i>');
      expect(email.html).toContain('<p>Hello</p>\n<p>&lt;i&gt;World&lt;/i&gt;</p>');
      expect(email.attachments).toBeUndefined();
    });
  });
});
