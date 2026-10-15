import './load-env';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { raw } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

export function configureApp(app: import('@nestjs/common').INestApplication) {
  app.use(helmet());
  // Payment webhooks are authenticated against the exact bytes sent, so this route keeps its body raw.
  app.use('/billing/webhook', raw({ type: '*/*', limit: '256kb' }));
  // Browser clients (the admin dashboard) must be explicitly allowed. Mobile apps do not use CORS.
  const origins = (process.env.CORS_ORIGINS ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')).split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}

if (require.main === module) void bootstrap();
