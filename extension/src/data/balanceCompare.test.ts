import { describe, it, expect } from 'vitest';
import { compareBalance } from './balanceCompare';

describe('compareBalance', () => {
  it("'abs' keeps Overpayment's rule: a negative running balance matches its absolute amount", () => {
    expect(compareBalance(-500, 500, 'abs')).toMatchObject({ matches: true, nothingOwed: false });
    expect(compareBalance(500, 500, 'abs').matches).toBe(true);
    expect(compareBalance(-500, null, 'abs')).toEqual({ matches: false, diff: null, nothingOwed: false });
  });

  it("'owed' matches a positive i2c running balance against the amount owed", () => {
    expect(compareBalance(148.03, 148.03, 'owed')).toMatchObject({ matches: true, nothingOwed: false });
  });

  it("'owed' never matches a card in credit, and flags nothing owed", () => {
    const r = compareBalance(-148.03, 148.03, 'owed');
    expect(r.matches).toBe(false);
    expect(r.nothingOwed).toBe(true);
  });

  it("'owed' flags a zero balance as nothing owed", () => {
    expect(compareBalance(0, null, 'owed').nothingOwed).toBe(true);
  });

  it("'owed' reports the difference", () => {
    const r = compareBalance(150, 148.03, 'owed');
    expect(r.matches).toBe(false);
    expect(r.diff).toBeCloseTo(1.97, 2);
  });
});
