import { Request } from 'express';
import { isCrossSiteWrite } from './auth.middleware';

const req = (headers: Record<string, string>, method = 'POST', path = '/login') =>
  ({ method, path, headers: { host: 'localhost:3000', ...headers } }) as unknown as Request;

describe('isCrossSiteWrite', () => {
  describe('allows same-origin posts as real browsers send them', () => {
    it.each([
      // Chrome/Firefox under Referrer-Policy: no-referrer (the bug: Origin is literally "null")
      ['Origin null + Sec-Fetch-Site same-origin', { origin: 'null', 'sec-fetch-site': 'same-origin' }],
      ['Origin + Sec-Fetch-Site same-origin', { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }],
      // Older Safari without Sec-Fetch-*: relies on a real Origin (Referrer-Policy: same-origin)
      ['matching Origin only', { origin: 'http://localhost:3000' }],
      ['matching Referer only', { referer: 'http://localhost:3000/login' }],
      ['Sec-Fetch-Site none (typed URL / bookmark)', { 'sec-fetch-site': 'none' }],
      ['public host via X-Forwarded-Host', { origin: 'https://register.example.com', 'x-forwarded-host': 'register.example.com' }],
      ['no browser headers (curl, server-to-server)', {}],
    ])('%s', (_label, headers) => {
      expect(isCrossSiteWrite(req(headers))).toBe(false);
    });
  });

  describe('blocks cross-site posts', () => {
    it.each([
      ['Sec-Fetch-Site cross-site', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
      // Sandboxed iframe on an attacker page: Origin null, but the browser still says cross-site.
      ['sandboxed iframe (Origin null, cross-site)', { origin: 'null', 'sec-fetch-site': 'cross-site' }],
      ['another subdomain (same-site is not same-origin)', { origin: 'http://evil.localhost:3000', 'sec-fetch-site': 'same-site' }],
      ['foreign Origin, no Sec-Fetch-*', { origin: 'https://evil.example' }],
      ['Origin null, no Sec-Fetch-*', { origin: 'null' }],
      ['foreign Referer only', { referer: 'https://evil.example/attack.html' }],
      ['Sec-Fetch-Site cross-site even with a spoofed matching Origin', { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }],
    ])('%s', (_label, headers) => {
      expect(isCrossSiteWrite(req(headers))).toBe(true);
    });
  });

  it('never applies to reads or to secret-authenticated webhooks', () => {
    const evil = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    expect(isCrossSiteWrite(req(evil, 'GET'))).toBe(false);
    expect(isCrossSiteWrite(req(evil, 'POST', '/webhooks/forms/submit'))).toBe(false);
    expect(isCrossSiteWrite(req(evil, 'POST', '/webhooks/resend'))).toBe(false);
  });
});
