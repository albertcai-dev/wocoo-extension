import { describe, expect, it } from 'vitest';
import { buildEligibilitySql, toWarehouseRows } from './eligibilitySql';
import type { EligibilityRequest } from './eligibilityTypes';

function req(over: Partial<EligibilityRequest>): EligibilityRequest {
  return {
    threadId: 't', messageId: 'abc123', insurerEmail: 'a@claims-co.example', insurerName: '',
    subject: '', receivedAt: '', messageCount: 1,
    cardholderName: { first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' },
    emails: ['wrong.address@example.com', 'priya.r1985@example.com'],
    phone: null, last4: '1763', claimNumber: null, dateOfLoss: null, warnings: [],
    ...over,
  };
}

describe('buildEligibilitySql', () => {
  it('emits one email row per listed email and one name row per request', () => {
    const sql = buildEligibilitySql([req({})])!;
    expect(sql).toContain("SELECT 'abc123' AS request_id, 'wrong.address@example.com' AS email, '1763' AS last4");
    expect(sql).toContain("SELECT 'abc123', 'priya.r1985@example.com', '1763'");
    expect(sql).toContain("SELECT 'abc123' AS request_id, 'priya' AS first_norm, 'ramanathan' AS last_norm, '1763' AS last4");
    expect(sql).toContain("cc.i2c_card_status = 'open'");
    expect(sql).toContain("'ws_visa_infinite_core'");
  });

  it('escapes apostrophes in names', () => {
    const sql = buildEligibilitySql([req({ emails: [], cardholderName: { first: 'Zoë', last: "O'Neil", raw: "Zoë O'Neil" } })])!;
    expect(sql).toContain("'zoe' AS first_norm, 'o''neil' AS last_norm");
  });

  it('skips requests with no last4 and returns null when nothing is left', () => {
    expect(buildEligibilitySql([req({ last4: null })])).toBeNull();
  });

  it('drops values that fail validation instead of interpolating them', () => {
    const sql = buildEligibilitySql([req({ emails: ["x'; DROP TABLE t; --@example.com", 'ok@example.com'] })])!;
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toContain("'ok@example.com'");
  });

  it('uses an empty typed CTE when no request has emails', () => {
    const sql = buildEligibilitySql([req({ emails: [] })])!;
    expect(sql).toContain('WHERE FALSE');
  });

  it('includes a second request for the same client independently', () => {
    const sql = buildEligibilitySql([req({ messageId: 'aaa111' }), req({ messageId: 'bbb222' })])!;
    expect(sql).toContain("'aaa111'");
    expect(sql).toContain("'bbb222'");
  });
});

describe('toWarehouseRows', () => {
  it('coerces types and pads last4', () => {
    const rows = toWarehouseRows([
      { request_id: 'abc123', match_rule: 'email', identity_id: 'identity-X', client_email: 'P@Example.com',
        first_name: 'Priya', last_name: 'Ramanathan', last4: 42, card_product: 'ws_visa_infinite_privilege',
        created_date: '08/21/2026', is_delinquent: 'false' },
      { request_id: 'abc123', match_rule: 'name', identity_id: 'identity-Y', client_email: 'q@example.com',
        first_name: 'Priya', last_name: 'Ramanathan', last4: '1763', card_product: 'ws_visa_infinite_plus',
        created_date: '01/02/2026', is_delinquent: null },
    ]);
    expect(rows[0]).toEqual({
      requestId: 'abc123', matchRule: 'email', identityId: 'identity-X', clientEmail: 'p@example.com',
      firstName: 'Priya', lastName: 'Ramanathan', last4: '0042', cardProduct: 'ws_visa_infinite_privilege',
      createdDate: '08/21/2026', isDelinquent: false,
    });
    expect(rows[1].isDelinquent).toBeNull();
    expect(rows[1].matchRule).toBe('name');
  });
});
