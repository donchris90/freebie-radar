import { applyBasisPoints, assertCurrency, assertMinor, MoneyError, sumMinor } from './money';

export const RESALE_DISCLAIMER =
  'These figures are estimates, not guaranteed profits. The resale price you enter may not be achievable, and fees, costs and demand can change.';

export interface ResaleInput {
  currency: string;
  purchaseMinor: number;
  resaleMinor: number;
  transportMinor?: number;
  repairMinor?: number;
  otherMinor?: number;
  /** Platform selling fee as basis points of the resale price (100 = 1%). */
  feeBasisPoints?: number;
  /** Fixed per-sale fee in minor units. */
  feeFixedMinor?: number;
}

export interface ResaleResult {
  currency: string;
  totalAcquisitionCostMinor: number;
  sellingFeesMinor: number;
  grossProfitMinor: number; // resale - acquisition cost, before selling fees
  netProfitMinor: number; // after selling fees
  /** Net profit as basis points of resale price; null when resale price is zero. */
  marginBasisPoints: number | null;
  /** Lowest resale price at which net profit is >= 0; null when no price can break even. */
  breakEvenResaleMinor: number | null;
  disclaimer: string;
}

function fees(resaleMinor: number, bps: number, fixed: number): number {
  return applyBasisPoints(resaleMinor, bps) + fixed;
}

export function calculateResale(input: ResaleInput): ResaleResult {
  const currency = assertCurrency(input.currency);
  const purchase = assertMinor(input.purchaseMinor, 'purchase price');
  const resale = assertMinor(input.resaleMinor, 'resale price');
  const transport = assertMinor(input.transportMinor ?? 0, 'transport cost');
  const repair = assertMinor(input.repairMinor ?? 0, 'repair cost');
  const other = assertMinor(input.otherMinor ?? 0, 'other expenses');
  const bps = input.feeBasisPoints ?? 0;
  const fixed = assertMinor(input.feeFixedMinor ?? 0, 'fixed fee');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new MoneyError('Fee must be between 0% and 100%');

  const cost = sumMinor(purchase, transport, repair, other);
  const sellingFees = fees(resale, bps, fixed);
  const gross = resale - cost;
  const net = resale - sellingFees - cost;
  const margin = resale > 0 ? Math.round((net * 10_000) / resale) : null;

  return {
    currency,
    totalAcquisitionCostMinor: cost,
    sellingFeesMinor: sellingFees,
    grossProfitMinor: gross,
    netProfitMinor: net,
    marginBasisPoints: margin,
    breakEvenResaleMinor: breakEven(cost, bps, fixed),
    disclaimer: RESALE_DISCLAIMER,
  };
}

/** Smallest resale price P where P - fees(P) - cost >= 0, with the same rounding as the fee calculation. */
function breakEven(cost: number, bps: number, fixed: number): number | null {
  if (bps >= 10_000) return cost === 0 && fixed === 0 ? 0 : null;
  const net = (p: number) => p - fees(p, bps, fixed) - cost;
  let p = Math.ceil(((cost + fixed) * 10_000) / (10_000 - bps));
  // Rounding in the fee can shift the exact answer by a unit or two; settle it deterministically.
  for (let i = 0; i < 5 && p > 0 && net(p - 1) >= 0; i++) p -= 1;
  for (let i = 0; i < 5 && net(p) < 0; i++) p += 1;
  return net(p) >= 0 ? p : null;
}

export interface ComparedOpportunity {
  id: string;
  label: string;
  result: ResaleResult;
}

/** Orders saved calculations by net profit, then margin, so users can compare opportunities. */
export function compareOpportunities(items: ComparedOpportunity[]): ComparedOpportunity[] {
  return [...items].sort((a, b) => {
    if (b.result.netProfitMinor !== a.result.netProfitMinor) return b.result.netProfitMinor - a.result.netProfitMinor;
    return (b.result.marginBasisPoints ?? -Infinity) - (a.result.marginBasisPoints ?? -Infinity);
  });
}
