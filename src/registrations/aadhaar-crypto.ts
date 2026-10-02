import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Full Aadhaar numbers are stored only encrypted (AES-256-GCM, random IV, authenticated), as
 * "v1:<iv>:<tag>:<ciphertext>" in base64url. The key is AADHAAR_ENCRYPTION_KEY: 32 bytes as
 * 64 hex characters or base64. Without a key the full number is simply not stored.
 */
export function parseAadhaarKey(raw: string | undefined): Buffer | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('AADHAAR_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)');
  return key;
}

export function encryptAadhaar(digits: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

/** Returns the 12 digits, or null if the value is missing, tampered with, or the key is wrong. */
export function decryptAadhaar(stored: string | null | undefined, key: Buffer | null): string | null {
  if (!stored || !key) return null;
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** "1234 5678 9012" for admins; "XXXX XXXX 9012" for everyone else. */
export const formatAadhaar = (digits: string) => digits.replace(/(\d{4})(?=\d)/g, '$1 ');
export const maskAadhaar = (last4: string) => `XXXX XXXX ${last4}`;
