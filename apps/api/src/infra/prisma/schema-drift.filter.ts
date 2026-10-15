import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * The database is behind the code (a table or column is missing). That is a setup problem, not the caller's fault:
 * say so plainly in the server log and give the app a clear 503. Everything else keeps Nest's normal handling.
 * Prisma codes: P2021 table does not exist, P2022 column does not exist.
 */
@Catch()
export class SchemaDriftFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Database');
  catch(err: unknown, host: ArgumentsHost) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'P2021' || code === 'P2022') {
      this.log.error('The database schema is out of date. Run `npx prisma migrate dev` (or `npx prisma db push`) in apps/api, then restart the API.');
      host.switchToHttp().getResponse().status(HttpStatus.SERVICE_UNAVAILABLE).json({ statusCode: 503, message: 'The service is being updated. Please try again shortly.' });
      return;
    }
    super.catch(err, host);
  }
}
