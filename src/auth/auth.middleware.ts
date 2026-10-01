import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { SESSION_COOKIE, readCookie } from '../web/cookies';
import { AuthService } from './auth.service';
import { StaffRequest } from './auth.types';

const SKIP = ['/webhooks/', '/assets/', '/health'];

/** Attaches req.staff when a valid session cookie is present. Never rejects; StaffGuard does that. */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: StaffRequest, _res: Response, next: NextFunction) {
    try {
      if (!SKIP.some((p) => req.path.startsWith(p))) {
        const token = readCookie(req, SESSION_COOKIE);
        if (token) req.staff = (await this.auth.resolveSession(token)) ?? undefined;
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}
