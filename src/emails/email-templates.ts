import { qrPng, qrTokenFromPayload } from '../qr/qr-image';
import { escapeHtml } from '../web/html';

export interface RenderedEmail {
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string; contentId?: string }[];
}

type Payload = Record<string, unknown>;

/** Template names stored in EmailOutbox.template. */
export const EmailTemplate = {
  RegistrationReceived: 'registration-received',
  QrPass: 'qr-pass',
  PaymentRejected: 'payment-rejected',
  StaffLogin: 'staff-login',
  /** Several students' own passes, sent together to one selected student. */
  CollegePasses: 'college-passes',
} as const;

export interface CollegePass {
  name: string;
  events: string;
  /** The pass token (the QR's only content). Rows queued before the change have qrUrl instead. */
  qrToken?: string;
  qrUrl?: string;
}

/** Safe attachment file name from a student's name. */
const fileName = (name: string, i: number) =>
  `${String(i + 1).padStart(2, '0')}-${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'student'}-pass.png`;

const s = (payload: Payload, key: string) => String(payload[key] ?? '');
const e = (payload: Payload, key: string) => escapeHtml(s(payload, key));

function layout(bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e4e7eb;font-size:18px;font-weight:bold">Infinito 2K26</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e4e7eb;font-size:12px;color:#7b8794">Questions? Reply to this email.</td></tr>
</table></td></tr></table></body></html>`;
}

const teamSuffixHtml = (p: Payload) => (p.team ? ` (team <b>${e(p, 'team')}</b>)` : '');
const teamSuffixText = (p: Payload) => (p.team ? ` (team ${s(p, 'team')})` : '');

export async function renderEmail(template: string, payload: Payload): Promise<RenderedEmail> {
  switch (template) {
    case EmailTemplate.RegistrationReceived:
      return {
        html: layout(`<p>Hi ${e(payload, 'name')},</p>
<p>We've received your registration for <b>${e(payload, 'eventName')}</b>${teamSuffixHtml(payload)}.</p>
${
          // Sent late (email added after verification): the pass follows in its own email.
          payload.verified
            ? `<p>Your registration is verified. Your personal QR entry pass is in a separate email.</p>`
            : `<p>Our team will verify your registration${payload.transactionId ? ` (transaction <b>${e(payload, 'transactionId')}</b>)` : ''}. Once it's verified, you'll get a separate email with your personal QR entry pass.</p>`
        }`),
        text: `Hi ${s(payload, 'name')},

We've received your registration for ${s(payload, 'eventName')}${teamSuffixText(payload)}.
${
  payload.verified
    ? 'Your registration is verified. Your personal QR entry pass is in a separate email.'
    : "Our team will verify your registration. Once it's verified, you'll get a separate email with your personal QR entry pass."
}`,
      };

    case EmailTemplate.QrPass: {
      const png = await qrPng(qrTokenFromPayload(payload));
      return {
        html: layout(`<p>Hi ${e(payload, 'name')},</p>
<p>Your registration is verified. This is your personal entry pass for <b>${e(payload, 'eventName')}</b>${teamSuffixHtml(payload)}${payload.college ? ` (${e(payload, 'college')})` : ''}.</p>
<p style="text-align:center"><img src="cid:qr-pass" width="240" height="240" alt="Your QR entry pass"></p>
<p>Show this QR at the gate along with your college ID. It is personal: one scan lets one person in, and the same pass covers all your Infinito events.</p>
<p style="font-size:13px;color:#52606d">The QR is also attached as an image so you can save it offline.</p>`),
        text: `Hi ${s(payload, 'name')},

Your registration is verified. This is your personal entry pass for ${s(payload, 'eventName')}${teamSuffixText(payload)}${payload.college ? ` (${s(payload, 'college')})` : ''}.
Show the attached QR image at the gate, along with your college ID.

The pass is personal: one scan lets one person in.`,
        attachments: [
          { filename: 'infinito-pass.png', content: png, contentType: 'image/png', contentId: 'qr-pass' },
        ],
      };
    }

    case EmailTemplate.PaymentRejected:
      return {
        html: layout(`<p>Hi ${e(payload, 'name')},</p>
<p>We couldn't verify your <b>${e(payload, 'eventName')}</b> registration${teamSuffixHtml(payload)}${payload.transactionId ? `, transaction <b>${e(payload, 'transactionId')}</b>` : ''}.</p>
<p><b>Reason:</b> ${e(payload, 'remarks')}</p>
<p>Please submit the registration form again with the correct details, or reply to this email if you think this is a mistake.</p>`),
        text: `Hi ${s(payload, 'name')},

We couldn't verify your ${s(payload, 'eventName')} registration${teamSuffixText(payload)}.
Reason: ${s(payload, 'remarks')}

Please submit the registration form again with the correct details, or reply to this email if you think this is a mistake.`,
      };

    case EmailTemplate.CollegePasses: {
      const passes = (payload.passes ?? []) as CollegePass[];
      const pngs = await Promise.all(passes.map((p) => qrPng(qrTokenFromPayload(p))));
      const part = Number(payload.parts) > 1 ? ` (part ${s(payload, 'part')} of ${s(payload, 'parts')})` : '';
      const rows = passes
        .map(
          (p, i) => `<tr><td style="padding:12px 0;border-top:1px solid #e4e7eb;vertical-align:top">
<b>${escapeHtml(p.name)}</b><br><span style="color:#52606d">${escapeHtml(s(payload, 'college'))}</span><br>${escapeHtml(p.events)}</td>
<td style="padding:12px 0 12px 12px;border-top:1px solid #e4e7eb;text-align:right"><img src="cid:pass-${i}" width="140" height="140" alt="QR pass of ${escapeHtml(p.name)}"></td></tr>`,
        )
        .join('');
      return {
        html: layout(`<p>Hi ${e(payload, 'recipientName')},</p>
<p>These are the personal entry passes of <b>${passes.length}</b> verified participant(s) from <b>${e(payload, 'college')}</b>${payload.eventName ? ` for <b>${e(payload, 'eventName')}</b>` : ''}${escapeHtml(part)}.</p>
<p><b>Each QR belongs to the student named next to it and admits only that student.</b> Please forward each pass to its owner; every QR is also attached as a named image.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`),
        text: `Hi ${s(payload, 'recipientName')},

Entry passes of ${passes.length} verified participant(s) from ${s(payload, 'college')}${part}.
Each QR belongs to the student named with it and admits only that student. The QR images are attached.

${passes.map((p) => `- ${p.name} (${p.events})`).join('\n')}`,
        attachments: passes.map((p, i) => ({
          filename: fileName(p.name, i),
          content: pngs[i],
          contentType: 'image/png',
          contentId: `pass-${i}`,
        })),
      };
    }

    case EmailTemplate.StaffLogin:
      return {
        html: layout(`<p>Hi ${e(payload, 'name')},</p>
<p>Use this button to sign in to the Infinito staff portal. The link works once and expires in ${e(payload, 'ttlMinutes')} minutes.</p>
<p style="text-align:center"><a href="${e(payload, 'url')}" style="display:inline-block;background:#3b4cca;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Sign in</a></p>
<p style="font-size:13px;color:#52606d">If you didn't ask for this, ignore this email.</p>`),
        text: `Sign in to the Infinito staff portal (single use, expires in ${s(payload, 'ttlMinutes')} minutes):
${s(payload, 'url')}`,
      };

    default:
      throw new Error(`Unknown email template "${template}"`);
  }
}
