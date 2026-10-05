import { describe, expect, it } from 'vitest';
import { isDraftable, noMatch, preflight, resolveFromI2c, resolveFromWarehouse } from './eligibilityResolve';
import type { EligibilityRequest, WarehouseRow } from './eligibilityTypes';

function req(over: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return {
    threadId: 't', messageId: 'm1', insurerEmail: 'a@claims-co.example', insurerName: '', subject: '',
    receivedAt: '', messageCount: 1, cardholderName: { first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' },
    emails: ['priya.r1985@example.com'], phone: '4165550142', last4: '1763', claimNumber: null, dateOfLoss: null,
    warnings: [], ...over,
  };
}

function row(over: Partial<WarehouseRow> = {}): WarehouseRow {
  return {
    requestId: 'm1', matchRule: 'email', identityId: 'identity-A', clientEmail: 'priya.r1985@example.com',
    firstName: 'Priya', lastName: 'Ramanathan', last4: '1763', cardProduct: 'ws_visa_infinite_privilege',
    createdDate: '08/21/2026', isDelinquent: false, ...over,
  };
}

describe('preflight', () => {
  it('stops already-replied threads', () => {
    expect(preflight(req({ messageCount: 2 }))?.flags).toEqual(['already_replied']);
  });
  it('stops requests without last4', () => {
    const r = preflight(req({ last4: null }))!;
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['no_last4']);
  });
  it('passes normal requests', () => {
    expect(preflight(req())).toBeNull();
  });
});

describe('resolveFromWarehouse', () => {
  it('matches a single email identity and lists all its cards', () => {
    const r = resolveFromWarehouse(req(), [row(), row({ last4: '0042', cardProduct: 'ws_visa_infinite_plus' })])!;
    expect(r.status).toBe('matched');
    expect(r.method).toBe('email_last4');
    expect(r.cards.map((c) => c.last4)).toEqual(['1763', '0042']);
    expect(isDraftable(r)).toBe(true);
  });

  it('prefers the email rule over the name rule', () => {
    const r = resolveFromWarehouse(req(), [row({ matchRule: 'name', identityId: 'identity-B' }), row()])!;
    expect(r.identityId).toBe('identity-A');
    expect(r.method).toBe('email_last4');
  });

  it('falls back to a single name identity', () => {
    const r = resolveFromWarehouse(req(), [row({ matchRule: 'name', clientEmail: 'other@example.com' })])!;
    expect(r.method).toBe('name_last4');
    expect(r.clientEmail).toBe('other@example.com');
  });

  it('flags multiple candidates at the winning rule instead of picking one', () => {
    const r = resolveFromWarehouse(req(), [
      row({ matchRule: 'name', identityId: 'identity-B', clientEmail: 'b@example.com' }),
      row({ matchRule: 'name', identityId: 'identity-C', clientEmail: 'c@example.com' }),
    ])!;
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['multiple_candidates']);
    expect(r.candidates.map((c) => c.identityId)).toEqual(['identity-B', 'identity-C']);
    expect(isDraftable(r)).toBe(false);
  });

  it('returns null when the warehouse has nothing for this request', () => {
    expect(resolveFromWarehouse(req(), [row({ requestId: 'other' })])).toBeNull();
  });

  it('flags delinquency, 1% products and parse warnings without dropping the match', () => {
    const r = resolveFromWarehouse(
      req({ warnings: ['Multiple last-4 values found: 1763, 9921'] }),
      [row({ isDelinquent: true, cardProduct: 'ws_visa_infinite_mystery' })],
    )!;
    expect(r.status).toBe('needs_review');
    expect(r.flags.sort()).toEqual(['delinquent', 'parse_warning', 'vi_1pct']);
    expect(isDraftable(r)).toBe(false);
  });

  it('allows drafting when only tickable flags (delinquent, vi_1pct) are present', () => {
    const r = resolveFromWarehouse(
      req(),
      [row({ isDelinquent: true, cardProduct: 'ws_visa_infinite_mystery' })],
    )!;
    expect(r.status).toBe('needs_review');
    expect(r.flags.sort()).toEqual(['delinquent', 'vi_1pct']);
    expect(isDraftable(r)).toBe(true);
  });

  it.each(['ws_visa_infinite_basic', 'ws_visa_infinite_core'])('treats %s as review-free', (cardProduct) => {
    const r = resolveFromWarehouse(req(), [row({ cardProduct })])!;
    expect(r.status).toBe('matched');
    expect(r.flags).toEqual([]);
  });

  it('still flags vi_1pct for an unexpected product id', () => {
    const r = resolveFromWarehouse(req(), [row({ cardProduct: 'ws_visa_infinite_mystery' })])!;
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['vi_1pct']);
  });

  it('deduplicates cards when same identity appears under both email and name rules', () => {
    const r = resolveFromWarehouse(req(), [
      row({ matchRule: 'email' }),
      row({ matchRule: 'name' }),
    ])!;
    expect(r.method).toBe('email_last4');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0].last4).toBe('1763');
  });
});

describe('resolveFromI2c', () => {
  const deps = {
    mapProgram: (p?: string) => (p === 'Wealthsimple Visa Infinite VIP 01 Physical' ? 'ws_visa_infinite_privilege' : null),
    parseDelinquency: (s?: string) => (s === 'Current / Not Delinquent' ? false : null),
  };

  it('matches an open card with the requested last 4', () => {
    const r = resolveFromI2c(req(), {
      email: 'priya.r1985@example.com', method: 'i2c_email', identityId: null, ...deps,
      cards: [{ last4: '1763', status: 'ACTIVE', closed: false, program: 'Wealthsimple Visa Infinite VIP 01 Physical',
        delinquencyStatus: 'Current / Not Delinquent', creationDate: '07/07/2026' }],
    })!;
    expect(r.status).toBe('matched');
    expect(r.cards).toEqual([{ last4: '1763', product: 'ws_visa_infinite_privilege', creationDate: '07/07/2026', delinquent: false }]);
  });

  it('ignores closed cards', () => {
    expect(resolveFromI2c(req(), {
      email: 'x@example.com', method: 'i2c_email', identityId: null, ...deps,
      cards: [{ last4: '1763', status: 'CLOSED CARD', closed: true }],
    })).toBeNull();
  });

  it('flags unknown program and incomplete details', () => {
    const r = resolveFromI2c(req(), {
      email: 'x@example.com', method: 'i2c_email', identityId: null, ...deps,
      cards: [{ last4: '1763', status: 'ACTIVE', closed: false, program: 'Some New Program' }],
    })!;
    expect(r.flags.sort()).toEqual(['i2c_details_incomplete', 'unknown_product']);
    expect(isDraftable(r)).toBe(false);
  });

  it('treats a creation date that is not MM/DD/YYYY as incomplete details', () => {
    for (const creationDate of ['N/A', '2026-07-07', '7/7/2026', '07/07/2026 extra']) {
      const r = resolveFromI2c(req(), {
        email: 'x@example.com', method: 'i2c_email', identityId: null, ...deps,
        cards: [{ last4: '1763', status: 'ACTIVE', closed: false, program: 'Wealthsimple Visa Infinite VIP 01 Physical',
          delinquencyStatus: 'Current / Not Delinquent', creationDate }],
      })!;
      expect(r.cards[0].creationDate).toBe('');
      expect(r.flags).toEqual(['i2c_details_incomplete']);
      expect(isDraftable(r)).toBe(false);
    }
  });
});

describe('noMatch', () => {
  it('builds a no_match resolution', () => {
    const r = noMatch(req(), 'Nothing found');
    expect(r.status).toBe('no_match');
    expect(r.cards).toEqual([]);
  });
});
