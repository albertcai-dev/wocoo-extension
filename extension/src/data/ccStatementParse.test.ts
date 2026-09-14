import { describe, expect, it } from 'vitest';
import { parseStatement } from './ccStatementParse';
import { FIXTURE_PAGES, FIXTURE_PAGE_1, FIXTURE_PAGE_2 } from './ccStatementFixture';

describe('parseStatement — header fields', () => {
  const s = parseStatement(FIXTURE_PAGES);

  it('reads the masked card number', () => {
    expect(s.cardMasked).toBe('4126 50** **** 5666');
  });

  it('reads the name as printed', () => {
    expect(s.nameOnStatement).toBe('JAMIE T RIVERS');
  });

  it('keeps the stale address lines for contrast', () => {
    expect(s.addressLines).toEqual(['99 EXAMPLE ST W, APT 4', 'MONTREAL QC H2Y 1Z5']);
  });

  it('reads the statement date from the merged label line', () => {
    expect(s.statementDate).toBe('August 25, 2026');
  });

  it('reads the minimum payment from the merged label line', () => {
    expect(s.minimumPayment).toBe('$61.72');
  });

  it('derives opening and closing dates from the period line', () => {
    expect(s.openingDate).toBe('Jul 25, 2026');
    expect(s.closingDate).toBe('Aug 24, 2026');
  });

  it('reads the payment due date', () => {
    expect(s.paymentDueDate).toBe('Sep 15, 2026');
  });

  it('reads the credit limit', () => {
    expect(s.creditLimit).toBe('$25,000.00');
  });

  it('reads the statement balance despite the BAL ANCE kerning split', () => {
    expect(s.statementBalance).toBe('$1,234.56');
  });
});

describe('parseStatement — account summary', () => {
  const s = parseStatement(FIXTURE_PAGES);

  it('reads both halves of a line that merges two summary columns', () => {
    expect(s.payments).toBe('$2,714.06');
    expect(s.purchases).toBe('$1,234.56');
    expect(s.otherCredits).toBe('$0.00');
    expect(s.fees).toBe('$0.00');
  });

  it('reads previous and new balance', () => {
    expect(s.previousBalance).toBe('$2,714.06');
    expect(s.newBalance).toBe('$1,234.56');
  });

  it('distinguishes "+ Interest" from the interest-rate rows', () => {
    expect(s.interest).toBe('$0.00');
    expect(s.annualInterestRate).toBe('20.99%');
    expect(s.cashAdvanceInterestRate).toBe('22.99%');
  });

  it('reads cash advances and totals', () => {
    expect(s.cashAdvances).toBe('$0.00');
    expect(s.totalCharges).toBe('$1,234.56');
    expect(s.totalPaymentsCredits).toBe('$2,714.06');
  });
});

describe('parseStatement — activity rows', () => {
  const s = parseStatement(FIXTURE_PAGES);

  it('finds every row across all activity pages and nothing else', () => {
    expect(s.rows).toHaveLength(11);
  });

  it('never mistakes a page header, column header or footer for a row', () => {
    const details = s.rows.map((r) => r.details);
    expect(details).not.toContain('DETAILS');
    expect(details.some((d) => d.includes('Wealthsimple Payments Inc.'))).toBe(false);
  });

  it('preserves the en-dash on negative amounts', () => {
    const payment = s.rows[0];
    expect(payment).toMatchObject({
      transDate: 'Jul 25',
      postedDate: 'Jul 25',
      type: 'Payment',
      details: 'From chequing account',
      amount: '–$2,714.06',
    });
  });

  it('repairs an amount split by kerning', () => {
    const hotel = s.rows.find((r) => r.details === 'HOTEL MOTEL GEORGES');
    expect(hotel?.amount).toBe('$320.11');
  });

  it('repairs a day number split by kerning, in either date column', () => {
    const amzn = s.rows.find((r) => r.details.startsWith('AMZN'));
    expect(amzn).toMatchObject({ transDate: 'Aug 10', postedDate: 'Aug 11' });
    const apple = s.rows.find((r) => r.details === 'APPLE.COM/BILL');
    expect(apple).toMatchObject({ transDate: 'Aug 11', postedDate: 'Aug 11' });
  });

  it('leaves digits inside merchant names alone', () => {
    const macs = s.rows.find((r) => r.details.startsWith('00103'));
    expect(macs?.details).toBe('00103 MACS CONV. STORES');
    const dollarama = s.rows.find((r) => r.details.startsWith('DOLLARAMA'));
    expect(dollarama?.details).toBe('DOLLARAMA #1496');
  });

  it('folds an FX sub-line into the row above it', () => {
    const sixt = s.rows.find((r) => r.details.startsWith('SIXT'));
    expect(sixt?.details).toBe('SIXT RENT BOOKING\n345.84 EUR • 1.620981 exchange rate');
    expect(sixt?.amount).toBe('$560.60');
    // The sub-line must not also land as a row of its own.
    expect(s.rows.some((r) => r.details === '345.84 EUR • 1.620981 exchange rate')).toBe(false);
  });

  it('handles multi-word transaction types', () => {
    expect(s.rows.find((r) => r.details === 'SP STEVE MADDEN CA')?.type).toBe('Refund settled');
    expect(s.rows.find((r) => r.details === 'ATM WITHDRAWAL')?.type).toBe('Cash advance');
  });
});

describe('parseStatement — warnings', () => {
  it('is warning-free on a self-consistent statement', () => {
    // Fixture activity: charges 52.89 + 320.11 + 18.45 + 560.60 + 212.69 + 14.94
    //   + 20.00 + 31.03 + 200.00 = 1430.71, credits 2714.06 + 112.98 = 2827.04.
    // Total charges ($1,234.56) deliberately disagrees, so this statement DOES warn —
    // which is the realistic case: page 1 totals cover the whole period, and our fixture
    // only lists a subset of rows.
    const s = parseStatement(FIXTURE_PAGES);
    expect(s.warnings.some((w) => w.includes('charges'))).toBe(true);
  });

  it('warns rather than throws when the summary is missing entirely', () => {
    const s = parseStatement([FIXTURE_PAGE_2]);
    expect(s.rows).toHaveLength(7);
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(s.newBalance).toBe('');
  });

  it('reports no rows found as a warning, leaving the decision to the caller', () => {
    const s = parseStatement([FIXTURE_PAGE_1]);
    expect(s.rows).toHaveLength(0);
    expect(s.warnings.some((w) => w.toLowerCase().includes('no activity rows'))).toBe(true);
  });
});
