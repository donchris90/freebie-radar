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
import { MessageModerationController, MessagingController, MessagingService } from './messaging/messaging';
import { BillingAdminController, BillingController, BillingService } from './billing/billing';
import { FlutterwaveProvider } from './billing/flutterwave';
import { BILLING_PROVIDERS } from './billing/provider';
import { JobsService } from './jobs/jobs.service';
import { JsonFeedProvider } from './providers/json-feed';
import { RegisteredSource, SOURCES, SyncService } from './sync/sync.service';
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
  controllers: [HealthController, AuthController, ListingsController, EngagementController, AlertsController, AdminController, AppealController, CountriesController, AdminCountriesController, UploadsController, MessagingController, MessageModerationController, BillingController, BillingAdminController],
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
    {
      provide: SOURCES,
      useFactory: (): RegisteredSource[] =>
        config.partnerFeeds.map((f) => ({
          provider: new JsonFeedProvider({ key: f.key, name: f.name, url: f.url, apiKey: f.apiKey, countries: f.countries, categories: config.categories }),
          defaults: { key: f.key, name: f.name, kind: 'API_PROVIDER', countries: f.countries, expireAfterHours: f.expireAfterHours, retireAfterHours: f.retireAfterHours, recheckIntervalHours: null, rateLimitPerMinute: f.rateLimitPerMinute, attribution: f.attribution, attributionUrl: f.attributionUrl, permissionNote: f.permissionNote },
        })),
    },
    JobsService,
    SyncService,
    {
      provide: BILLING_PROVIDERS,
      useFactory: () => [new FlutterwaveProvider({ secretKey: config.billing.flutterwave.secretKey, secretHash: config.billing.flutterwave.secretHash, baseUrl: config.billing.flutterwave.baseUrl })],
    },
    BillingService,
    MessagingService,
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
