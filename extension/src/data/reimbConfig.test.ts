import { describe, it, expect } from 'vitest';
import { needsWNumberLookup } from './reimbConfig';

describe('needsWNumberLookup', () => {
  it('flags a credit-card account id', () => {
    expect(needsWNumberLookup('C15N6GK56CAD')).toBe(true);
  });

  it('does not flag a chequing account id', () => {
    expect(needsWNumberLookup('WK20NLH34CAD')).toBe(false);
  });

  it('does not flag the other prefixes the validator accepts', () => {
    expect(needsWNumberLookup('H15N6GK56CAD')).toBe(false);
    expect(needsWNumberLookup('N15N6GK56CAD')).toBe(false);
  });

  it('is case- and whitespace-insensitive, matching how the field is entered', () => {
    expect(needsWNumberLookup('  c15n6gk56cad ')).toBe(true);
  });

  it('does not flag an empty or missing value', () => {
    // Empty means "no account id yet" — that is accountIdValid's problem, not this one.
    expect(needsWNumberLookup('')).toBe(false);
    expect(needsWNumberLookup('   ')).toBe(false);
  });
});
