import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { dirname, join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: the Resend webhook signature is computed over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Behind Render/Fly's proxy: correct client IPs for login throttling.
  app.set('trust proxy', 1);
  app.use(helmet());
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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  console.log(`Infinito Registration System running on http://localhost:${port}`);
}

bootstrap();
