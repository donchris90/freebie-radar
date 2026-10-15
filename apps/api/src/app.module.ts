import { Controller, Get, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminController, AppealController, ModerationService } from './admin/admin';
import { AuthController, AuthService, JwtAuthGuard, OptionalAuthGuard, RolesGuard } from './auth/auth';
import { APP_CONFIG, loadConfig } from './config/config';
import { PrismaClient } from '@prisma/client';
import { PRISMA, PUSH_SENDER, REPOS, Repos } from './domain/ports';
import { AlertsController, AlertsService, ExpoPushSender } from './engagement/alerts';
import { EngagementController, ReportsService, ResaleService, SavedService } from './engagement/engagement';
import { createMemoryRepos } from './infra/memory/memory.repos';
import { createPrismaRepos } from './infra/prisma/prisma.repos';
import { AdminCountriesController, CountriesController } from './countries/countries.controller';
import { CountriesService } from './countries/countries.service';
import { createStorage, STORAGE } from './storage/storage';
import { createMailer, MAILER } from './mail/mailer';
import { UploadsController } from './storage/uploads.controller';
import { ListingsController, ListingsService } from './listings/listings';

const config = loadConfig();

@Injectable()
class PrismaLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient | null) {}
  async onModuleDestroy() {
    await this.prisma?.$disconnect();
  }
}

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
  controllers: [HealthController, AuthController, ListingsController, EngagementController, AlertsController, AdminController, AppealController, CountriesController, AdminCountriesController, UploadsController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: PRISMA, useFactory: (): PrismaClient | null => (config.store === 'prisma' ? new PrismaClient() : null) },
    {
      provide: REPOS,
      inject: [PRISMA],
      // STORE=prisma uses PostgreSQL; the in-memory adapter is for tests and local development only
      // and refuses to start when NODE_ENV=production.
      useFactory: (prisma: PrismaClient | null): Repos => (prisma ? createPrismaRepos(prisma) : createMemoryRepos()),
    },
    PrismaLifecycle,
    { provide: STORAGE, useFactory: () => createStorage(config) },
    { provide: MAILER, useFactory: () => createMailer(config) },
    { provide: PUSH_SENDER, useClass: ExpoPushSender },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    JwtAuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    CountriesService,
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
