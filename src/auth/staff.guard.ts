import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { LoginRequiredException, ROLES_KEY, StaffRequest } from './auth.types';

/** Requires a signed-in, active staff member with an allowed role; checks the CSRF token on writes. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<StaffRequest>();
    const staff = req.staff;
    if (!staff) throw new LoginRequiredException();

    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(staff.role)) {
      throw new ForbiddenException('Your role does not have access to this page');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const body = req.body as Record<string, unknown> | undefined;
      if (!this.auth.checkCsrf(staff.sessionId, body?._csrf)) {
        throw new ForbiddenException('This form expired. Go back, reload the page and try again.');
      }
    }
    return true;
  }
}
