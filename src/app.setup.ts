import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { dirname, join } from 'path';

/** HTTP setup shared by main.ts and the e2e tests, so tests exercise the real configuration. */
export function configureApp(app: NestExpressApplication) {
  // Behind Render/Fly/Cloudflare: correct client IPs for login throttling.
  app.set('trust proxy', 1);
  // "same-origin" instead of helmet's "no-referrer": nothing leaks to other sites, but our own
  // form posts carry a real Origin/Referer (under no-referrer browsers send `Origin: null`),
  // which the cross-site write check in AuthMiddleware relies on for older browsers.
  app.use(helmet({ referrerPolicy: { policy: 'same-origin' } }));
  app.enableShutdownHooks();

  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/assets/', maxAge: '1h' });
  app.useStaticAssets(dirname(require.resolve('jsqr/dist/jsQR.js')), {
    prefix: '/assets/vendor/',
    maxAge: '7d',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  return app;
}
