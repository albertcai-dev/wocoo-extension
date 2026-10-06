import { describe, it, expect } from 'vitest';
import { pickCreditProduct, type ProductRow } from './i2cProductSelect';

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
