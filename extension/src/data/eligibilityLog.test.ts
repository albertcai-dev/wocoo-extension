import { describe, expect, it } from 'vitest';
import { toLogRow } from './eligibilityLog';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';

const req = {
  threadId: 't9', messageId: 'm9', insurerEmail: 'a@claims-co.example', insurerName: '', subject: '', receivedAt: '',
  messageCount: 1, cardholderName: null, emails: [], phone: null, last4: '1763', claimNumber: '123456',
  dateOfLoss: null, warnings: [],
} as EligibilityRequest;

const res: Resolution = {
  requestId: 'm9', status: 'needs_review', method: 'name_last4', clientEmail: 'p@example.com', identityId: 'identity-A',
  cards: [
    { last4: '1763', product: 'ws_visa_infinite_privilege', creationDate: '08/21/2026', delinquent: false },
    { last4: '0042', product: 'ws_visa_infinite_basic', creationDate: '01/02/2025', delinquent: false },
  ],
  flags: ['vi_1pct'], candidates: [], note: 'Warehouse: name + last 4.',
};

describe('toLogRow', () => {
  it('maps a resolution to the 12 Requests columns, joining multi-card values', () => {
    expect(toLogRow(req, res, 'DRAFTED', 'r-123')).toEqual({
      request_message_id: 'm9', thread_id: 't9', insurer_email: 'a@claims-co.example', client_email: 'p@example.com',
      status: 'DRAFTED', last4: '1763, 0042', is_delinquent: 'FALSE', activation_date: '08/21/2026, 01/02/2025',
      card_product: 'ws_visa_infinite_privilege, ws_visa_infinite_basic', match_method: 'name_last4', draft_id: 'r-123',
      notes: 'Warehouse: name + last 4. Flags: vi_1pct. Claim 123456.',
    });
  });

  it('leaves card columns blank for unmatched requests', () => {
    const row = toLogRow(req, { ...res, status: 'no_match', method: null, clientEmail: null, cards: [], flags: [], note: 'Nothing found.' }, 'NO_MATCH', '');
    expect(row.last4).toBe('');
    expect(row.is_delinquent).toBe('');
    expect(row.notes).toBe('Nothing found. Claim 123456.');
  });
});
