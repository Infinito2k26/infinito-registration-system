import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

export const WEBHOOK_SECRET_HEADER = 'x-webhook-secret';

const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class FormsWebhookGuard implements CanActivate {
  private readonly expected: Buffer | undefined;

  constructor(config: ConfigService) {
    const secret = config.get<string>('FORMS_WEBHOOK_SECRET');
    this.expected = secret ? digest(secret) : undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    const provided = context
      .switchToHttp()
      .getRequest<Request>()
      .header(WEBHOOK_SECRET_HEADER);

    if (!this.expected || !provided || !timingSafeEqual(digest(provided), this.expected)) {
      throw new UnauthorizedException({ ok: false, errors: ['Invalid webhook secret'] });
    }
    return true;
  }
}
