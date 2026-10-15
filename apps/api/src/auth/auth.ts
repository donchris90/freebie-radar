import {
  BadRequestException,
  CanActivate,
  ConflictException,
  Controller,
  Body,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
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
import { STORAGE, StorageDriver } from '../storage/storage';
import { CountriesService } from '../countries/countries.service';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'crypto';
import { Logger } from '@nestjs/common';
import { MAILER, Mailer } from '../mail/mailer';
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
import type { CodePurpose, Role, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';

const AUTH_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT ?? 10);
/** Endpoints that send email are limited more tightly than sign-in. */
const MAIL_LIMIT = Number(process.env.MAIL_THROTTLE_LIMIT ?? 5);

export interface AuthedRequest {
  user: UserRec;
  headers: Record<string, string | undefined>;
}

export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): UserRec =>
  ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

/** Access tokens issued before a password change, reset or sign-out-everywhere stop working. */
export function tokenStillValid(user: UserRec, version: number | undefined): boolean {
  return (version ?? 0) === user.tokenVersion;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, @Inject(REPOS) private readonly repos: Repos) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    let payload: { sub: string; tv?: number };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; tv?: number }>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const user = await this.repos.users.findById(payload.sub);
    // Re-checking status on every request means suspension and deletion take effect immediately.
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account unavailable');
    if (!tokenStillValid(user, payload.tv)) throw new UnauthorizedException('Session ended. Please sign in again.');
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
        const { sub, tv } = await this.jwt.verifyAsync<{ sub: string; tv?: number }>(header.slice(7));
        const user = await this.repos.users.findById(sub);
        if (user && user.status === 'ACTIVE' && tokenStillValid(user, tv)) req.user = user;
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
  /** A member's invite code or an ambassador code. An unknown or switched-off code is ignored, never an error. */
  @IsOptional() @Matches(/^[A-Za-z0-9]{4,20}$/) referralCode?: string;
}
export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MaxLength(128) password!: string;
}
export class RefreshDto {
  @IsString() @Length(20, 200) refreshToken!: string;
}
export class ChangePasswordDto {
  @IsString() @Length(1, 128) currentPassword!: string;
  @IsString() @Length(10, 128) newPassword!: string;
}
export class ForgotPasswordDto {
  @IsEmail() @MaxLength(254) email!: string;
}
export class ResetPasswordDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @Length(4, 20) code!: string;
  @IsString() @Length(10, 128) newPassword!: string;
}
export class CodeDto {
  @IsString() @Length(4, 20) code!: string;
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
    emailVerified: !!u.emailVerifiedAt,
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
    private readonly countries: CountriesService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  private readonly log = new Logger('Auth');

  private hashToken(t: string) {
    return createHash('sha256').update(t).digest('hex');
  }
  private hashCode(userId: string, purpose: CodePurpose, code: string) {
    return createHmac('sha256', this.cfg.jwtSecret).update(`${userId}:${purpose}:${code}`).digest('hex');
  }

  /** A short-lived access token plus a long-lived, single-use refresh token. Only the refresh token's hash is stored. */
  private async token(u: UserRec, familyId: string = randomUUID()) {
    const now = new Date();
    const refreshToken = randomBytes(32).toString('base64url');
    await this.repos.tokens.addRefresh({
      id: randomUUID(), userId: u.id, familyId, tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + this.cfg.refreshTtlDays * 86_400_000), revokedAt: null, createdAt: now,
    });
    return { accessToken: await this.jwt.signAsync({ sub: u.id, role: u.role, tv: u.tokenVersion }), refreshToken, tokenType: 'Bearer' };
  }

  // ---- one-time codes (email verification, password reset) -------------------------------------

  private static readonly CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  private static readonly MAX_CODE_ATTEMPTS = 5;

  private normaliseCode(c: string) {
    return c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /** Creates and emails a code. Returns false when one was sent less than a minute ago. */
  private async sendCode(user: UserRec, purpose: CodePurpose, ttlMinutes: number, subject: string, intro: string): Promise<boolean> {
    const last = await this.repos.tokens.latestCode(user.id, purpose);
    if (last && Date.now() - last.createdAt.getTime() < this.cfg.codeResendSeconds * 1000) return false;
    const code = Array.from({ length: 8 }, () => AuthService.CODE_ALPHABET[randomInt(AuthService.CODE_ALPHABET.length)]).join('');
    const now = new Date();
    await this.repos.tokens.addCode({
      id: randomUUID(), userId: user.id, purpose, codeHash: this.hashCode(user.id, purpose, code), attempts: 0,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000), usedAt: null, createdAt: now,
    });
    await this.mailer.send({
      to: user.email, subject,
      text: `${intro}\n\nYour code: ${code.slice(0, 4)}-${code.slice(4)}\n\nIt expires in ${ttlMinutes >= 120 ? `${ttlMinutes / 60} hours` : `${ttlMinutes} minutes`}. If you did not ask for this, you can ignore this email.`,
    });
    return true;
  }

  /** Checks a code, counting wrong guesses; the same generic error covers wrong, expired, used and locked-out codes. */
  private async consumeCode(user: UserRec, purpose: CodePurpose, input: string) {
    const bad = () => new BadRequestException('That code is invalid or has expired. Request a new one.');
    const rec = await this.repos.tokens.latestCode(user.id, purpose);
    if (!rec || rec.usedAt || rec.expiresAt.getTime() < Date.now() || rec.attempts >= AuthService.MAX_CODE_ATTEMPTS) throw bad();
    const given = Buffer.from(this.hashCode(user.id, purpose, this.normaliseCode(input)), 'hex');
    const want = Buffer.from(rec.codeHash, 'hex');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      await this.repos.tokens.bumpCodeAttempts(rec.id);
      throw bad();
    }
    if (!(await this.repos.tokens.consumeCode(rec.id, new Date()))) throw bad();
  }

  private async sendVerification(user: UserRec) {
    return this.sendCode(user, 'EMAIL_VERIFY', 24 * 60, 'Verify your Freebie Radar email', 'Enter this code in the app to confirm your email address.');
  }

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const country = (dto.countryCode ?? this.cfg.defaultCountry).toUpperCase();
    const countryRec = await this.countries.getEnabled(country);
    if (!countryRec) throw new BadRequestException(`Country ${country} is not enabled`);
    const tz = dto.timeZone ?? countryRec.defaultTimeZone;
    if (!validTimeZone(tz)) throw new BadRequestException('Unknown time zone');
    if (await this.repos.users.findByEmail(email)) {
      // Generic message is a deliberate trade-off against enumeration; registration conflicts are still reported.
      throw new ConflictException('An account with this email already exists');
    }
    const referral = dto.referralCode ? await this.repos.referrals.find(dto.referralCode.toUpperCase()) : null;
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
        distanceUnit: countryRec.distanceUnit,
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
      emailVerifiedAt: null,
      tokenVersion: 0,
      referredByCode: referral?.active ? referral.code : null,
      createdAt: new Date(),
    });
    // A failed email must not block sign-up; the user can ask for another code from Profile.
    await this.sendVerification(user).catch((e) => this.log.warn(`Verification email failed: ${(e as Error).message}`));
    return { user: publicUser(user), ...(await this.token(user)) };
  }

  async login(dto: LoginDto) {
    const user = await this.repos.users.findByEmail(dto.email.trim().toLowerCase());
    // Compare against a dummy hash when the user is unknown to keep timing similar.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (user && ok && user.status === 'SUSPENDED') throw new ForbiddenException('This account has been suspended. Contact support if you think this is a mistake.');
    if (!user || !ok || user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid email or password');
    return { user: publicUser(user), ...(await this.token(user)) };
  }

  /** Swaps a refresh token for a new pair. Presenting an already-used token ends the whole login session family. */
  async refresh(dto: RefreshDto) {
    const rec = await this.repos.tokens.findRefresh(this.hashToken(dto.refreshToken));
    const fail = () => new UnauthorizedException('Session expired. Please sign in again.');
    if (!rec || rec.expiresAt.getTime() < Date.now()) throw fail();
    if (rec.revokedAt) {
      // A token used a moment ago is most likely two requests racing; anything older looks like theft.
      if (Date.now() - rec.revokedAt.getTime() >= this.cfg.refreshReuseGraceSeconds * 1000) {
        await this.repos.tokens.revokeFamily(rec.familyId, new Date());
        await this.repos.audit.add({ id: randomUUID(), actorId: rec.userId, action: 'REFRESH_TOKEN_REUSE', entityType: 'User', entityId: rec.userId, metadata: {}, createdAt: new Date() });
      }
      throw fail();
    }
    const user = await this.repos.users.findById(rec.userId);
    if (!user || user.status !== 'ACTIVE') throw fail();
    if (!(await this.repos.tokens.revokeRefresh(rec.id, new Date()))) throw fail();
    return { user: publicUser(user), ...(await this.token(user, rec.familyId)) };
  }

  /** Ends one login session. Possessing the refresh token is the proof, so no access token is needed. Always succeeds. */
  async logout(dto: RefreshDto) {
    const rec = await this.repos.tokens.findRefresh(this.hashToken(dto.refreshToken));
    if (rec) await this.repos.tokens.revokeFamily(rec.familyId, new Date());
    return { ok: true };
  }

  async logoutEverywhere(user: UserRec) {
    await this.endAllSessions(user.id);
    return { ok: true };
  }

  private async endAllSessions(userId: string) {
    const u = await this.repos.users.findById(userId);
    if (u) await this.repos.users.update(userId, { tokenVersion: u.tokenVersion + 1 });
    await this.repos.tokens.revokeAllForUser(userId, new Date());
  }

  async changePassword(user: UserRec, dto: ChangePasswordDto) {
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) throw new ForbiddenException('Your current password is not correct.');
    if (dto.currentPassword === dto.newPassword) throw new BadRequestException('Choose a password you have not used here before.');
    await this.repos.users.update(user.id, { passwordHash: await bcrypt.hash(dto.newPassword, this.cfg.bcryptCost) });
    await this.endAllSessions(user.id);
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id, metadata: {}, createdAt: new Date() });
    // This device stays signed in with a fresh session; every other device has to sign in again.
    const fresh = (await this.repos.users.findById(user.id))!;
    return { ok: true, ...(await this.token(fresh)) };
  }

  /** Always answers the same way so it cannot be used to find out which emails have accounts. */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.repos.users.findByEmail(dto.email.trim().toLowerCase());
    if (user && user.status === 'ACTIVE') {
      await this.sendCode(user, 'PASSWORD_RESET', 30, 'Reset your Freebie Radar password', 'Use this code in the app to choose a new password.')
        .catch((e) => this.log.warn(`Reset email failed: ${(e as Error).message}`));
    }
    return { ok: true, message: 'If an account exists for that email, we have sent a code.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.repos.users.findByEmail(dto.email.trim().toLowerCase());
    if (!user || user.status !== 'ACTIVE') throw new BadRequestException('That code is invalid or has expired. Request a new one.');
    await this.consumeCode(user, 'PASSWORD_RESET', dto.code);
    await this.repos.users.update(user.id, {
      passwordHash: await bcrypt.hash(dto.newPassword, this.cfg.bcryptCost),
      // Getting the code by email proves the address is theirs.
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    });
    await this.endAllSessions(user.id);
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id, metadata: {}, createdAt: new Date() });
    return { ok: true };
  }

  async sendVerificationCode(user: UserRec) {
    if (user.emailVerifiedAt) return { ok: true, verified: true };
    let sent: boolean;
    try { sent = await this.sendVerification(user); } catch { throw new HttpException('We could not send the email right now. Try again shortly.', 503); }
    if (!sent) throw new HttpException(`A code was sent a moment ago. Wait ${this.cfg.codeResendSeconds} seconds before asking for another.`, 429);
    return { ok: true, verified: false };
  }

  async verifyEmail(user: UserRec, dto: CodeDto) {
    if (user.emailVerifiedAt) return { ok: true, verified: true };
    await this.consumeCode(user, 'EMAIL_VERIFY', dto.code);
    const updated = await this.repos.users.update(user.id, { emailVerifiedAt: new Date() });
    return { ok: true, verified: true, user: publicUser(updated!) };
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
    await this.repos.tokens.revokeAllForUser(user.id, new Date());
    await this.repos.users.update(user.id, {
      status: 'DELETED',
      email: `deleted+${user.id}@invalid.local`,
      displayName: 'Deleted user',
      passwordHash: '',
      prefs: { ...user.prefs, homeLat: null, homeLng: null, homeLabel: null, pushToken: null },
    });
    const own = await this.repos.listings.search({ sellerUserId: user.id, publicOnly: false, sort: 'newest', offset: 0, limit: 1000 });
    for (const l of own.items) await this.repos.listings.update(l.id, { status: 'REMOVED' });
    // Photos are personal data too: delete them with the account.
    await this.storage.deletePrefix(`u/${user.id}/`).catch(() => 0);
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

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @Post('auth/refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @Post('auth/logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto);
  }

  @Throttle({ default: { limit: MAIL_LIMIT, ttl: 60_000 } })
  @Post('auth/forgot-password')
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @Post('auth/reset-password')
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('auth/logout-everywhere')
  logoutEverywhere(@CurrentUser() user: UserRec) {
    return this.auth.logoutEverywhere(user);
  }

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('me/password')
  changePassword(@CurrentUser() user: UserRec, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto);
  }

  @Throttle({ default: { limit: MAIL_LIMIT, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('me/email/send-code')
  sendCode(@CurrentUser() user: UserRec) {
    return this.auth.sendVerificationCode(user);
  }

  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('me/email/verify')
  verify(@CurrentUser() user: UserRec, @Body() dto: CodeDto) {
    return this.auth.verifyEmail(user, dto);
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
