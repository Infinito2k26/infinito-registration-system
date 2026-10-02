import { randomBytes } from 'crypto';

const DEFAULT_BYTES = 32;

/** URL-safe random token for /p/<token>. 32 bytes -> 43 chars, unguessable. */
export function generateQrToken(
  bytes = Number(process.env.QR_TOKEN_BYTES) || DEFAULT_BYTES,
): string {
  return randomBytes(Math.max(bytes, 16)).toString('base64url');
}
