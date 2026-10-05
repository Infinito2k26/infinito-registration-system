import { randomBytes } from 'crypto';

const DEFAULT_BYTES = 32;

/** URL-safe random token, the only content of a pass QR. 32 bytes -> 43 chars, unguessable. */
export function generateQrToken(
  bytes = Number(process.env.QR_TOKEN_BYTES) || DEFAULT_BYTES,
): string {
  return randomBytes(Math.max(bytes, 16)).toString('base64url');
}

/**
 * The token from a scanned/pasted code: a raw token (current passes) or an old pass URL
 * ".../p/<token>" (passes emailed before QR codes held only the token).
 */
export function extractQrToken(code: string): string | null {
  const trimmed = code.trim();
  const fromUrl = trimmed.match(/\/p\/([\w-]{16,200})(?:[/?#]|$)/);
  if (fromUrl) return fromUrl[1];
  return /^[\w-]{16,200}$/.test(trimmed) ? trimmed : null;
}
