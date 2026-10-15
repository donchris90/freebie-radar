/**
 * Message safety rules. Pure functions, no I/O.
 *
 * People talk inside the app so nobody has to hand out an email address or phone number to a stranger.
 * Contact details typed into a message are refused with an explanation. Messages that look like the
 * usual scam openers are delivered but flagged, so the recipient sees a caution next to them.
 */

export type GuardResult = { ok: true; flagged: boolean; flagReason?: string } | { ok: false; reason: string };

const EMAIL = /[A-Za-z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\sat\s)\s*[A-Za-z0-9-]+\s*(?:\.|\(dot\)|\[dot\]|\sdot\s)\s*[A-Za-z]{2,}/i;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|co|io|me|ly|app|link|info|biz|xyz|uk|ca|ng)\b/i;
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;

const PAYMENT_FLAGS = /\b(deposit|pay(?:ment)?\s+(?:first|in advance|upfront|up front)|advance payment|send (?:me )?(?:the )?money|gift ?cards?|western union|money ?gram|wire transfer|bitcoin|crypto|zelle|cash ?app|shipping fee|courier (?:will|fee)|paypal friends)\b/i;
const OFF_PLATFORM = /\b(whats ?app|telegram|signal|snapchat|wechat|viber|text me|call me|dm me|email me)\b/i;

export function hasPhoneNumber(text: string): boolean {
  // Dates look like long digit runs; take them out first.
  const cleaned = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, ' ');
  for (const m of cleaned.match(PHONE_CANDIDATE) ?? []) {
    if (m.replace(/\D/g, '').length >= 8) return true;
  }
  return false;
}

export function guardMessage(body: string): GuardResult {
  if (EMAIL.test(body)) return { ok: false, reason: 'Please do not share email addresses in chat. Keep the conversation here so you stay protected.' };
  if (hasPhoneNumber(body)) return { ok: false, reason: 'Please do not share phone numbers in chat. Agree a pickup time and place here instead.' };
  if (URL_LIKE.test(body)) return { ok: false, reason: 'Links are not allowed in chat. If you need to show something, describe it or add photos to the listing.' };
  if (PAYMENT_FLAGS.test(body)) return { ok: true, flagged: true, flagReason: 'This message mentions paying in advance or an unusual payment method. Never pay before you have seen the item.' };
  if (OFF_PLATFORM.test(body)) return { ok: true, flagged: true, flagReason: 'This message asks to continue outside the app. Staying in the app keeps you protected.' };
  return { ok: true, flagged: false };
}

export function previewOf(body: string, max = 80): string {
  const t = body.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
