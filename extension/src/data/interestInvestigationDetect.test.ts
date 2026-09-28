import { describe, it, expect } from 'vitest';
import { detectInterestInvestigation } from './interestInvestigationDetect';
import { detectL3Escalation } from './l3EscalationDetect';

// WOCOO-28919: client paid before the due date and was still charged interest.
const PAID_BEFORE_DUE = {
  summary: 'Interest Charged After Payment',
  description:
    'Statement due date Sept 15\nPaid Sept 14\nCharged interest on full balance $61\n' +
    'Please see Zendesk Support tab for further comments and attachments.',
  workType: 'Interest-Related Issues',
};

describe('detectInterestInvestigation', () => {
  it('matches a paid-before-due-date interest dispute with no explicit ask verb', () => {
    const { summary, description, workType } = PAID_BEFORE_DUE;
    expect(detectInterestInvestigation(summary, description, workType).matched).toBe(true);
  });

  it('routes that ticket away from the L3 escalation card', () => {
    const { summary, description, workType } = PAID_BEFORE_DUE;
    expect(detectL3Escalation(summary, description, workType).matched).toBe(false);
  });

  it('still defers explicit waiver asks to Reverse Fee', () => {
    const r = detectInterestInvestigation(
      'Interest charged after payment',
      'Paid before the due date, please waive the interest',
      'Interest-Related Issues',
    );
    expect(r.matched).toBe(false);
  });
});
