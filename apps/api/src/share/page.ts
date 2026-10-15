/**
 * Public share page for one listing: what a Facebook group, Reddit post or text message shows as a link preview,
 * and what a person sees if they open the link without the app. Pure functions so every character that reaches the
 * page can be tested: nothing from a listing is ever inserted without escaping.
 */
export function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface ShareView {
  id: string;
  title: string;
  description: string;
  priceLabel: string;
  isFree: boolean;
  /** The label the member chose (a neighbourhood or town). Never coordinates. */
  area: string | null;
  freshness: string;
  /** Only https images are used for previews. */
  image: string | null;
  spotted: boolean;
  reserved: boolean;
  /** Absolute URL of this page when the server knows its public address. */
  pageUrl: string | null;
  deepLink: string;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const safeHttps = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#14181f}
main{max-width:520px;margin:0 auto;padding:16px}.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.card img{display:block;width:100%;max-height:340px;object-fit:cover;background:#e6e9ee}.body{padding:16px}
h1{font-size:22px;margin:0 0 6px}.price{font-weight:700;color:#0a7a3d;font-size:18px}.muted{color:#5b6472;font-size:14px}
.tag{display:inline-block;background:#eef2ff;color:#2b3a8f;border-radius:999px;padding:2px 10px;font-size:13px;margin-right:6px}
.btn{display:block;text-align:center;padding:14px;border-radius:12px;background:#0a7a3d;color:#fff;text-decoration:none;font-weight:600;margin-top:16px}
.btn.alt{background:#fff;color:#0a7a3d;border:1px solid #0a7a3d;margin-top:8px}p{margin:10px 0}footer{margin:16px 4px;color:#5b6472;font-size:13px}`;

export function renderSharePage(v: ShareView): string {
  const title = `${v.isFree ? 'Free: ' : ''}${v.title}`;
  const desc = clip([v.priceLabel, v.area, v.description].filter(Boolean).join(' · '), 200);
  const image = safeHttps(v.image);
  const tags = [v.spotted ? 'Spotted by a member' : '', v.reserved ? 'Reserved' : ''].filter(Boolean);
  const meta = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Freebie Radar">`,
    `<meta property="og:title" content="${escapeHtml(clip(title, 90))}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    v.pageUrl ? `<meta property="og:url" content="${escapeHtml(v.pageUrl)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
  ].filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(clip(title, 90))} · Freebie Radar</title>
<meta name="description" content="${escapeHtml(desc)}">
${meta}
<style>${STYLE}</style></head><body><main><div class="card">
${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : ''}
<div class="body">
${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
<h1>${escapeHtml(v.title)}</h1>
<div class="price">${escapeHtml(v.priceLabel)}</div>
${v.area ? `<p class="muted">Near ${escapeHtml(v.area)} (approximate area)</p>` : ''}
${v.description ? `<p>${escapeHtml(clip(v.description, 600))}</p>` : ''}
<p class="muted">${escapeHtml(v.freshness)}</p>
<a class="btn" href="${escapeHtml(v.deepLink)}">Open in Freebie Radar</a>
${v.appStoreUrl ? `<a class="btn alt" href="${escapeHtml(v.appStoreUrl)}">Get it on the App Store</a>` : ''}
${v.playStoreUrl ? `<a class="btn alt" href="${escapeHtml(v.playStoreUrl)}">Get it on Google Play</a>` : ''}
</div></div>
<footer>Exact location, messaging and reservations are available in the app. Never pay in advance or share bank details.</footer>
</main></body></html>`;
}

export function renderGonePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>No longer available · Freebie Radar</title>
<style>${STYLE}</style></head><body><main><div class="card"><div class="body">
<h1>This listing is no longer available</h1>
<p class="muted">It may have been taken, removed or expired. New free items appear all the time in Freebie Radar.</p>
</div></div></main></body></html>`;
}
