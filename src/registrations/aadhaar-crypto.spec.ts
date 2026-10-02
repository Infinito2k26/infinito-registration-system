import { randomBytes } from 'crypto';
import { decryptAadhaar, encryptAadhaar, formatAadhaar, maskAadhaar, parseAadhaarKey } from './aadhaar-crypto';

describe('Aadhaar encryption', () => {
  const key = randomBytes(32);

  it('round-trips, uses a random IV and never contains the plain number', () => {
    const a = encryptAadhaar('123456789012', key);
    const b = encryptAadhaar('123456789012', key);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('123456789012');
    expect(decryptAadhaar(a, key)).toBe('123456789012');
  });

  it('fails closed on a wrong key, tampering, or missing input', () => {
    const stored = encryptAadhaar('123456789012', key);
    expect(decryptAadhaar(stored, randomBytes(32))).toBeNull();
    expect(decryptAadhaar(stored.slice(0, -2) + 'AA', key)).toBeNull();
    expect(decryptAadhaar(null, key)).toBeNull();
    expect(decryptAadhaar(stored, null)).toBeNull();
  });

  it('parses hex/base64 keys and rejects wrong lengths', () => {
    expect(parseAadhaarKey('')).toBeNull();
    expect(parseAadhaarKey(key.toString('hex'))?.equals(key)).toBe(true);
    expect(parseAadhaarKey(key.toString('base64'))?.equals(key)).toBe(true);
    expect(() => parseAadhaarKey('abcd')).toThrow('AADHAAR_ENCRYPTION_KEY must be 32 bytes');
  });

  it('formats for admins and masks for everyone else', () => {
    expect(formatAadhaar('123456789012')).toBe('1234 5678 9012');
    expect(maskAadhaar('9012')).toBe('XXXX XXXX 9012');
  });
});
