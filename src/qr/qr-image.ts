import * as QRCode from 'qrcode';
import { extractQrToken } from './qr-token';

/**
 * What a pass QR encodes: ONLY the raw random token. No URL, domain or personal data; the
 * authenticated in-app scanner sends it to the server, which looks everything up.
 */
export function qrPayload(qrToken: string): string {
  return qrToken;
}

/**
 * The token for a QR email payload. Emails queued before the token-only change carry
 * `qrUrl` (".../p/<token>"); the token is extracted so their QR also holds only the token.
 */
export function qrTokenFromPayload(payload: { qrToken?: unknown; qrUrl?: unknown }): string {
  if (typeof payload.qrToken === 'string' && payload.qrToken) return payload.qrToken;
  return (typeof payload.qrUrl === 'string' && extractQrToken(payload.qrUrl)) || '';
}

export function qrPng(qrToken: string): Promise<Buffer> {
  return QRCode.toBuffer(qrPayload(qrToken), { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
}
