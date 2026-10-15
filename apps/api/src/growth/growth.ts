import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, MaxLength, validateSync } from 'class-validator';
import { randomInt, randomUUID } from 'crypto';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/auth';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CsvError, csvToObjects } from '../core/csv';
import { CONDITIONS, ReferralCodeRec, UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { CreateListingDto, ListingsService } from '../listings/listings';

const DAY = 86_400_000;
/** No I, O, 0 or 1: codes are read aloud and typed from screenshots. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (prefix: string, n: number) => prefix + Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const STATS_CAP = 2000;

// ================================================================== referrals

export class CreateAmbassadorCodeDto {
  @IsString() @Length(2, 80) label!: string;
  /** Leave out to get a generated code. Letters and digits only. */
  @IsOptional() @Matches(/^[A-Za-z0-9]{4,20}$/) code?: string;
}
export class SetActiveDto {
  @IsBoolean() active!: boolean;
}

@Injectable()
export class ReferralService {
  constructor(@Inject(REPOS) private readonly repos: Repos) {}

  /** Every member has one invite code, created the first time they ask. */
  async memberCode(user: UserRec): Promise<ReferralCodeRec> {
    const existing = await this.repos.referrals.findByOwner(user.id);
    if (existing) return existing;
    for (let tries = 0; tries < 10; tries++) {
      const made = await this.repos.referrals.insert({ code: randomCode('FR', 6), label: user.displayName, kind: 'MEMBER', ownerUserId: user.id, active: true, createdAt: new Date() });
      if (made) return made;
    }
    throw new HttpException('Could not create an invite code. Please try again.', HttpStatus.SERVICE_UNAVAILABLE);
  }

  /**
   * What a code has brought in. These numbers are evidence to review, not proof: they count accounts and
   * activity, and a determined person can fake both. Check before paying anyone on the strength of them.
   */
  async stats(code: string) {
    const referred = await this.repos.users.idsReferredBy(code, STATS_CAP);
    const ids = referred.map((r) => r.id);
    return {
      signups: referred.length,
      verifiedSignups: referred.filter((r) => r.emailVerifiedAt).length,
      listingsPosted: await this.repos.listings.countBySellerIds(ids),
      itemsGivenAndCollected: await this.repos.claims.countCollectedForGivers(ids),
      capped: referred.length >= STATS_CAP,
    };
  }

  async mine(user: UserRec) {
    const rec = await this.memberCode(user);
    const s = await this.stats(rec.code);
    return { code: rec.code, signups: s.signups, verifiedSignups: s.verifiedSignups };
  }

  async adminList() {
    const all = await this.repos.referrals.list();
    // Member codes are listed only when someone has actually signed up with them; ambassador codes always.
    const rows = await Promise.all(all.map(async (r) => ({ ...r, createdAt: r.createdAt.toISOString(), stats: await this.stats(r.code) })));
    return { items: rows.filter((r) => r.kind === 'AMBASSADOR' || r.stats.signups > 0) };
  }

  async createAmbassador(admin: UserRec, dto: CreateAmbassadorCodeDto) {
    const code = dto.code ? dto.code.toUpperCase() : randomCode('AM', 6);
    const made = await this.repos.referrals.insert({ code, label: dto.label.trim(), kind: 'AMBASSADOR', ownerUserId: null, active: true, createdAt: new Date() });
    if (!made) throw new ConflictException('That code already exists. Choose another.');
    await this.repos.audit.add({ id: randomUUID(), actorId: admin.id, action: 'REFERRAL_CODE_CREATED', entityType: 'ReferralCode', entityId: code, metadata: { label: made.label }, createdAt: new Date() });
    return { ...made, createdAt: made.createdAt.toISOString() };
  }

  async setActive(admin: UserRec, code: string, active: boolean) {
    const r = await this.repos.referrals.setActive(code.toUpperCase(), active);
    if (!r) throw new NotFoundException('Code not found');
    await this.repos.audit.add({ id: randomUUID(), actorId: admin.id, action: active ? 'REFERRAL_CODE_ENABLED' : 'REFERRAL_CODE_DISABLED', entityType: 'ReferralCode', entityId: r.code, metadata: {}, createdAt: new Date() });
    return { ...r, createdAt: r.createdAt.toISOString() };
  }
}

@Controller()
export class ReferralController {
  constructor(private readonly svc: ReferralService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me/referral')
  mine(@CurrentUser() u: UserRec) { return this.svc.mine(u); }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Get('admin/referral-codes')
  list() { return this.svc.adminList(); }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post('admin/referral-codes')
  create(@CurrentUser() u: UserRec, @Body() dto: CreateAmbassadorCodeDto) { return this.svc.createAmbassador(u, dto); }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post('admin/referral-codes/:code/active')
  setActive(@CurrentUser() u: UserRec, @Param('code') code: string, @Body() dto: SetActiveDto) { return this.svc.setActive(u, code, dto.active); }
}

// ================================================================== organisations (bulk upload)

export class ImportCsvDto {
  @IsString() @MaxLength(300_000) csv!: string;
}
export class SetOrganisationDto {
  @IsEmail() email!: string;
  @IsBoolean() enabled!: boolean;
}

export const IMPORT_COLUMNS = ['title', 'description', 'category', 'condition', 'price', 'currency', 'location_label', 'lat', 'lng', 'image_url', 'available_days'];
const TEMPLATE = `${IMPORT_COLUMNS.join(',')}\n"Oak desk, 2 drawers","Solid oak, small mark on one side",furniture,GOOD,0,,"Downtown Leeds",,,https://example.com/photos/desk.jpg,7\n`;

export interface ImportRowResult {
  /** Line number in the file, counting the header as line 1. */
  line: number;
  ok: boolean;
  id?: string;
  error?: string;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

@Injectable()
export class OrganisationService {
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly listings: ListingsService,
  ) {}

  /** Admin approves (or removes) an organisation account. Staff accounts are never changed here. */
  async setOrganisation(admin: UserRec, dto: SetOrganisationDto) {
    const u = await this.repos.users.findByEmail(dto.email.trim().toLowerCase());
    if (!u || u.status === 'DELETED') throw new NotFoundException('No account with that email');
    if (u.role === 'ADMIN' || u.role === 'MODERATOR') throw new BadRequestException('Staff accounts cannot be changed here.');
    const role = dto.enabled ? 'BUSINESS' : 'USER';
    await this.repos.users.update(u.id, { role });
    await this.repos.audit.add({ id: randomUUID(), actorId: admin.id, action: dto.enabled ? 'ORGANISATION_APPROVED' : 'ORGANISATION_REMOVED', entityType: 'User', entityId: u.id, metadata: {}, createdAt: new Date() });
    return { userId: u.id, displayName: u.displayName, organisation: dto.enabled };
  }

  template() {
    return { columns: IMPORT_COLUMNS, csv: TEMPLATE, notes: [
      'price: 0 means free. Leave blank if the price is unknown.',
      'condition: NEW, LIKE_NEW, GOOD, FAIR, POOR, FOR_PARTS or UNKNOWN. Blank means UNKNOWN.',
      'lat and lng: leave blank to use the pickup location saved on your account. Set that first.',
      'currency: leave blank to use your country\'s currency.',
      'image_url: a public https link to one photo. available_days: 1 to 90, default 14.',
      'Uploading the same item twice is refused as a duplicate, so it is safe to retry a file.',
    ] };
  }

  async importCsv(user: UserRec, csv: string) {
    let parsed: ReturnType<typeof csvToObjects>;
    try {
      parsed = csvToObjects(csv);
    } catch (e) {
      if (e instanceof CsvError) throw new BadRequestException(e.message);
      throw e;
    }
    if (!parsed.columns.includes('title')) throw new BadRequestException('The first row must be a header that includes a "title" column. Download the template to start.');
    if (!parsed.rows.length) throw new BadRequestException('The file has a header but no rows.');
    if (parsed.rows.length > this.cfg.orgs.maxRowsPerImport) throw new BadRequestException(`Please upload at most ${this.cfg.orgs.maxRowsPerImport} rows at a time.`);
    const today = await this.repos.listings.countBySellerSince(user.id, new Date(Date.now() - DAY));
    if (today + parsed.rows.length > this.cfg.orgs.maxListingsPerDay) {
      throw new HttpException(`This would pass the daily limit of ${this.cfg.orgs.maxListingsPerDay} listings. You have posted ${today} in the last 24 hours.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const homeLat = user.prefs.homeLat;
    const homeLng = user.prefs.homeLng;
    const results: ImportRowResult[] = [];
    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      const line = i + 2;
      const fail = (error: string) => results.push({ line, ok: false, error });
      const lat = num(r.lat);
      const lng = num(r.lng);
      if (Number.isNaN(lat) || Number.isNaN(lng)) { fail('lat and lng must be numbers.'); continue; }
      if ((lat === undefined) !== (lng === undefined)) { fail('Give both lat and lng, or leave both blank.'); continue; }
      const useLat = lat ?? homeLat;
      const useLng = lng ?? homeLng;
      if (useLat === null || useLat === undefined || useLng === null || useLng === undefined) { fail('No location: add lat and lng, or save a pickup location on your account first.'); continue; }
      const condition = r.condition ? r.condition.toUpperCase().replace(/[\s-]+/g, '_') : undefined;
      if (condition && !CONDITIONS.includes(condition as never)) { fail(`Unknown condition "${r.condition}".`); continue; }
      const days = num(r.available_days);
      const plain = {
        title: r.title,
        description: r.description || undefined,
        categoryKey: r.category ? r.category.toLowerCase() : undefined,
        condition,
        price: r.price || undefined,
        currency: r.currency ? r.currency.toUpperCase() : undefined,
        lat: useLat,
        lng: useLng,
        locationLabel: r.location_label || user.prefs.homeLabel || undefined,
        imageUrls: r.image_url ? [r.image_url] : undefined,
        availabilityDays: days,
      };
      const dto = plainToInstance(CreateListingDto, plain);
      const problems = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
      if (problems.length) { fail(problems.flatMap((p) => Object.values(p.constraints ?? {})).join('; ')); continue; }
      try {
        const made = await this.listings.create(user, dto);
        results.push({ line, ok: true, id: made.id });
      } catch (e) {
        const msg = e instanceof HttpException ? this.messageOf(e) : 'Could not create this listing.';
        fail(msg);
      }
    }
    const created = results.filter((x) => x.ok).length;
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'ORG_IMPORT', entityType: 'User', entityId: user.id, metadata: { rows: results.length, created }, createdAt: new Date() });
    return { total: results.length, created, failed: results.length - created, ignoredColumns: parsed.columns.filter((c) => c && !IMPORT_COLUMNS.includes(c)), results };
  }

  private messageOf(e: HttpException): string {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    const m = (r as { message?: string | string[] }).message;
    return Array.isArray(m) ? m.join('; ') : m ?? e.message;
  }
}

const IMPORT_LIMIT = Number(process.env.ORG_IMPORT_THROTTLE_LIMIT ?? 20);

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganisationController {
  constructor(private readonly svc: OrganisationService) {}

  @Roles('BUSINESS', 'ADMIN')
  @Get('org/import/template')
  template() { return this.svc.template(); }

  @Roles('BUSINESS', 'ADMIN')
  @Throttle({ default: { limit: IMPORT_LIMIT, ttl: 3_600_000 } })
  @Post('org/listings/import')
  import(@CurrentUser() u: UserRec, @Body() dto: ImportCsvDto) {
    if (u.role !== 'BUSINESS' && u.role !== 'ADMIN') throw new ForbiddenException('Only approved organisations can import listings.');
    return this.svc.importCsv(u, dto.csv);
  }

  @Roles('ADMIN')
  @Post('admin/organisations')
  set(@CurrentUser() u: UserRec, @Body() dto: SetOrganisationDto) { return this.svc.setOrganisation(u, dto); }
}
