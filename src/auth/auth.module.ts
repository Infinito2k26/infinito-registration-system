import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { AuthController } from './auth.controller';
import { AuthMiddleware } from './auth.middleware';
import { AuthService } from './auth.service';
import { StaffController } from './staff.controller';
import { StaffGuard } from './staff.guard';

/** Global so any controller can use StaffGuard / WebExceptionFilter without importing this module. */
@Global()
@Module({
  imports: [EmailsModule],
  controllers: [AuthController, StaffController],
  providers: [AuthService, StaffGuard, WebExceptionFilter],
  exports: [AuthService, StaffGuard, WebExceptionFilter],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
