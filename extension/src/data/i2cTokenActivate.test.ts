import { describe, expect, it } from 'vitest';
import {
  ACTIVE_OPTION_RE, CSR_REASON_RE, TOKEN_AWAIT_MAX_AGE_MS, UPDATE_STATUS_RE,
  findOption, freshRecord, isInactiveStatus, locateTokenColumns, parseTokenTarget, pickInactiveTokenRow,
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
