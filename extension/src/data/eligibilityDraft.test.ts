import { describe, expect, it } from 'vitest';
import { renderEligibilityDraft } from './eligibilityDraft';

const card = (last4: string, over = {}) => ({
  last4, product: 'ws_visa_infinite_privilege', creationDate: '08/21/2026', delinquent: false, ...over,
});

describe('renderEligibilityDraft', () => {
  it('matches the existing reply format byte-for-byte for one card', () => {
    const body = renderEligibilityDraft({
      clientEmail: 'priya.r1985@example.com', emailWasProvided: true, cards: [card('1763')], requestedLast4: '1763',
    });
    expect(body).toBe(
      'Hi,\n\n' +
      'Here are the requested details for client priya.r1985@example.com:\n\n' +
      '• Last 4 digits of card: 1763\n' +
      '• Status: the card is in good standing\n' +
      '• Activation date: 08/21/2026\n' +
      '• Product: ws_visa_infinite_privilege\n\n' +
      'Best,\nCash and Card Operations\n\n-- \n',
    );
  });

  it('omits the client email when the insurer did not supply it', () => {
    const body = renderEligibilityDraft({
      clientEmail: 'real.address@example.com', emailWasProvided: false, cards: [card('1763')], requestedLast4: '1763',
    });
    expect(body).toContain('Here are the requested details for client:\n\n');
    expect(body).not.toContain('real.address@example.com');
  });

  it('lists every card, requested last 4 first, separated by a blank line', () => {
    const body = renderEligibilityDraft({
      clientEmail: null, emailWasProvided: false,
      cards: [card('0042', { product: 'ws_visa_infinite_plus', creationDate: '01/02/2025' }), card('1763')],
      requestedLast4: '1763',
    });
    const i1763 = body.indexOf('card: 1763');
    const i0042 = body.indexOf('card: 0042');
    expect(i1763).toBeGreaterThan(-1);
    expect(i0042).toBeGreaterThan(i1763);
    expect(body).toContain('• Product: ws_visa_infinite_privilege\n\n• Last 4 digits of card: 0042');
  });

  it('says not in good standing for delinquent cards', () => {
    const body = renderEligibilityDraft({
      clientEmail: null, emailWasProvided: false, cards: [card('1763', { delinquent: true })], requestedLast4: '1763',
    });
    expect(body).toContain('• Status: the card is not in good standing');
  });

  it('refuses to render unknown facts', () => {
    expect(() => renderEligibilityDraft({
      clientEmail: null, emailWasProvided: false, cards: [card('1763', { delinquent: null })], requestedLast4: '1763',
    })).toThrow(/unknown/);
  });
});
