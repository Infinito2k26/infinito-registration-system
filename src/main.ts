import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // rawBody: the Resend webhook signature is computed over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  console.log(`Infinito Registration System running on http://localhost:${port}`);
}

bootstrap();
