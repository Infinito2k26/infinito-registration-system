import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/app-config.service';
import { EntryModule } from './entry/entry.module';
import { FormsModule } from './forms/forms.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // Limits are set per route with @Throttle (login endpoints only).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    AppConfigModule,
    PrismaModule,
    HealthModule,
    FormsModule,
    AuthModule,
    AdminModule,
    EntryModule,
  ],
})
export class AppModule {}
