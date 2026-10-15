import { calculateResale, compareOpportunities, RESALE_DISCLAIMER } from './resale';
import { MoneyError } from './money';

describe('resale calculator', () => {
  it('computes cost, profit, margin and break-even', () => {
    const r = calculateResale({
      currency: 'USD',
      purchaseMinor: 10000,
      resaleMinor: 20000,
      transportMinor: 1000,
      repairMinor: 2000,
      otherMinor: 500,
      feeBasisPoints: 1300, // 13%
      feeFixedMinor: 0,
    });
    expect(r.totalAcquisitionCostMinor).toBe(13500);
    expect(r.sellingFeesMinor).toBe(2600);
    expect(r.grossProfitMinor).toBe(6500);
    expect(r.netProfitMinor).toBe(3900);
    expect(r.marginBasisPoints).toBe(1950); // 19.5%
    // smallest P with P - round(0.13 P) >= 13500 is 15517 (fee rounds to 2017, net 0)
    expect(r.breakEvenResaleMinor).toBe(15517);
    expect(r.disclaimer).toBe(RESALE_DISCLAIMER);
  });

  it('break-even is the smallest price with non-negative net profit', () => {
    const base = { currency: 'USD', purchaseMinor: 9999, feeBasisPoints: 1275, feeFixedMinor: 30, transportMinor: 123 };
    const be = calculateResale({ ...base, resaleMinor: 20000 }).breakEvenResaleMinor!;
    expect(calculateResale({ ...base, resaleMinor: be }).netProfitMinor).toBeGreaterThanOrEqual(0);
    expect(calculateResale({ ...base, resaleMinor: be - 1 }).netProfitMinor).toBeLessThan(0);
  });

  it('handles a free item bought for resale', () => {
    const r = calculateResale({ currency: 'GBP', purchaseMinor: 0, resaleMinor: 5000, transportMinor: 800, feeBasisPoints: 1000 });
    expect(r.totalAcquisitionCostMinor).toBe(800);
    expect(r.netProfitMinor).toBe(5000 - 500 - 800);
  });

  it('reports a loss honestly and a null margin for zero resale', () => {
    const loss = calculateResale({ currency: 'USD', purchaseMinor: 5000, resaleMinor: 3000 });
    expect(loss.netProfitMinor).toBe(-2000);
    const zero = calculateResale({ currency: 'USD', purchaseMinor: 0, resaleMinor: 0 });
    expect(zero.marginBasisPoints).toBeNull();
  });

  it('has no break-even when fees consume the whole price', () => {
    const r = calculateResale({ currency: 'USD', purchaseMinor: 100, resaleMinor: 1000, feeBasisPoints: 10000 });
    expect(r.breakEvenResaleMinor).toBeNull();
  });

  it('rejects invalid inputs', () => {
    expect(() => calculateResale({ currency: 'USD', purchaseMinor: -1, resaleMinor: 1 })).toThrow(MoneyError);
    expect(() => calculateResale({ currency: 'USD', purchaseMinor: 1.5, resaleMinor: 1 })).toThrow(MoneyError);
    expect(() => calculateResale({ currency: 'USD', purchaseMinor: 1, resaleMinor: 1, feeBasisPoints: 10001 })).toThrow(MoneyError);
  });

  it('ranks opportunities by net profit then margin', () => {
    const mk = (id: string, purchase: number, resale: number) => ({
      id,
      label: id,
      result: calculateResale({ currency: 'USD', purchaseMinor: purchase, resaleMinor: resale }),
    });
    const ordered = compareOpportunities([mk('a', 1000, 2000), mk('b', 100, 1500), mk('c', 500, 800)]);
    expect(ordered.map((o) => o.id)).toEqual(['b', 'a', 'c']);
  });
});
