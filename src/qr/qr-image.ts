import * as QRCode from 'qrcode';

export function qrPassUrl(baseUrl: string, qrToken: string): string {
  return `${baseUrl}/p/${qrToken}`;
}

export function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
}
