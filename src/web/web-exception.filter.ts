import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { Response } from 'express';
import { LoginRequiredException, StaffRequest } from '../auth/auth.types';
import { html } from './html';
import { page } from './layout';

/** For HTML controllers: login redirect for anonymous users, a readable error page otherwise. */
@Catch()
@Injectable()
export class WebExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WebExceptionFilter.name);

  constructor(private readonly auth: AuthService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<StaffRequest>();
    const res = ctx.getResponse<Response>();

    if (exception instanceof LoginRequiredException) {
      res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Something went wrong. Try again, and tell the tech team if it keeps happening.';
    if (exception instanceof HttpException && status < 500) {
      const response = exception.getResponse();
      const raw = typeof response === 'string' ? response : (response as { message?: unknown }).message;
      message = Array.isArray(raw) ? raw.join(', ') : String(raw ?? exception.message);
    } else {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    }

    res
      .status(status)
      .type('html')
      .send(
        page({
          title: status === 404 ? 'Not found' : 'Error',
          staff: req.staff,
          csrf: req.staff ? this.auth.csrfToken(req.staff.sessionId) : undefined,
          body: html`<section class="card narrow"><h1>${status === 404 ? 'Not found' : 'Cannot do that'}</h1>
            <p>${message}</p><p><a href="/">Back to start</a></p></section>`,
        }),
      );
  }
}
