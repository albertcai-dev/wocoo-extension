import { describe, expect, it } from 'vitest';
import { resolveBatch, type ResolveDeps } from './eligibilityRun';
import { isDraftable } from './eligibilityResolve';
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

  describe('Atlas first-name spelling variants (phone path only)', () => {
    const hit = (identityId: string, fullName: string, email: string) => {
      const [firstName, ...rest] = fullName.split(' ');
      return { identityId, fullName, firstName, lastName: rest.join(' '), email };
    };
    const named = (first: string, last: string) =>
      req('m1', { cardholderName: { first, last, raw: first + ' ' + last }, emails: [] });
    const withHits = (hits: ReturnType<typeof hit>[]) => {
      const d = deps({
        atlasByPhone: async () => hits,
        i2cCards: async (email) => { d.calls.push('i2c:' + email); return i2cOpen; },
      });
      return d;
    };

    it('one-letter substitution (Yousef vs Youcef) proceeds, flagged name_variant and draft-blocked until ticked', async () => {
      const d = withHits([hit('identity-Y', 'YOUCEF KARA MOSTEFA', 'y@example.com')]);
      const [r] = await resolveBatch([named('Yousef', 'Kara Mostefa')], d);
      expect(r.method).toBe('atlas_phone_i2c');
      expect(r.identityId).toBe('identity-Y');
      expect(r.status).toBe('needs_review');
      expect(r.flags).toContain('name_variant');
      expect(r.note).toContain('First name differs: request "Yousef", Atlas "Youcef".');
      expect(isDraftable(r)).toBe(true);
    });

    it('keeps the flag and note when the warehouse follow-up replaces cards and flags', async () => {
      const sqls: string[] = [];
      const d = withHits([hit('identity-Y', 'Youcef Kara Mostefa', 'y@example.com')]);
      d.runSql = async (sql) => { sqls.push(sql); return sqls.length === 1 ? [] : [whRow('m1', { identity_id: 'identity-Y', client_email: 'y@example.com' })]; };
      const [r] = await resolveBatch([named('Yousef', 'Kara Mostefa')], d);
      expect(sqls).toHaveLength(2);
      expect(r.note).toContain('Card details from the warehouse.');
      expect(r.flags).toContain('name_variant');
      expect(r.status).toBe('needs_review');
      expect(r.note).toContain('First name differs: request "Yousef", Atlas "Youcef".');
    });

    it('insertion (Yousef vs Youssef) is a variant', async () => {
      const d = withHits([hit('identity-Y', 'Youssef Kara', 'y@example.com')]);
      const [r] = await resolveBatch([named('Yousef', 'Kara')], d);
      expect(r.method).toBe('atlas_phone_i2c');
      expect(r.flags).toContain('name_variant');
    });

    it('Priya vs Priyanka is not a match', async () => {
      const d = withHits([hit('identity-Y', 'Priyanka Ramanathan', 'y@example.com')]);
      const [r] = await resolveBatch([named('Priya', 'Ramanathan')], d);
      expect(r.status).toBe('no_match');
      expect(d.calls).toEqual([]);
    });

    it('short first names never vary (Ana vs Ann)', async () => {
      const d = withHits([hit('identity-Y', 'Ann Ramanathan', 'y@example.com')]);
      const [r] = await resolveBatch([named('Ana', 'Ramanathan')], d);
      expect(r.status).toBe('no_match');
    });

    it('a differing last name never matches', async () => {
      const d = withHits([hit('identity-Y', 'Youcef Mostefa', 'y@example.com')]);
      const [r] = await resolveBatch([named('Yousef', 'Kara')], d);
      expect(r.status).toBe('no_match');
    });

    it('an exact match beats a variant match on the same phone, with no flag', async () => {
      const d = withHits([
        hit('identity-V', 'Youcef Kara', 'v@example.com'),
        hit('identity-E', 'Yousef Kara', 'e@example.com'),
      ]);
      const [r] = await resolveBatch([named('Yousef', 'Kara')], d);
      expect(r.identityId).toBe('identity-E');
      expect(r.flags).not.toContain('name_variant');
      expect(r.status).toBe('matched');
    });

    it('two variant matches are multiple_candidates', async () => {
      const d = withHits([
        hit('identity-V1', 'Youcef Kara', 'v1@example.com'),
        hit('identity-V2', 'Youssef Kara', 'v2@example.com'),
      ]);
      const [r] = await resolveBatch([named('Yousef', 'Kara')], d);
      expect(r.flags).toEqual(['multiple_candidates']);
      expect(d.calls).toEqual([]);
    });

    it('variants are not used on the email paths (warehouse name rule untouched)', async () => {
      const d = deps({ runSql: async () => [whRow('m1', { match_rule: 'email' })] });
      const [r] = await resolveBatch([req('m1')], d);
      expect(r.flags).not.toContain('name_variant');
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

  describe('warehouse card details after a live match', () => {
    // First runSql call is the batch query (returns []); later calls are the follow-up.
    function twoStep(follow: () => Promise<Record<string, unknown>[]>): { sqls: string[]; run: ResolveDeps['runSql'] } {
      const sqls: string[] = [];
      return { sqls, run: async (sql) => { sqls.push(sql); return sqls.length === 1 ? [] : follow(); } };
    }
    const followRow = (over: Record<string, unknown> = {}) => whRow('m1', {
      client_email: 'real.priya@example.com', card_product: 'ws_visa_infinite_core', created_date: '03/04/2026', ...over,
    });
    const atlasDeps = (run: ResolveDeps['runSql']) => deps({
      runSql: run,
      atlasByPhone: async () => [
        { identityId: 'identity-P', fullName: 'Priya Ramanathan', firstName: 'Priya', lastName: 'Ramanathan', email: null },
      ],
      atlasEmail: async () => 'real.priya@example.com',
      i2cCards: async (email) => (email === 'real.priya@example.com' ? i2cOpen : []),
    });

    it('i2c_email match takes cards from the warehouse, keeps the method', async () => {
      const t = twoStep(async () => [followRow({ identity_id: 'identity-A', client_email: 'priya.r1985@example.com' })]);
      const d = deps({
        runSql: t.run,
        i2cCards: async (email) => (email === 'priya.r1985@example.com' ? i2cOpen : []),
      });
      const [r] = await resolveBatch([req('m1')], d);
      expect(r.method).toBe('i2c_email');
      expect(r.status).toBe('matched');
      expect(r.cards).toEqual([{ last4: '1763', product: 'ws_visa_infinite_core', creationDate: '03/04/2026', delinquent: false }]);
      expect(r.clientEmail).toBe('priya.r1985@example.com');
      expect(r.identityId).toBe('identity-A');
      expect(r.note).toContain('Card details from the warehouse.');
      expect(t.sqls).toHaveLength(2);
      expect(t.sqls[1]).toContain("'priya.r1985@example.com'");
      expect(t.sqls[1]).not.toContain('wrong.address');
      expect(t.sqls[1]).not.toContain('ramanathan');
    });

    it('atlas_phone_i2c match takes cards from the warehouse for the same identity', async () => {
      const t = twoStep(async () => [followRow({ identity_id: 'identity-P' })]);
      const [r] = await resolveBatch([req('m1', { emails: [] })], atlasDeps(t.run));
      expect(r.method).toBe('atlas_phone_i2c');
      expect(r.identityId).toBe('identity-P');
      expect(r.clientEmail).toBe('real.priya@example.com');
      expect(r.status).toBe('matched');
      expect(r.cards[0].product).toBe('ws_visa_infinite_core');
      expect(r.cards[0].creationDate).toBe('03/04/2026');
      expect(r.note).toContain('warehouse');
    });

    it('a warehouse identity that differs from the Atlas match needs review and keeps i2c cards', async () => {
      const t = twoStep(async () => [followRow({ identity_id: 'identity-Q' })]);
      const [r] = await resolveBatch([req('m1', { emails: [] })], atlasDeps(t.run));
      expect(r.status).toBe('needs_review');
      expect(r.flags).toContain('lookup_error');
      expect(r.identityId).toBe('identity-P');
      expect(r.cards[0].creationDate).toBe('07/07/2026');
      expect(r.note).toContain('Warehouse identity differs');
    });

    it('warehouse returning several clients needs review', async () => {
      const t = twoStep(async () => [followRow({ identity_id: 'identity-P' }), followRow({ identity_id: 'identity-Q' })]);
      const [r] = await resolveBatch([req('m1', { emails: [] })], atlasDeps(t.run));
      expect(r.status).toBe('needs_review');
      expect(r.flags).toContain('lookup_error');
      expect(r.flags).not.toContain('multiple_candidates');
      expect(r.note).toContain('Warehouse found more than one client for this email — check manually.');
      expect(r.cards[0].creationDate).toBe('07/07/2026');
    });

    it('lowercases a mixed-case Atlas email for the follow-up but keeps the original on the result', async () => {
      const t = twoStep(async () => [followRow({ identity_id: 'identity-P' })]);
      const d = atlasDeps(t.run);
      d.atlasEmail = async () => 'Real.Priya@Example.com';
      d.i2cCards = async (email) => (email === 'Real.Priya@Example.com' ? i2cOpen : []);
      const [r] = await resolveBatch([req('m1', { emails: [] })], d);
      expect(t.sqls).toHaveLength(2);
      expect(t.sqls[1]).toContain("'real.priya@example.com'");
      expect(r.clientEmail).toBe('Real.Priya@Example.com');
      expect(r.cards[0].product).toBe('ws_visa_infinite_core');
      expect(r.note).toContain('Card details from the warehouse.');
    });

    it('keeps live i2c delinquency when the warehouse says not delinquent', async () => {
      const t = twoStep(async () => [followRow({ identity_id: 'identity-P', is_delinquent: false })]);
      const d = atlasDeps(t.run);
      d.i2cCards = async () => [{ ...i2cOpen[0], delinquencyStatus: 'Delinquent - 30 days' }];
      const [r] = await resolveBatch([req('m1', { emails: [] })], d);
      expect(r.cards[0]).toEqual({ last4: '1763', product: 'ws_visa_infinite_core', creationDate: '03/04/2026', delinquent: true });
      expect(r.flags).toContain('delinquent');
      expect(r.status).toBe('needs_review');
    });

    it('empty follow-up keeps the i2c facts and says the card is not in the warehouse yet', async () => {
      const t = twoStep(async () => []);
      const [r] = await resolveBatch([req('m1', { emails: [] })], atlasDeps(t.run));
      expect(r.method).toBe('atlas_phone_i2c');
      expect(r.cards[0].creationDate).toBe('07/07/2026');
      expect(r.note).toContain('Card not in the warehouse yet; using i2c details.');
    });

    it('a failing follow-up keeps the i2c facts and says warehouse details are unavailable', async () => {
      const t = twoStep(async () => { throw new Error('Preset timed out'); });
      const [r] = await resolveBatch([req('m1', { emails: [] })], atlasDeps(t.run));
      expect(r.status).toBe('matched');
      expect(r.cards[0].creationDate).toBe('07/07/2026');
      expect(r.note).toContain('Warehouse details unavailable (Preset timed out); using i2c details.');
    });
  });
});
