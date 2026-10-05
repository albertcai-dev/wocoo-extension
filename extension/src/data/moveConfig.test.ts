import { describe, it, expect } from 'vitest';
import { BOPSFUND_ISSUE_TYPES, DESTINATIONS } from './moveConfig';

// Snapshot of `jira_get_project_metadata('BOPSFUND')` on 2026-10-04, minus Sub-task.
const JIRA_BOPSFUND_TYPES = [
  ['11224', 'Large Withdrawals'],
  ['11506', 'Manual Requests - Cross Functional'],
  ['11496', 'Manual Requests - Exceptions'],
  ['11497', 'Stuck Transactions'],
  ['11498', 'Tracing Requests'],
  ['11500', 'Non-Resident Transactions'],
  ['12076', 'PAD Dispute'],
  ['12077', 'Reversal'],
  ['10002', 'Task'],
  ['11507', 'Archive'],
  ['11765', 'Wires Posting'],
];

const COMMON = ['customfield_11458', 'customfield_10082', 'customfield_10125'];

describe('BOPSFUND move config', () => {
  it('is an API-enabled destination', () => {
    expect(DESTINATIONS.find((d) => d.key === 'BOPSFUND')?.apiEnabled).toBe(true);
  });

  it('offers every Jira issue type in dropdown order', () => {
    expect(BOPSFUND_ISSUE_TYPES.map((t) => [t.id, t.name])).toEqual(JIRA_BOPSFUND_TYPES);
  });

  it('requires Identity, Account ID and Funds Transfer ID on every type', () => {
    for (const t of BOPSFUND_ISSUE_TYPES) {
      expect(t.requiredFields.slice(0, 3).map((f) => f.fieldId)).toEqual(COMMON);
    }
  });

  it('adds the per-type option field Jira requires', () => {
    const extra = (id: string) =>
      BOPSFUND_ISSUE_TYPES.find((t) => t.id === id)!.requiredFields.slice(3).map((f) => [f.fieldId, f.type]);
    expect(extra('11496')).toEqual([['customfield_11453', 'option']]);
    expect(extra('11497')).toEqual([['customfield_11454', 'option']]);
    expect(extra('11498')).toEqual([['customfield_11455', 'option']]);
    expect(extra('11224')).toEqual([]);
  });

  it('prefills Identity and Account ID but not Funds Transfer ID', () => {
    const [identity, account, transfer] = BOPSFUND_ISSUE_TYPES[0].requiredFields;
    expect(identity.prefillFrom).toBe('identityId');
    expect(account.prefillFrom).toBe('accountId');
    expect(transfer.prefillFrom).toBeUndefined();
  });
});
