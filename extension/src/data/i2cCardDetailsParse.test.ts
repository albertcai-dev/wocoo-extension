import { describe, expect, it } from 'vitest';
import { parseI2cDelinquency, readLabelValue, readProgramForLast4 } from './i2cCardDetailsParse';
import { mapI2cProgram } from './eligibilityProducts';

const LEAVES = [
  'Card Details', 'Last Five Transactions',
  'Card Reference Number:', '527024663778',
  'Card Status Reason:', '-',
  'Delinquency Status:', 'Current / Not Delinquent',
  'Collection Status:', 'Not In Collection',
  'Card Creation Date:', '07/07/2026',
  'Free Text :', 'Funds Expiry Date:', 'N/A',
];

describe('readLabelValue', () => {
  it('returns the leaf after the label', () => {
    expect(readLabelValue(LEAVES, 'Delinquency Status:')).toBe('Current / Not Delinquent');
    expect(readLabelValue(LEAVES, 'Card Creation Date')).toBe('07/07/2026');
  });
  it('returns null when the next leaf is another label', () => {
    expect(readLabelValue(LEAVES, 'Free Text :')).toBeNull();
  });
  it('returns null for "-" placeholders and missing labels', () => {
    expect(readLabelValue(LEAVES, 'Card Status Reason:')).toBeNull();
    expect(readLabelValue(LEAVES, 'Nope:')).toBeNull();
  });
});

describe('readProgramForLast4', () => {
  it('reads the Program column of the row containing the last 4', () => {
    const headers = ['Account Number', 'Account Ref. Num', 'Program', 'Account Type'];
    const rows = [['412650******6990', '527024663778', 'Wealthsimple Visa Infinite VIP 01 Physical', 'Credit - Primary']];
    expect(readProgramForLast4(headers, rows, '6990')).toBe('Wealthsimple Visa Infinite VIP 01 Physical');
    expect(readProgramForLast4(headers, rows, '1111')).toBeNull();
  });
});

describe('parseI2cDelinquency', () => {
  it('maps i2c wording', () => {
    expect(parseI2cDelinquency('Current / Not Delinquent')).toBe(false);
    expect(parseI2cDelinquency('Delinquent 30 Days')).toBe(true);
    expect(parseI2cDelinquency('')).toBeNull();
    expect(parseI2cDelinquency(undefined)).toBeNull();
  });
});

describe('mapI2cProgram', () => {
  it('maps known programs and rejects unknown ones', () => {
    expect(mapI2cProgram('Wealthsimple  Visa Infinite VIP 01 Physical ')).toBe('ws_visa_infinite_privilege');
    expect(mapI2cProgram('Something Else')).toBeNull();
    expect(mapI2cProgram(undefined)).toBeNull();
  });
});
