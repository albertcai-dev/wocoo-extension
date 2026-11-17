import { describe, expect, it } from 'vitest';
import {
  ACTIVE_OPTION_RE, CSR_REASON_RE, TOKEN_AWAIT_MAX_AGE_MS, UPDATE_STATUS_RE,
  findOption, freshRecord, isInactiveStatus, locateTokenColumns, parseTokenTarget, pickInactiveTokenRow,
  DEACTIVATE_OPTION_RE, OTHER_REASON_RE, isActiveStatus, isTokenFlow, pickActiveTokenRowById, tokenFormFor,
  canFillTokenForm, selectedOptionMatches,
} from './i2cTokenActivate';

const header = ['Token Number', 'Token Type', 'Device Name', 'Status', 'Created On', 'Action'];
const row = (status: string, device: string, created: string) =>
  ['4133454021336657', '02', device, status, created, 'Select'];

describe('isInactiveStatus', () => {
  it('matches InActive only', () => {
    expect(isInactiveStatus('InActive')).toBe(true);
    expect(isInactiveStatus(' In Active ')).toBe(true);
    expect(isInactiveStatus('Active')).toBe(false);
    expect(isInactiveStatus('DeActivated')).toBe(false);
  });
});

describe('locateTokenColumns', () => {
  it('finds the header below a grouping row', () => {
    expect(locateTokenColumns([['Manage Card Tokens'], header, row('Active', 'x', '')]))
      .toEqual({ headerAt: 1, statusAt: 3 });
  });
  it('is null without a token table', () => {
    expect(locateTokenColumns([['Trans. Date', 'Status', 'Amount']])).toBeNull();
  });
});

describe('pickInactiveTokenRow', () => {
  it('picks the only InActive row, ignoring Active and DeActivated', () => {
    const rows = [header, row('Active', 'Watch', '10/04/2026 01:00 PM'), row('DeActivated', 'Old', '10/01/2026 09:00 AM'),
      row('InActive', 'Fullmarginflux', '10/31/2026 03:35 PM')];
    expect(pickInactiveTokenRow(rows, {})).toBe(3);
  });
  it('is null with no InActive row', () => {
    expect(pickInactiveTokenRow([header, row('DeActivated', 'Old', '10/01/2026')], {})).toBeNull();
  });
  it('narrows several InActive rows by device, then by created time', () => {
    const rows = [header, row('InActive', 'iPhone', '10/30/2026 01:00 PM'), row('InActive', 'Fullmarginflux', '10/31/2026 03:35 PM')];
    expect(pickInactiveTokenRow(rows, { device: 'fullmarginflux' })).toBe(2);
    expect(pickInactiveTokenRow(rows, { created: '10/30/2026 1:00 PM' })).toBe(1);
  });
  it('never guesses between several InActive rows it cannot tell apart', () => {
    const rows = [header, row('InActive', 'iPhone', '10/31/2026 03:35 PM'), row('InActive', 'iPhone', '10/31/2026 03:35 PM')];
    expect(pickInactiveTokenRow(rows, { device: 'iPhone' })).toBeNull();
    expect(pickInactiveTokenRow(rows, {})).toBeNull();
  });
});

describe('option regexes', () => {
  it('picks Active, not InActive/DeActivated, and the CSR reason', () => {
    const statuses = ['-- Select --', 'InActive', 'DeActivated', 'Active', 'Suspended'];
    expect(findOption(statuses, ACTIVE_OPTION_RE)).toBe(3);
    expect(findOption(['Lost', 'Authenticated with CSR'], CSR_REASON_RE)).toBe(1);
    expect(UPDATE_STATUS_RE.test('Update Status')).toBe(true);
  });
});

describe('parseTokenTarget', () => {
  it('reads the agent fields and drops a bad last 4', () => {
    expect(parseTokenTarget({ card_last4: '9355', device: ' Fullmarginflux ', created: '10/31/2026 03:35 PM' }))
      .toEqual({ cardLast4: '9355', device: 'Fullmarginflux', created: '10/31/2026 03:35 PM' });
    expect(parseTokenTarget({ card_last4: '93' })?.cardLast4).toBeNull();
    expect(parseTokenTarget(null)).toBeNull();
  });
});

describe('freshRecord', () => {
  const now = 10_000_000;
  it('keeps a recent record for the same ticket only', () => {
    expect(freshRecord({ sourceTicketId: 'WOCOO-1', at: now - 1000 }, now, 'WOCOO-1')).toEqual({ sourceTicketId: 'WOCOO-1', at: now - 1000 });
    expect(freshRecord({ sourceTicketId: 'WOCOO-2', at: now - 1000 }, now, 'WOCOO-1')).toBeNull();
    expect(freshRecord({ sourceTicketId: 'WOCOO-1', at: now - TOKEN_AWAIT_MAX_AGE_MS - 1 }, now)).toBeNull();
    expect(freshRecord('x', now)).toBeNull();
  });
});

// ----- deactivate_token -----
const dHeader = ['Token ID', 'Type', 'Token Status', 'Device ID', 'Device Name', 'Created On'];
const dRow = (id: string, status: string, device: string) => [id, '03', status, 'dev', device, '11/09/2026 12:16 PM'];

describe('pickActiveTokenRowById', () => {
  const rows = [dHeader, dRow('1111222233334444', 'Active', 'Pixel 9 Pro XL'), dRow('1111222233335555', 'Active', 'Pixel 9 Pro')];
  it('picks the Active row with the matching id', () => {
    expect(pickActiveTokenRowById(rows, { tokenId: '1111222233334444' })).toBe(1);
    expect(pickActiveTokenRowById(rows, { tokenId: '1111222233335555' })).toBe(2);
  });
  it('never picks by device when IDs differ', () => {
    expect(pickActiveTokenRowById(rows, { tokenId: '9999888877776666', device: 'Pixel 9 Pro XL' })).toBeNull();
  });
  it('refuses InActive and DeActivated rows even with a matching id', () => {
    expect(pickActiveTokenRowById([dHeader, dRow('1111222233334444', 'InActive', 'x')], { tokenId: '1111222233334444' })).toBeNull();
    expect(pickActiveTokenRowById([dHeader, dRow('1111222233334444', 'DeActivated', 'x')], { tokenId: '1111222233334444' })).toBeNull();
  });
  it('compares ids ignoring whitespace; a masked id never matches', () => {
    expect(pickActiveTokenRowById([dHeader, dRow('1111 2222 3333 4444', 'Active', 'x')], { tokenId: '1111222233334444' })).toBe(1);
    expect(pickActiveTokenRowById([dHeader, dRow('1111********4444', 'Active', 'x')], { tokenId: '1111222233334444' })).toBeNull();
  });
  it('is null without a token id', () => {
    expect(pickActiveTokenRowById(rows, { device: 'Pixel 9 Pro XL' })).toBeNull();
  });
});

describe('isActiveStatus', () => {
  it('matches Active only', () => {
    expect(isActiveStatus('Active')).toBe(true);
    expect(isActiveStatus(' active ')).toBe(true);
    expect(isActiveStatus('InActive')).toBe(false);
    expect(isActiveStatus('DeActivated')).toBe(false);
  });
});

describe('deactivate option regexes', () => {
  it('picks the deactivate status and the Other reason', () => {
    expect(findOption(['Active', 'InActive', 'DeActivate'], DEACTIVATE_OPTION_RE)).toBe(2);
    expect(DEACTIVATE_OPTION_RE.test('Delete')).toBe(true);
    expect(DEACTIVATE_OPTION_RE.test('Deactivated')).toBe(true);
    expect(DEACTIVATE_OPTION_RE.test('InActive')).toBe(false);
    expect(DEACTIVATE_OPTION_RE.test('Active')).toBe(false);
    expect(findOption(['Lost', 'Other'], OTHER_REASON_RE)).toBe(1);
  });
});

describe('parseTokenTarget token_id', () => {
  it('reads token_id, stripping spaces; drops a non-numeric id', () => {
    expect(parseTokenTarget({ token_id: '1111 2222 3333 4444' })?.tokenId).toBe('1111222233334444');
    expect(parseTokenTarget({ token_id: 'abc' })?.tokenId).toBeNull();
  });
});

describe('tokenFormFor', () => {
  it('deactivate picks Other; activate unchanged', () => {
    expect(tokenFormFor('deactivate_token').reasonRe).toBe(OTHER_REASON_RE);
    expect(tokenFormFor('deactivate_token').statusRe).toBe(DEACTIVATE_OPTION_RE);
    expect(tokenFormFor('activate_token').statusRe).toBe(ACTIVE_OPTION_RE);
    expect(tokenFormFor('activate_token').reasonRe).toBe(CSR_REASON_RE);
  });
});

describe('isTokenFlow', () => {
  it('accepts the two token flows only', () => {
    expect(isTokenFlow('activate_token')).toBe(true);
    expect(isTokenFlow('deactivate_token')).toBe(true);
    expect(isTokenFlow('admin_debit')).toBe(false);
    expect(isTokenFlow(null)).toBe(false);
  });
});

describe('canFillTokenForm', () => {
  it('fills only after Select, on Manage Card Tokens, with the status option present', () => {
    expect(canFillTokenForm({ step: 'selected', onTokenPage: true, hasStatusOption: true })).toBe(true);
    expect(canFillTokenForm({ step: 'selected', onTokenPage: false, hasStatusOption: true })).toBe(false);
    expect(canFillTokenForm({ step: 'selected', onTokenPage: true, hasStatusOption: false })).toBe(false);
    expect(canFillTokenForm({ step: 'card', onTokenPage: true, hasStatusOption: true })).toBe(false);
  });
});

describe('selectedOptionMatches', () => {
  it('confirms the Reason stuck after the dependent list reloaded', () => {
    expect(selectedOptionMatches('Other', OTHER_REASON_RE)).toBe(true);
    expect(selectedOptionMatches(' Select ', OTHER_REASON_RE)).toBe(false);
    expect(selectedOptionMatches(null, OTHER_REASON_RE)).toBe(false);
  });
});
