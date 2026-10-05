import { describe, expect, it } from 'vitest';
import { gridFromRows, pageSaysNoRecord, parseI2cDelinquency, readColumnForLast4, readLabelValue, readProgramForLast4 } from './i2cCardDetailsParse';
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

describe('readColumnForLast4', () => {
  const headers = ['Account Number', 'Account Ref. Num', 'Program', 'Account Type'];
  const rows = [
    ['412650******0162', '527024000001', 'Wealthsimple Visa Infinite VIP 01 Physical', 'Credit - Primary'],
    ['412650******6990', '527024663778', 'Wealthsimple Visa Infinite VIP 01 Physical', 'Credit - Primary'],
  ];
  it('reads the named column of the row containing the last 4', () => {
    expect(readColumnForLast4(headers, rows, '6990', 'Account Ref. Num')).toBe('527024663778');
    expect(readColumnForLast4(headers, rows, '0162', 'account ref. num:')).toBe('527024000001');
  });
  it('returns null when the column is missing', () => {
    expect(readColumnForLast4(headers, rows, '6990', 'Card Reference Number')).toBeNull();
  });
  it('returns null when no row has the last 4', () => {
    expect(readColumnForLast4(headers, rows, '1111', 'Account Ref. Num')).toBeNull();
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

describe('gridFromRows', () => {
  const header = { table: 0, cells: ['Account Number', 'Account Ref. Num', 'Program', 'Account Type', 'Status', 'Opened'] };
  const account = {
    table: 0,
    cells: ['412650******4766', '527003024872', 'Wealthsimple Visa Infinite VIP 01 Physical', 'Credit - Primary', 'Open', '08/03/2025'],
  };
  const nestedHeader = { table: 1, cells: ['Card Number', 'Name on Card', 'Type'] };
  const nestedRow = { table: 1, cells: ['412650******4766', 'Pat Example', 'Primary'] };

  it('reads the Accounts row even when a nested card table follows it', () => {
    const { headers, rows } = gridFromRows([header, account, nestedHeader, nestedRow], 'Program');
    expect(headers).toEqual(header.cells);
    expect(rows).toEqual([account.cells]);
    expect(readProgramForLast4(headers, rows, '4766')).toBe('Wealthsimple Visa Infinite VIP 01 Physical');
    expect(readColumnForLast4(headers, rows, '4766', 'Account Ref. Num')).toBe('527003024872');
  });
  it('excludes a same-width row from a different table', () => {
    const sameWidthNested = { table: 1, cells: ['a', 'b', 'c', 'd', 'e', 'f'] };
    const { rows } = gridFromRows([header, account, sameWidthNested], 'program');
    expect(rows).toEqual([account.cells]);
  });
  it('returns an empty grid when no Program header exists', () => {
    expect(gridFromRows([nestedHeader, nestedRow], 'Program')).toEqual({ headers: [], rows: [] });
  });
});

describe('pageSaysNoRecord', () => {
  it('is true for the red banner after an unmatched search', () => {
    expect(pageSaysNoRecord('Customer Search  No record found.  Email Address')).toBe(true);
  });
  it('is false on the plain search page', () => {
    expect(pageSaysNoRecord('Customer Search Following are the different options to search for a customer')).toBe(false);
  });
  it('tolerates case, plural and whitespace', () => {
    expect(pageSaysNoRecord('no records found.')).toBe(true);
    expect(pageSaysNoRecord('NO   RECORD\n FOUND')).toBe(true);
  });
});
