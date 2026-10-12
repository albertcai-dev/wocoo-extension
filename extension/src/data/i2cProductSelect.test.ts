import { describe, it, expect } from 'vitest';
import { locateProductColumns, pickCreditProduct, type ProductRow } from './i2cProductSelect';

const prepaid: ProductRow = { category: 'Debit', status: 'ACTIVE' };
const credit: ProductRow = { category: 'Credit', status: 'ACTIVE' };

describe('pickCreditProduct', () => {
  it('picks the credit row past a prepaid row', () => {
    expect(pickCreditProduct([prepaid, credit])).toBe(1);
  });

  it('picks the credit row when it comes first', () => {
    expect(pickCreditProduct([credit, prepaid])).toBe(0);
  });

  it('ignores a closed credit product', () => {
    expect(pickCreditProduct([prepaid, { category: 'Credit', status: 'CLOSED' }])).toBeNull();
  });

  it('abstains when two active credit products exist', () => {
    expect(pickCreditProduct([credit, credit])).toBeNull();
  });

  it('picks the active one when the other credit product is closed', () => {
    expect(pickCreditProduct([{ category: 'Credit', status: 'CLOSED' }, credit])).toBe(1);
  });

  it('abstains when every product is prepaid', () => {
    expect(pickCreditProduct([prepaid, prepaid])).toBeNull();
  });

  it('abstains on an empty table', () => {
    expect(pickCreditProduct([])).toBeNull();
  });

  it('tolerates casing and surrounding whitespace from the cells', () => {
    expect(pickCreditProduct([{ category: '  credit ', status: ' Active  ' }])).toBe(0);
  });

  it('does not treat a blank category as credit', () => {
    expect(pickCreditProduct([{ category: '', status: 'ACTIVE' }])).toBeNull();
  });
});

// i2c renders a grouping row ABOVE the real column headers. Assuming the header is the
// first row is what broke the first version of this step: it never located the columns,
// so it silently skipped the table on every pass.
const GROUP_ROW = ['Product Information', 'Customer Information'];
const HEADER_ROW = [
  'Account/Card Number', 'Program', 'Company Name', 'Program Category', 'Status',
  'Credit Limit', 'Balance', 'Last Accessed', 'Expiry Date', 'First Name', 'Last Name',
  'Email', 'Mobile No.', 'Date of Birth', '',
];
const PREPAID_ROW = [
  '453746******9606', 'Retail Prepaid Physical', 'WP Test Stakeholder', 'Debit', 'ACTIVE',
  '-', '-', '10/06/2026', '09/30/2031', 'ANDERSON', 'NGAIDOMA', 'a@b.com', '1581', '-',
  'Select Customer',
];
const CREDIT_ROW = [
  '412650******4731', 'Wealthsimple Visa Infinite Plus Basic 01 Physical Quebec',
  'WP Test Stakeholder', 'Credit', 'ACTIVE', '2000.00', '-', '10/05/2026', '06/30/2031',
  'ANDERSON', 'NGAIDOMA', 'a@b.com', '1581', '-', 'Select Customer',
];

describe('locateProductColumns', () => {
  it('finds the header row below the grouping row', () => {
    const got = locateProductColumns([GROUP_ROW, HEADER_ROW, PREPAID_ROW, CREDIT_ROW]);
    expect(got).toEqual({ headerAt: 1, categoryAt: 3, statusAt: 4 });
  });

  it('finds the header row when it is first', () => {
    const got = locateProductColumns([HEADER_ROW, CREDIT_ROW]);
    expect(got).toEqual({ headerAt: 0, categoryAt: 3, statusAt: 4 });
  });

  it('tolerates a line break inside the header text', () => {
    const wrapped = ['Account/Card Number', 'Program\nCategory', 'Status'];
    expect(locateProductColumns([wrapped])).toEqual({ headerAt: 0, categoryAt: 1, statusAt: 2 });
  });

  it('returns null when Program Category is absent', () => {
    expect(locateProductColumns([['Account/Card Number', 'Status']])).toBeNull();
  });

  it('returns null when Status is absent', () => {
    expect(locateProductColumns([['Program Category', 'Balance']])).toBeNull();
  });

  it('returns null for an empty table', () => {
    expect(locateProductColumns([])).toBeNull();
  });

  it('does not mistake a data cell reading Credit for the header', () => {
    // The prepaid/credit rows contain "Credit Limit"-ish text; only an exact
    // "Program Category" cell may anchor the header.
    const got = locateProductColumns([GROUP_ROW, HEADER_ROW, CREDIT_ROW]);
    expect(got?.headerAt).toBe(1);
  });
});
