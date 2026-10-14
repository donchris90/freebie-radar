import {
  BadRequestException,
  CanActivate,
  ConflictException,
  Controller,
  Body,
  ExecutionContext,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Post,
  Patch,
  Delete,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { isValidCoordinate } from '../core/geo';
import { APP_CONFIG, AppConfig } from '../config/config';
import type { Role, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';

const AUTH_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT ?? 10);

export interface AuthedRequest {
  user: UserRec;
  headers: Record<string, string | undefined>;
}

export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): UserRec =>
  ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, @Inject(REPOS) private readonly repos: Repos) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    let sub: string;
    try {
      sub = (await this.jwt.verifyAsync<{ sub: string }>(header.slice(7))).sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const user = await this.repos.users.findById(sub);
    // Re-checking status on every request means suspension and deletion take effect immediately.
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account unavailable');
    req.user = user;
    return true;
  }
}

/** Optional auth: attaches the user when a valid token is present, never rejects. */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, @Inject(REPOS) private readonly repos: Repos) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      try {
        const { sub } = await this.jwt.verifyAsync<{ sub: string }>(header.slice(7));
        const user = await this.repos.users.findById(sub);
        if (user && user.status === 'ACTIVE') req.user = user;
      } catch {
        /* anonymous */
      }
    }
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}

export class RegisterDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(10, 128) password!: string;
  @IsString() @Length(2, 50) displayName!: string;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
}
export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MaxLength(128) password!: string;
}
export class PrefsDto {
  @IsOptional() @IsIn(['mi', 'km']) distanceUnit?: 'mi' | 'km';
  @IsOptional() @IsNumber() homeLat?: number;
  @IsOptional() @IsNumber() homeLng?: number;
  @IsOptional() @IsString() @MaxLength(100) homeLabel?: string;
  @IsOptional() @IsIn(['approximate', 'precise', 'manual']) locationPrecision?: 'approximate' | 'precise' | 'manual';
  @IsOptional() @IsBoolean() personalisationEnabled?: boolean;
  @IsOptional() @IsBoolean() pushEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(23) quietHoursStart?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) quietHoursEnd?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxPushPerDay?: number;
  @IsOptional() @IsString() @MaxLength(200) pushToken?: string;
}

export function publicUser(u: UserRec) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    tier: u.tier,
    countryCode: u.countryCode,
    timeZone: u.timeZone,
    prefs: { ...u.prefs, pushToken: undefined, pushTokenSet: !!u.prefs.pushToken },
  };
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  private async token(u: UserRec) {
    return { accessToken: await this.jwt.signAsync({ sub: u.id, role: u.role }), tokenType: 'Bearer' };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const country = (dto.countryCode ?? this.cfg.defaultCountry).toUpperCase();
    if (!this.cfg.enabledCountries.includes(country)) throw new BadRequestException(`Country ${country} is not enabled`);
    const tz = dto.timeZone ?? 'UTC';
    if (!validTimeZone(tz)) throw new BadRequestException('Unknown time zone');
    if (await this.repos.users.findByEmail(email)) {
      // Generic message is a deliberate trade-off against enumeration; registration conflicts are still reported.
      throw new ConflictException('An account with this email already exists');
    }
    const user = await this.repos.users.insert({
      id: randomUUID(),
      email,
      passwordHash: await bcrypt.hash(dto.password, this.cfg.bcryptCost),
      displayName: dto.displayName.trim(),
      role: 'USER',
      tier: 'FREE',
      status: 'ACTIVE',
      countryCode: country,
      timeZone: tz,
      locale: 'en-US',
      prefs: {
        distanceUnit: country === 'US' || country === 'GB' ? 'mi' : 'km',
        homeLat: null,
        homeLng: null,
        homeLabel: null,
        locationPrecision: 'approximate',
        personalisationEnabled: true,
        pushEnabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        maxPushPerDay: 10,
        pushToken: null,
      },
      createdAt: new Date(),
    });
    return { user: publicUser(user), ...(await this.token(user)) };
  }

  async login(dto: LoginDto) {
    const user = await this.repos.users.findByEmail(dto.email.trim().toLowerCase());
    // Compare against a dummy hash when the user is unknown to keep timing similar.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok || user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid email or password');
    return { user: publicUser(user), ...(await this.token(user)) };
  }

  async updatePrefs(user: UserRec, dto: PrefsDto) {
    if ((dto.homeLat !== undefined) !== (dto.homeLng !== undefined)) throw new BadRequestException('homeLat and homeLng must be set together');
    if (dto.homeLat !== undefined && !isValidCoordinate(dto.homeLat, dto.homeLng)) throw new BadRequestException('Invalid coordinates');
    const prefs = { ...user.prefs };
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) (prefs as Record<string, unknown>)[k] = v;
    // Approximate precision: store a ~1km grid, not the exact point.
    if (prefs.locationPrecision === 'approximate' && prefs.homeLat !== null && prefs.homeLng !== null) {
      prefs.homeLat = Math.round(prefs.homeLat * 100) / 100;
      prefs.homeLng = Math.round(prefs.homeLng * 100) / 100;
    }
    const updated = await this.repos.users.update(user.id, { prefs });
    return publicUser(updated!);
  }

  /** Account deletion: anonymise the record and take the user's listings out of circulation. */
  async deleteAccount(user: UserRec) {
    await this.repos.users.update(user.id, {
      status: 'DELETED',
      email: `deleted+${user.id}@invalid.local`,
      displayName: 'Deleted user',
      passwordHash: '',
      prefs: { ...user.prefs, homeLat: null, homeLng: null, homeLabel: null, pushToken: null },
    });
    const own = await this.repos.listings.search({ sellerUserId: user.id, publicOnly: false, sort: 'newest', offset: 0, limit: 1000 });
    for (const l of own.items) await this.repos.listings.update(l.id, { status: 'REMOVED' });
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'ACCOUNT_DELETED', entityType: 'User', entityId: user.id, metadata: {}, createdAt: new Date() });
  }
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @Post('auth/register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @Post('auth/login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: UserRec) {
    return publicUser(user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/preferences')
  prefs(@CurrentUser() user: UserRec, @Body() dto: PrefsDto) {
    return this.auth.updatePrefs(user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  async remove(@CurrentUser() user: UserRec) {
    await this.auth.deleteAccount(user);
    return { deleted: true };
  }
}
