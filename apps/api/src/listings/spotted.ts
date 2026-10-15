import { BadRequestException, Body, Controller, ForbiddenException, Inject, Injectable, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/auth';
import { APP_CONFIG, AppConfig } from '../config/config';
import { isPubliclyListed } from '../core/lifecycle';
import { UserRec } from '../domain/models';
import { REPOS, Repos } from '../domain/ports';
import { ReportsService } from '../engagement/engagement';
import { CreateListingDto, ListingsService, SPOTTED } from './listings';

const urlOpts = { protocols: ['http', 'https'], require_protocol: true, require_tld: false };

/** A curb find: something free the member saw outside, with a photo and a pin. It expires on its own. */
export class SpottedDto {
  @IsString() @Length(3, 120) title!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() categoryKey?: string;
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
  @IsOptional() @IsString() @MaxLength(100) locationLabel?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsUrl(urlOpts, { each: true }) imageUrls!: string[];
}

@Injectable()
export class SpottedService {
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly listings: ListingsService,
    private readonly reports: ReportsService,
  ) {}

  create(user: UserRec, dto: SpottedDto) {
    const base: CreateListingDto = { title: dto.title, description: dto.description, categoryKey: dto.categoryKey, lat: dto.lat, lng: dto.lng, locationLabel: dto.locationLabel, imageUrls: dto.imageUrls };
    return this.listings.create(user, base, { spotted: true });
  }

  /**
   * "It's gone". The member who spotted it closes it at once. Anyone else adds a report; a couple of different people
   * saying it is gone hides it. One person alone cannot take down someone else's find.
   */
  async gone(user: UserRec, id: string) {
    const l = await this.repos.listings.findById(id);
    if (!l || !isPubliclyListed(l.status)) throw new NotFoundException('Listing not found');
    if (l.sourceKey !== SPOTTED) throw new BadRequestException('This button is for items other members spotted. Use Report on other listings.');
    if (l.sellerUserId === user.id) {
      await this.listings.sellerAvailability(user, id, 'SELLER_MARKED_UNAVAILABLE');
      return { gone: true, status: 'CONFIRMED_UNAVAILABLE' };
    }
    if (this.cfg.requireVerifiedEmail && !user.emailVerifiedAt && user.role === 'USER') {
      throw new ForbiddenException('Verify your email first. Open Profile and enter the code we sent you.');
    }
    await this.reports.report(user, id, { reason: 'UNAVAILABLE' });
    const after = await this.repos.listings.findById(id);
    return { gone: !!after && after.status !== 'ACTIVE', status: after?.status ?? 'REMOVED', thanks: true };
  }
}

@Controller()
@UseGuards(JwtAuthGuard)
export class SpottedController {
  constructor(private readonly svc: SpottedService) {}

  @Post('listings/spotted')
  create(@CurrentUser() u: UserRec, @Body() dto: SpottedDto) { return this.svc.create(u, dto); }

  @Post('listings/:id/gone')
  gone(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.gone(u, id); }
}
