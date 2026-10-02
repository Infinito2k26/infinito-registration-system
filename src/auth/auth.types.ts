import { HttpException, HttpStatus, SetMetadata } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { Request } from 'express';
import { AuthStaff } from './auth.service';

export interface StaffRequest extends Request {
  staff?: AuthStaff;
}

export const ROLES_KEY = 'staffRoles';

/** Restricts a controller/route to these roles. Without it, StaffGuard admits any signed-in staff. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

export const MANAGE_ROLES = [StaffRole.ADMIN, StaffRole.COORDINATOR];

/** Not signed in; the web filter turns this into a redirect to /login. */
export class LoginRequiredException extends HttpException {
  constructor() {
    super('Sign in required', HttpStatus.UNAUTHORIZED);
  }
}
