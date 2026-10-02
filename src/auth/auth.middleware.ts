import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, readCookie } from '../web/cookies';
import { AuthService } from './auth.service';
import { StaffRequest } from './auth.types';

const SKIP = ['/webhooks/', '/assets/', '/health'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Host of an Origin/Referer header, or null when absent/unparseable. */
function headerHost(value: string | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Browser writes must come from our own pages. Covers the sign-in forms (which have no
 * session yet, so no CSRF token) and backs up the CSRF token everywhere else.
 * Webhooks (server-to-server, secret-authenticated) are exempt.
 *
 * 1. Sec-Fetch-Site (set by the browser itself; pages cannot forge it) decides when present:
 *    only "same-origin" (or "none": typed URL / bookmark) is allowed. Needed because a page
 *    with a strict Referrer-Policy makes browsers send `Origin: null` even for same-origin posts.
 * 2. Otherwise the Origin host must match ours. A literal `Origin: null` is rejected: attackers
 *    can produce it from sandboxed iframes.
 * 3. Otherwise a Referer, if present, must match.
 * 4. No browser headers at all (curl, server-to-server): allowed; staff actions still need
 *    their CSRF token.
 */
export function isCrossSiteWrite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method) || req.path.startsWith('/webhooks/')) return false;

  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite) {
    return fetchSite !== 'same-origin' && fetchSite !== 'none';
  }

  // Proxies that rewrite Host (some PaaS) pass the public one in X-Forwarded-Host.
  const hosts = new Set([req.headers.host, req.headers['x-forwarded-host']].flat().filter(Boolean));
  const origin = req.headers.origin;
  if (origin) return !hosts.has(headerHost(origin) ?? '');
  const refererHost = headerHost(req.headers.referer);
  return refererHost !== null && !hosts.has(refererHost);
}

/**
 * Attaches req.staff when a valid session cookie is present (StaffGuard does the rejecting),
 * blocks cross-site writes, and keeps signed-in pages out of browser/proxy caches.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: StaffRequest, res: Response, next: NextFunction) {
    try {
      if (isCrossSiteWrite(req)) {
        res.status(403).type('text').send('Cross-site request blocked');
        return;
      }
      if (!SKIP.some((p) => req.path.startsWith(p))) {
        const token = readCookie(req, SESSION_COOKIE);
        if (token) req.staff = (await this.auth.resolveSession(token)) ?? undefined;
        if (req.staff) res.set('Cache-Control', 'no-store');
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}
