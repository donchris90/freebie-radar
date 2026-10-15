import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean, Matches } from 'class-validator';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/auth';
import type { UserRec } from '../domain/models';
import { CountriesService } from './countries.service';

export class SetCountryDto {
  @IsBoolean() enabled!: boolean;
}
export class CountryParam {
  @Matches(/^[A-Za-z]{2}$/) code!: string;
}

const view = (c: { code: string; name: string; currency: string; distanceUnit: string; defaultTimeZone: string }) => ({
  code: c.code, name: c.name, currency: c.currency, distanceUnit: c.distanceUnit, timeZone: c.defaultTimeZone,
});

@Controller()
export class CountriesController {
  constructor(private readonly svc: CountriesService) {}

  /** Public: the countries currently open, for pickers in the apps. */
  @Get('countries')
  async list() {
    return { items: (await this.svc.enabled()).map(view) };
  }
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminCountriesController {
  constructor(private readonly svc: CountriesService) {}

  @Roles('ADMIN') @Get('admin/countries')
  async list() {
    return { items: (await this.svc.all()).map((c) => ({ ...view(c), enabled: c.enabled })) };
  }

  @Roles('ADMIN') @Patch('admin/countries/:code')
  async set(@CurrentUser() u: UserRec, @Param() p: CountryParam, @Body() dto: SetCountryDto) {
    const c = await this.svc.setEnabled(u.id, p.code, dto.enabled);
    return { ...view(c), enabled: c.enabled };
  }
}
