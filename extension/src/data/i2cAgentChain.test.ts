import { describe, expect, it } from 'vitest';
import { AGENT_I2C_CHAIN_MAX_AGE_MS, AGENT_I2C_MSG, parseAgentI2cRequest, readChain } from './i2cAgentChain';
import { pickProduct } from './i2cProductSelect';

describe('parseAgentI2cRequest', () => {
  it('accepts an email and a product', () => {
    expect(parseAgentI2cRequest({ type: AGENT_I2C_MSG, email: ' a@b.co ', product: 'prepaid' }))
      .toEqual({ email: 'a@b.co', product: 'prepaid' });
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
  it('abstains when the wanted product is missing, inactive or ambiguous', () => {
    expect(pickProduct([{ category: 'Credit', status: 'CLOSED' }], 'credit')).toBeNull();
    expect(pickProduct([...rows, { category: 'Debit', status: 'ACTIVE' }], 'prepaid')).toBeNull();
    expect(pickProduct([{ category: 'Credit', status: 'ACTIVE' }], 'prepaid')).toBeNull();
  });
});
