// Heuristic to detect tickets asking for a fee reversal (FX fee, ATM fee, foreign
// transaction fee, etc.). Mirrors [[cred-route-detect]] / [[wallet-triage-detect]].
//
// Action-only matching — phrases like "refund the fee" or "fx fee" are specific
// enough on their own that no separate topic anchor is needed.

import { CLIENT_LEAVING_SIGNALS } from './clientLeavingSignals';

export interface ReverseFeeDetection {
  matched: boolean;
  reasons: string[];
  /** True when the ticket is an Interest-Related Issues work type. The workflow uses this
   *  to swap the comment verbiage to "the interest fee has been waived!" and to fetch the
   *  client email from Atlas when the ticket doesn't carry one. */
  isInterestFlow?: boolean;
}

export function isInterestRelatedWorkType(workType: string | null | undefined): boolean {
  return /interest[-\s]?related/i.test(workType || '');
}

/** Content-based interest detection — catches tickets whose workType is a generic
 *  category (e.g. "Credit Card: Other") but whose summary/description clearly describe
 *  an interest fee reversal. */
const INTEREST_CONTENT_SIGNALS = [
  'interest fee', 'interest charge', 'interest reversal',
  'cc interest', 'credit card interest', 'interest reversed',
  'reverse the interest', 'reverse interest', 'waive the interest',
  'waive interest', 'refund the interest', 'refund interest',
  'financial charges - interest',
];
export function isInterestFeeInContent(summary: string, description: string): boolean {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  return INTEREST_CONTENT_SIGNALS.some((s) => text.includes(s));
}

const REVERSE_FEE_ACTION_SIGNALS = [
  'reverse the fee', 'reverse this fee', 'reverse fee',
  'refund the fee', 'refund this fee',
  'remove the fee', 'credit the fee', 'waive the fee',
  'incorrect fee', 'fee charged in error',
  'fx fee', 'foreign transaction fee', 'atm fee',
  // Annual-fee reversal phrasings — only surface when the "annual fee" veto is
  // skipped (i.e. client is closing / hasn't used the card). Without a leaving
  // signal, "annual fee" is still vetoed and these won't match.
  'annual fee to be waived', 'annual fee waived',
  'waive the annual', 'reverse the annual', 'refund the annual',
  'reimburse the annual', 'reimburse the fee',
  // Monthly-fee reversal phrasings — catch "CC monthly fee waiver" tickets where
  // a single monthly charge needs reversing (typically tier-update timing / delay
  // scenarios). Retention's DURATION check now requires plural or explicit spans,
  // so "monthly" (singular) no longer pulls these into RetentionFeeWaiver.
  'monthly fee', 'waive the monthly',
];

// Veto signals — phrasing that puts the ticket on a different workflow.
const VETOES = [
  'annual fee', 'overpayment', 'dispute', 'chargeback',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectReverseFee(
  summary: string,
  description: string,
  workType: string | null | undefined,
): ReverseFeeDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const workTypeInterest = isInterestRelatedWorkType(workType);
  const contentInterest = isInterestFeeInContent(summary, description);

  // Interest-Related Issues by workType OR by content — content match catches tickets
  // filed under generic categories (e.g. "Credit Card: Other") that are actually asking
  // for an interest fee reversal.
  if (workTypeInterest || contentInterest) {
    const reasons: string[] = [];
    if (workTypeInterest) reasons.push('Interest-Related Issues work type');
    if (contentInterest) reasons.push('Interest fee mentioned in summary/description');
    return { matched: true, reasons, isInterestFlow: true };
  }

  const leaving = findMatches(text, CLIENT_LEAVING_SIGNALS);
  const vetoes = findMatches(text, VETOES);
  // When the client is closing / cancelling / hasn't used the card, "annual fee"
  // is a REVERSAL request, not a retention ask — drop that specific veto. Other
  // vetoes (overpayment / dispute / chargeback) still apply.
  const effectiveVetoes = leaving.length ? vetoes.filter((v) => v !== 'annual fee') : vetoes;
  if (effectiveVetoes.length) return { matched: false, reasons: [`vetoed: ${effectiveVetoes[0]}`] };

  const action = findMatches(text, REVERSE_FEE_ACTION_SIGNALS);

  const reasons: string[] = [];
  if (action.length) reasons.push(`Reverse-fee action: ${action[0].trim()}`);
  if (leaving.length) reasons.push(`Client closing: ${leaving[0].trim()}`);

  const matched = action.length > 0;
  return { matched, reasons };
}
