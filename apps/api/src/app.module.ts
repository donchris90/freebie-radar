import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminController, AppealController, ModerationService } from './admin/admin';
import { AuthController, AuthService, JwtAuthGuard, OptionalAuthGuard, RolesGuard } from './auth/auth';
import { APP_CONFIG, loadConfig } from './config/config';
import { PUSH_SENDER, REPOS } from './domain/ports';
import { AlertsController, AlertsService, ExpoPushSender } from './engagement/alerts';
import { EngagementController, ReportsService, ResaleService, SavedService } from './engagement/engagement';
import { createMemoryRepos } from './infra/memory/memory.repos';
import { ListingsController, ListingsService } from './listings/listings';

const config = loadConfig();

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpiresIn as never } }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.throttleLimit }]),
  ],
  controllers: [HealthController, AuthController, ListingsController, EngagementController, AlertsController, AdminController, AppealController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    {
      provide: REPOS,
      // Only the in-memory adapter exists in this build; it refuses to start in production.
      // A Prisma adapter implementing the same Repos interface is the next step (see README).
      useFactory: () => createMemoryRepos(),
    },
    { provide: PUSH_SENDER, useClass: ExpoPushSender },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    JwtAuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    AuthService,
    ListingsService,
    AlertsService,
    ReportsService,
    SavedService,
    ResaleService,
    ModerationService,
  ],
})
export class AppModule {}
