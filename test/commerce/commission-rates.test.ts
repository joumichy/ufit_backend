import {describe, expect, it} from 'vitest';
import {calculateRateBps, formatRateBps, parseStoredRate, calculateCommissionAmount, commissionRateSchema} from '../../src/modules/commissions/domain/commission-rule.contract';

const rate = {baseRateBps: 1000, bonusRateBps: 500, maxRateBps: null};
describe('Explicit commission rates', () => {
  it('round-trips every supported basis point through the actual numeric(5,4) storage boundary', () => {
    for (let value = 0; value <= 10_000; value++) expect(parseStoredRate(formatRateBps(value))).toBe(value);
  });
  it('adds only the configured bonus and applies the configured cap', () => {
    expect(calculateRateBps(rate)).toBe(1500);
    expect(calculateRateBps({...rate, maxRateBps: 1200})).toBe(1200);
    expect(calculateRateBps({...rate, baseRateBps: 9000, bonusRateBps: 9000})).toBe(10000);
    expect(calculateRateBps({...rate, baseRateBps: 0, bonusRateBps: 0})).toBe(0);
  });
  it.each([-1, 10001, 0.5, NaN, Infinity])('rejects invalid rate %s instead of rounding or clamping the input', value => {
    expect(commissionRateSchema.safeParse({...rate, baseRateBps: value}).success).toBe(false);
  });
  it('rejects implicit and decimal API contracts', () => {
    expect(commissionRateSchema.safeParse({baseRateBps: 1000}).success).toBe(false);
    expect(commissionRateSchema.safeParse({...rate, baseRate: 0.1}).success).toBe(false);
    expect(() => parseStoredRate('0.05')).toThrow();
    expect(() => parseStoredRate('1.0001')).toThrow();
  });
  it('rounds amounts half up with integer arithmetic', () => {
    expect(calculateCommissionAmount(12990, 500)).toBe(650);
    expect(calculateCommissionAmount(1, 5000)).toBe(1);
    expect(calculateCommissionAmount(Number.MAX_SAFE_INTEGER, 10000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => calculateCommissionAmount(Number.MAX_SAFE_INTEGER + 1, 500)).toThrow();
    expect(() => calculateCommissionAmount(1.5, 500)).toThrow();
  });
});
