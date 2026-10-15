/**
 * Rules-based scam-risk signals. These are prompts for caution and human review, never proof.
 * Output wording is deliberately neutral: signals describe the LISTING, not the person.
 * AI output alone never establishes that anything is trustworthy.
 */

export type RiskLevel = 'NO_MAJOR_SIGNALS' | 'EXERCISE_CAUTION' | 'UNDER_REVIEW';

export const RISK_LABELS: Record<RiskLevel, string> = {
  NO_MAJOR_SIGNALS: 'No major risk signals detected',
  EXERCISE_CAUTION: 'Exercise caution',
  UNDER_REVIEW: 'Under review',
};

export const SAFETY_GUIDANCE = [
  'Meet in a public place where practical.',
  'Inspect the item before you pay.',
  'Be wary of requests for deposits, gift cards or other advance payments.',
  'Report anything that looks wrong.',
];

export interface RiskInput {
  title: string;
  description: string;
  priceMinor: number | null;
  isFree: boolean;
  condition: string;
  sellerAccountAgeHours?: number | null;
  sellerListingsLast24h?: number;
  /** How many of the seller's listings in the recent window share this listing's content hash. */
  sameContentBySeller?: number;
  openDistinctReporters?: number;
  /** Median of valid comparables, when evidence exists. */
  comparableMedianMinor?: number | null;
  comparableSampleSize?: number;
}

export interface RiskSignal {
  code: string;
  points: number;
  message: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  label: string;
  points: number;
  signals: RiskSignal[];
}

const ADVANCE_PAYMENT =
  /\b(deposit|advance payment|pay (me )?(first|upfront|in advance)|send (the )?money first|western union|moneygram|gift ?cards?|wire transfer|bitcoin|crypto(currency)?|zelle|cash ?app|venmo me|pay(ing)? before (viewing|collection|you see))\b/i;
const OFF_PLATFORM = /\b(whats ?app|telegram|text me on|email me at|contact me (off|outside)|dm me on)\b/i;
const FREE_WORD = /\bfree\b(?!\s+(delivery|shipping|postage|p&p|returns|wifi|trial))/i;
const BROKEN_WORDS = /\b(broken|cracked|not working|doesn'?t work|for parts|faulty|spares or repair)\b/i;

export function assessRisk(input: RiskInput): RiskAssessment {
  const text = `${input.title} ${input.description}`;
  const signals: RiskSignal[] = [];
  const add = (code: string, points: number, message: string) => signals.push({ code, points, message });

  if (ADVANCE_PAYMENT.test(text)) {
    add('ADVANCE_PAYMENT_MENTIONED', 40, 'The listing text mentions deposits or advance/unusual payment methods.');
  }
  if (OFF_PLATFORM.test(text)) {
    add('OFF_PLATFORM_CONTACT', 15, 'The listing asks buyers to continue outside the app.');
  }
  if ((input.sameContentBySeller ?? 0) >= 3) {
    add('REPEATED_CONTENT', 25, 'The same listing text appears several times from one account.');
  }
  if (
    input.priceMinor !== null &&
    input.priceMinor > 0 &&
    input.comparableMedianMinor &&
    (input.comparableSampleSize ?? 0) >= 5 &&
    input.priceMinor < input.comparableMedianMinor * 0.2
  ) {
    add('UNUSUALLY_LOW_PRICE', 20, 'The price is far below comparable listings. Verify the item before paying.');
  }
  if ((input.sellerAccountAgeHours ?? Infinity) < 24 && (input.sellerListingsLast24h ?? 0) >= 5) {
    add('NEW_ACCOUNT_BURST', 20, 'A very new account has posted many listings in a short time.');
  }
  const reporters = input.openDistinctReporters ?? 0;
  if (reporters >= 5) add('MANY_REPORTS', 60,`${reporters} different users have reported this listing.`);
  else if (reporters >= 3) add('SEVERAL_REPORTS', 25, `${reporters} different users have reported this listing.`);

  if (FREE_WORD.test(input.title) && input.priceMinor !== null && input.priceMinor > 0 && !input.isFree) {
    add('CONTRADICTORY_PRICE', 15, 'The title says free but a price is set.');
  }
  if (input.isFree && input.priceMinor !== null && input.priceMinor > 0) {
    add('CONTRADICTORY_PRICE', 15, 'The listing is marked free but also has a price.');
  }
  if ((input.condition === 'NEW' || input.condition === 'LIKE_NEW') && BROKEN_WORDS.test(input.description)) {
    add('CONTRADICTORY_CONDITION', 10, 'The condition says new/like new but the description mentions damage or faults.');
  }

  // De-duplicate repeated codes (the two price contradiction branches are mutually exclusive in practice).
  const unique = [...new Map(signals.map((s) => [s.code, s])).values()];
  const points = unique.reduce((s, x) => s + x.points, 0);
  const level: RiskLevel = points >= 60 ? 'UNDER_REVIEW' : points > 0 ? 'EXERCISE_CAUTION' : 'NO_MAJOR_SIGNALS';
  return { level, label: RISK_LABELS[level], points, signals: unique };
}
