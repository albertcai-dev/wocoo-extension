import { describe, expect, it } from 'vitest';
import { AGENT_I2C_CHAIN_MAX_AGE_MS, AGENT_I2C_MSG, isSessionErrorPage, parseAgentI2cRequest, readChain } from './i2cAgentChain';
import { pickProduct } from './i2cProductSelect';

describe('parseAgentI2cRequest', () => {
  it('accepts an email and a product', () => {
    expect(parseAgentI2cRequest({ type: AGENT_I2C_MSG, email: ' a@b.co ', product: 'prepaid' }))
      .toEqual({ email: 'a@b.co', product: 'prepaid' });
  });
  it('accepts a page to open afterwards, and only the three pages the user reads', () => {
    expect(parseAgentI2cRequest({ type: AGENT_I2C_MSG, email: 'a@b.co', product: 'credit', page: 'Declined Transactions' }))
      .toEqual({ email: 'a@b.co', product: 'credit', page: 'Declined Transactions' });
    expect(parseAgentI2cRequest({ type: AGENT_I2C_MSG, email: 'a@b.co', product: 'credit', page: 'Account Summary' })).toHaveProperty('error');
  });
  it('ignores other messages and rejects bad input', () => {
    expect(parseAgentI2cRequest({ type: 'x' })).toBeNull();
    expect(parseAgentI2cRequest({ type: AGENT_I2C_MSG, email: 'nope', product: 'credit' })).toEqual({ error: 'bad email' });
    expect(parseAgentI2cRequest({ type: AGENT_I2C_MSG, email: 'a@b.co', product: 'debit' })).toHaveProperty('error');
  });
});

describe('readChain', () => {
  const now = 1_000_000;
  const chain = { email: 'a@b.co', product: 'credit', startedAt: now - 1000, step: 'search' };
  it('reads a fresh chain', () => {
    expect(readChain(JSON.stringify(chain), now)).toEqual(chain);
  });
  it('drops stale, garbled or missing chains', () => {
    expect(readChain(JSON.stringify({ ...chain, startedAt: now - AGENT_I2C_CHAIN_MAX_AGE_MS - 1 }), now)).toBeNull();
    expect(readChain('{', now)).toBeNull();
    expect(readChain(null, now)).toBeNull();
    expect(readChain(JSON.stringify({ ...chain, step: 'fly' }), now)).toBeNull();
  });
});

describe('pickProduct', () => {
  const rows = [
    { category: 'Debit', status: 'ACTIVE' },
    { category: 'Credit', status: 'ACTIVE' },
  ];
  it('picks the retail prepaid (Debit) row for prepaid and the Credit row for credit', () => {
    expect(pickProduct(rows, 'prepaid')).toBe(0);
    expect(pickProduct(rows, 'credit')).toBe(1);
  });
  it('read-only lookups take a lone inactive card of the right kind', () => {
    const r = [{ category: 'Debit', status: 'ACTIVE' }, { category: 'Credit', status: 'INACTIVE' }];
    expect(pickProduct(r, 'credit')).toBeNull();
    expect(pickProduct(r, 'credit', { allowSoleInactive: true })).toBe(1);
    expect(pickProduct([...r, { category: 'Credit', status: 'CLOSED' }], 'credit', { allowSoleInactive: true })).toBeNull();
  });
  it('abstains when the wanted product is missing, inactive or ambiguous', () => {
    expect(pickProduct([{ category: 'Credit', status: 'CLOSED' }], 'credit')).toBeNull();
    expect(pickProduct([...rows, { category: 'Debit', status: 'ACTIVE' }], 'prepaid')).toBeNull();
    expect(pickProduct([{ category: 'Credit', status: 'ACTIVE' }], 'prepaid')).toBeNull();
  });
});

describe('isSessionErrorPage', () => {
  it('spots the pages that need a fresh login', () => {
    for (const t of ['Invalid Session, please enable cookies', 'Instance Not Configured', 'You are not logged in. Click here to login',
      'The desired action could not be completed because an error has occurred or your session has expired.']) {
      expect(isSessionErrorPage(t)).toBe(true);
    }
    expect(isSessionErrorPage('Customer Search Following are the different options')).toBe(false);
  });
});
