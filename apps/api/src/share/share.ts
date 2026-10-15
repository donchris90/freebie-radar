import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { freshnessLabel, isPubliclyListed } from '../core/lifecycle';
import { formatPriceLabel } from '../core/money';
import { REPOS, Repos } from '../domain/ports';
import { SPOTTED } from '../listings/listings';
import { renderGonePage, renderSharePage } from './page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only first-party inline styles and https images may load on these pages. */
const CSP = "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

@Controller()
export class ShareController {
  constructor(@Inject(REPOS) private readonly repos: Repos, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get('s/:id')
  async page(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const l = UUID.test(id) ? await this.repos.listings.findById(id) : null;
    // Hidden, held, removed and duplicate listings look exactly like ones that never existed.
    if (!l || !isPubliclyListed(l.status) || l.duplicateOfId || l.riskLevel === 'UNDER_REVIEW') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).send(renderGonePage());
    }
    const now = new Date();
    const reserved = !!(await this.repos.claims.activeForListing(l.id));
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.status(200).send(
      renderSharePage({
        id: l.id,
        title: l.title,
        description: l.description,
        priceLabel: formatPriceLabel(l.priceMinor, l.currency, 'en-US'),
        isFree: l.isFree && l.priceMinor === 0,
        area: l.locationLabel,
        freshness: freshnessLabel(now, l.postedAt, l.lastConfirmedAt, l.status, 'en-US').label,
        image: l.imageUrls[0] ?? null,
        spotted: l.sourceKey === SPOTTED,
        reserved,
        pageUrl: this.cfg.publicBaseUrl ? `${this.cfg.publicBaseUrl}/s/${l.id}` : null,
        deepLink: `${this.cfg.share.appScheme}://listing/${l.id}`,
        appStoreUrl: this.cfg.share.appStoreUrl,
        playStoreUrl: this.cfg.share.playStoreUrl,
      }),
    );
  }
}
