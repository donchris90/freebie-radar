import { canReportNoShow, isActiveClaim, MIN_OUTCOMES, NO_SHOW_WAIT_MS, reliability } from './claims';

const t = (collected: number, noShow = 0, lateCancel = 0, given = 0) => ({ collected, noShow, lateCancel, given });

describe('reliability', () => {
  it('says nothing judgemental until there are enough outcomes', () => {
    expect(reliability(t(0))).toMatchObject({ label: 'NEW', rate: null, text: 'New to collecting' });
    expect(reliability(t(1, 1))).toMatchObject({ label: 'NEW', rate: null, text: '1 of 2 collected so far' });
    expect(MIN_OUTCOMES).toBe(3);
  });

  it('labels by the share of reserved items actually collected', () => {
    expect(reliability(t(9, 1))).toMatchObject({ label: 'RELIABLE', rate: 0.9, text: 'Collected 9 of 10 reserved items' });
    expect(reliability(t(3, 1, 1))).toMatchObject({ label: 'MOSTLY_RELIABLE', rate: 0.6 });
    expect(reliability(t(1, 3))).toMatchObject({ label: 'UNRELIABLE', rate: 0.25 });
  });

  it('counts late cancellations as outcomes but never counts items given', () => {
    expect(reliability(t(2, 0, 1)).outcomes).toBe(3);
    expect(reliability(t(0, 0, 0, 40))).toMatchObject({ outcomes: 0, label: 'NEW' });
  });
});

describe('claim rules', () => {
  it('treats only held and confirmed claims as active', () => {
    expect(['HELD', 'CONFIRMED'].every((s) => isActiveClaim(s as any))).toBe(true);
    expect(['COLLECTED', 'CANCELLED', 'EXPIRED', 'NO_SHOW'].some((s) => isActiveClaim(s as any))).toBe(false);
  });

  it('lets a giver report a no-show only after waiting', () => {
    const confirmed = new Date('2026-01-01T10:00:00Z');
    expect(canReportNoShow(null, confirmed)).toBe(false);
    expect(canReportNoShow(confirmed, new Date(confirmed.getTime() + NO_SHOW_WAIT_MS - 1))).toBe(false);
    expect(canReportNoShow(confirmed, new Date(confirmed.getTime() + NO_SHOW_WAIT_MS))).toBe(true);
  });
});
