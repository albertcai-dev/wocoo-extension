import { describe, expect, it } from 'vitest';
import { resolveBatch, type ResolveDeps } from './eligibilityRun';
import type { EligibilityRequest } from './eligibilityTypes';

function req(id: string, over: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return {
    threadId: 't' + id, messageId: id, insurerEmail: 'a@claims-co.example', insurerName: '', subject: '', receivedAt: '',
    messageCount: 1, cardholderName: { first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' },
    emails: ['wrong.address@example.com', 'priya.r1985@example.com'], phone: '4165550142', last4: '1763',
    claimNumber: null, dateOfLoss: null, warnings: [], ...over,
  };
}

const whRow = (requestId: string, over: Record<string, unknown> = {}) => ({
  request_id: requestId, match_rule: 'email', identity_id: 'identity-A', client_email: 'priya.r1985@example.com',
  first_name: 'Priya', last_name: 'Ramanathan', last4: '1763', card_product: 'ws_visa_infinite_privilege',
  created_date: '08/21/2026', is_delinquent: false, ...over,
});

const i2cOpen = [{
  last4: '1763', status: 'ACTIVE', closed: false, program: 'Wealthsimple Visa Infinite VIP 01 Physical',
  delinquencyStatus: 'Current / Not Delinquent', creationDate: '07/07/2026',
}];

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runSql: async () => [],
    i2cCards: async (email) => { calls.push('i2c:' + email); return []; },
    atlasByPhone: async (phone) => { calls.push('atlas:' + phone); return []; },
    atlasEmail: async (id) => { calls.push('atlasEmail:' + id); return ''; },
    ...over,
  };
}

describe('resolveBatch', () => {
  it('matches on the second listed email via the warehouse (first email wrong)', async () => {
    const d = deps({ runSql: async () => [whRow('m1')] });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.method).toBe('email_last4');
    expect(d.calls).toEqual([]);
  });

  it('resolves two claims for the same client independently', async () => {
    const d = deps({ runSql: async () => [whRow('m1'), whRow('m2')] });
    const rs = await resolveBatch([req('m1'), req('m2')], d);
    expect(rs.map((r) => [r.requestId, r.method])).toEqual([['m1', 'email_last4'], ['m2', 'email_last4']]);
  });

  it('falls back to i2c by listed email, trying each email in order', async () => {
    const d = deps({
      i2cCards: async (email) => { d.calls.push('i2c:' + email); return email === 'priya.r1985@example.com' ? i2cOpen : []; },
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.method).toBe('i2c_email');
    expect(r.clientEmail).toBe('priya.r1985@example.com');
    expect(d.calls).toEqual(['i2c:wrong.address@example.com', 'i2c:priya.r1985@example.com']);
  });

  it('falls back to Atlas phone → name check → Atlas email → i2c', async () => {
    const d = deps({
      atlasByPhone: async () => [
        { identityId: 'identity-Z', fullName: 'Someone Else', firstName: 'Someone', lastName: 'Else', email: 'z@example.com' },
        { identityId: 'identity-P', fullName: 'Priya Ramanathan', firstName: 'Priya', lastName: 'Ramanathan', email: null },
      ],
      atlasEmail: async () => 'real.priya@example.com',
      i2cCards: async (email) => (email === 'real.priya@example.com' ? i2cOpen : []),
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.method).toBe('atlas_phone_i2c');
    expect(r.identityId).toBe('identity-P');
    expect(r.clientEmail).toBe('real.priya@example.com');
  });

  it('flags multiple name-matched Atlas identities instead of picking one', async () => {
    const d = deps({
      atlasByPhone: async () => [
        { identityId: 'identity-P1', fullName: 'Priya Ramanathan', firstName: 'Priya', lastName: 'Ramanathan', email: 'a@example.com' },
        { identityId: 'identity-P2', fullName: 'Priya Ramanathan', firstName: 'Priya', lastName: 'Ramanathan', email: 'b@example.com' },
      ],
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.flags).toEqual(['multiple_candidates']);
  });

  describe('Atlas family-name regression (same phone, different people)', () => {
    const hit = (identityId: string, fullName: string, email: string) => {
      const [firstName, ...rest] = fullName.split(' ');
      return { identityId, fullName, firstName, lastName: rest.join(' '), email };
    };

    it('only the named family member proceeds to i2c', async () => {
      const d = deps({
        atlasByPhone: async () => [
          hit('identity-A', 'Arun Ramanathan', 'arun@example.com'),
          hit('identity-P', 'Priya Ramanathan', 'priya@example.com'),
          hit('identity-M', 'Meena Ramanathan', 'meena@example.com'),
        ],
        i2cCards: async (email) => { d.calls.push('i2c:' + email); return email === 'priya@example.com' ? i2cOpen : []; },
      });
      const [r] = await resolveBatch([req('m1', { emails: [] })], d);
      expect(r.method).toBe('atlas_phone_i2c');
      expect(r.identityId).toBe('identity-P');
      expect(d.calls).toEqual(['i2c:priya@example.com']);
    });

    it('two identities with the same name are flagged, not picked', async () => {
      const d = deps({
        atlasByPhone: async () => [
          hit('identity-P1', 'Priya Ramanathan', 'a@example.com'),
          hit('identity-P2', 'Priya Ramanathan', 'b@example.com'),
        ],
      });
      const [r] = await resolveBatch([req('m1', { emails: [] })], d);
      expect(r.flags).toEqual(['multiple_candidates']);
      expect(d.calls).toEqual([]);
    });
  });

  describe('Atlas name matching on fullName', () => {
    async function matches(first: string, last: string, fullName: string): Promise<boolean> {
      const [firstName, ...rest] = fullName.split(' ');
      const d = deps({
        atlasByPhone: async () => [
          { identityId: 'identity-N', fullName, firstName, lastName: rest.join(' '), email: 'n@example.com' },
        ],
        i2cCards: async (email) => (email === 'n@example.com' ? i2cOpen : []),
      });
      const [r] = await resolveBatch(
        [req('m1', { cardholderName: { first, last, raw: first + ' ' + last }, emails: [] })],
        d,
      );
      return r.method === 'atlas_phone_i2c';
    }

    it('matches a multi-word surname', async () => {
      expect(await matches('Hung', 'Lin Tai', 'Hung Lin Tai')).toBe(true);
    });
    it('matches a multi-word first name with or without the middle name on Atlas', async () => {
      expect(await matches('Mary Ann', 'Smith', 'Mary Ann Smith')).toBe(true);
      expect(await matches('Mary Ann', 'Smith', 'Mary Smith')).toBe(true);
    });
    it('does not match a longer first name or a truncated surname', async () => {
      expect(await matches('Priya', 'Ramanathan', 'Priyanka Ramanathan')).toBe(false);
      expect(await matches('Priya', 'Ramanathan', 'Priya Raman')).toBe(false);
    });
  });

  it('never looks anything up for already-replied or no-last4 requests', async () => {
    const d = deps();
    const rs = await resolveBatch([req('m1', { messageCount: 3 }), req('m2', { last4: null })], d);
    expect(rs.map((r) => r.flags[0])).toEqual(['already_replied', 'no_last4']);
    expect(d.calls).toEqual([]);
  });

  it('keeps going when one i2c lookup throws, and records the error', async () => {
    const d = deps({
      i2cCards: async (email) => { if (email.startsWith('wrong')) throw new Error('timed out'); return []; },
      atlasByPhone: null,
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['lookup_error']);
    expect(r.note).toContain('timed out');
  });

  it('propagates a warehouse failure so the panel can offer the paste fallback', async () => {
    const d = deps({ runSql: async () => { throw new Error('Not signed in to Preset.'); } });
    await expect(resolveBatch([req('m1')], d)).rejects.toThrow('Not signed in to Preset.');
  });
});
