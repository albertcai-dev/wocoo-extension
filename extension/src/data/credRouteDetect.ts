// Heuristic to detect tickets that almost certainly belong on the CRED (Credit
// Decisioning) board rather than CXA. Most common pattern: credit-card application
// flow issues — resets, identity-verification loops, decisioning, credit-limit changes,
// appeals.
//
// Sibling detector to [[qc-auto-reimb-detect]]. Both run on every ticket; the SidePanel
// can show whichever (or both) match.

export interface CredRouteDetection {
  matched: boolean;
  reasons: string[];
}

const CC_TOPIC_SIGNALS = [
  'credit card', 'cc ', ' cc',  // " cc " disambiguates from "Acc" etc.
  'cc application', 'credit-card',
];

// Signals that indicate a credit-decisioning task. Each phrase requires *context* —
// bare words like "decline" or "appeal" alone match too many unrelated tickets ("refund
// declined", "card transaction declined", "appeal a charge"). Keep phrases tight.
const CRED_ACTION_SIGNALS = [
  // Application reset / onboarding stuck
  'application reset', 'reset application', 'reset the application',
  'reset his application', 'reset her application', 'reset their application',
  'reset cc', 'reset credit card application',
  'onboarding stuck', 'application stuck',
  // Credit limit changes
  'credit limit', 'limit increase', 'limit decrease',
  // Identity-verification loop during CC application
  'identity verification', 'verify his identity', 'verify her identity',
  'verify their identity', 'verify identity', 'identity loop', 'verification loop',
  'stuck on verification', 'stuck on identity', 'stuck in verification',
  // Decisioning / approvals (must include the word "credit" or "application")
  'credit decision', 'credit decisioning', 'decision review',
  'adverse action',
  'pre-approval', 'preapproval',
  'credit declined', 'credit card declined', 'application declined',
  'declined application', 'declined credit',
  'appeal decision', 'appeal a decision', 'appealing the decision',
  'appealing a decision', 'appealing credit', 'appeal credit',
];

// Issue types that strongly suggest CRED (compared against WocooTicket.workType which
// maps from the source ticket's issue_type).
const CRED_WORKTYPES = [
  'Credit Card: Onboarding',
  'Credit Card: Application',
  'Credit Card: Decisioning',
];

// Veto signals — explicit indicators the ticket is *not* CRED-bound, even if
// CC-related. Refunds, transactions, payments, fees → ops/merchant work, not credit
// decisioning.
const VETOES = [
  // Existing fee-waiver / overpayment vetoes
  'fee waiver', 'annual fee', 'fees waiver', 'fee reimbursement',
  'overpayment', 'over payment',
  // Refund / transaction / payment / chargeback contexts
  'refund', 'refunded', 'refunding',
  'transaction declined', 'transactions declined', 'declined transaction',
  'payment declined', 'declined payment',
  'purchase declined', 'declined purchase',
  'chargeback', 'dispute',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectCredRoute(summary: string, description: string, workType: string | null | undefined): CredRouteDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  // Veto first — short-circuit if the ticket is clearly about something else.
  const vetoes = findMatches(text, VETOES);
  if (vetoes.length) return { matched: false, reasons: [`vetoed: ${vetoes[0]}`] };

  const workTypeMatch = workType && CRED_WORKTYPES.includes(workType);
  const ccTopic = findMatches(text, CC_TOPIC_SIGNALS);
  const credAction = findMatches(text, CRED_ACTION_SIGNALS);

  const reasons: string[] = [];
  if (workTypeMatch) reasons.push(`Work type: ${workType}`);
  if (ccTopic.length) reasons.push(`CC topic: ${ccTopic[0].trim()}`);
  if (credAction.length) reasons.push(`CRED action: ${credAction[0].trim()}`);

  // Match rule:
  //   (work type is a CRED work type)   — strong signal alone
  //   OR (CC topic mentioned AND a CRED action mentioned)
  const matched = !!workTypeMatch || (ccTopic.length > 0 && credAction.length > 0);
  return { matched, reasons };
}
