import { describe, expect, it } from 'vitest';
import { conciseReimbSummary, parseReimbAgentNote } from './reimbPrefill';

const CASHBACK_NOTE =
  "After checking the receipt (receipt.png) shows electronics, not jewelry/watch/precious metal: " +
  "raise REIMB (Reason General Promotion) for 2% cashback = $9.31 on CA$465.41 purchase, " +
  "posted Nov 11 2026 (trans 100000001), Visa Infinite ••0000. Confirm the client's rate is 2% (not 1%) with the Cashback Calculator.";

describe('parseReimbAgentNote', () => {
  it('takes the payout, not the purchase amount, and the reason', () => {
    expect(parseReimbAgentNote(CASHBACK_NOTE)).toEqual({ amount: 9.31, reason: 'General Promotion' });
  });

  it('reads "reimburse ... $X"', () => {
    expect(parseReimbAgentNote('Reimburse the client $1,250.00 to close the account').amount).toBe(1250);
  });

  it('uses a lone dollar figure', () => {
    expect(parseReimbAgentNote('Raise REIMB, Reimburse to Close, $42.10 owed').amount).toBe(42.1);
  });

  it('leaves the amount blank when several figures are unlabelled', () => {
    expect(parseReimbAgentNote('Purchase $465.41, statement balance $900.00').amount).toBeUndefined();
  });

  it('returns nothing for an empty note', () => {
    expect(parseReimbAgentNote(undefined)).toEqual({});
  });
});

describe('conciseReimbSummary', () => {
  it('keeps the lead phrase before an em dash', () => {
    expect(conciseReimbSummary('Missing cashback — settled $465.41 purchase coded MCC 5094')).toBe('Missing cashback');
  });

  it('splits on a colon', () => {
    expect(conciseReimbSummary('Overpayment refund: client paid twice')).toBe('Overpayment refund');
  });

  it('leaves a short summary alone', () => {
    expect(conciseReimbSummary('Annual fee refund')).toBe('Annual fee refund');
  });
});
