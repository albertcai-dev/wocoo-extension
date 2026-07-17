// Heuristic to detect "QC client just became fee-waiver-eligible, no action needed —
// system auto-reimburses next statement period" tickets. Per the Luke Gazmin clarification
// (2026-06-16): WOCOO tickets should only be cut if the client already waited a statement
// period and STILL hasn't been reimbursed. Anything before that point gets the templated
// "no action required" reply.

export interface QCAutoReimbDetection {
  matched: boolean;
  reasons: string[];   // which positive signals fired (for debugging / UI tooltip)
  vetoes: string[];    // which exception markers fired (suppresses the match)
}

const QC_SIGNALS = ['qc', 'quebec', 'québec'];

const FEE_TOPIC_SIGNALS = [
  'fee waiver', 'fee waived', 'fees waived', 'fee reimbursement',
  'fee reimbursed', 'annual fee', 'cc fee', 'cc fees', 'credit card fee',
  'fees waiver', 'fee paid', 'reimburse the fee', 'reimburse the annual',
];

// The client just became eligible (tier upgrade, AUM threshold, DD eligibility) — they
// don't need a manual refund yet because the system handles it.
// Exported so qcFeeWaiverDetect.ts and retentionFeeWaiverDetect.ts use the same list.
export const ELIGIBILITY_FLIP_SIGNALS = [
  'tier upgrade', 'upgraded tier', 'newly eligible', 'now eligible', 'now meets',
  'now qualified', 'now qualify', 'now over 100k', 'over 100k', 'over $100k',
  'over 100,000', 'over $100,000', 'crossed 100k', 'aum', 'assets under management',
  'direct deposit', 'dd eligibility', 'dd eligible', 'qualifying direct deposit',
  'qualified direct deposit', 'become premium', 'became premium', 'now premium',
  // Bare "DD" mentions in context — client has direct deposit set up and is asking why
  // the fee was still charged. Verify Eligible DD is the right workflow (not retention).
  'dd setup', 'set up dd', 'in dd', 'has dd', 'have dd', 'having dd',
  'with dd', 'their dd', 'the dd', 'dd of $', 'dd amount',
];

// Veto signals — the client has already waited a statement period and STILL hasn't
// been reimbursed. In that case we DO need to manually reimburse, so the auto-reimb
// banner should NOT show.
const EXCEPTION_SIGNALS = [
  'still not reimbursed', 'not yet reimbursed', 'has not been reimbursed',
  "haven't been reimbursed", 'never received', 'missed the statement',
  'statement period has passed', 'statement period passed', 'waited until',
  'waited for', 'waited a statement', 'waited for the statement',
  'next statement came and went', 'statement closed and',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) {
    if (text.includes(n)) found.push(n);
  }
  return found;
}

export function detectQCAutoReimb(summary: string, description: string): QCAutoReimbDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const qc = findMatches(text, QC_SIGNALS);
  const feeTopic = findMatches(text, FEE_TOPIC_SIGNALS);
  const flip = findMatches(text, ELIGIBILITY_FLIP_SIGNALS);
  const vetoes = findMatches(text, EXCEPTION_SIGNALS);

  const reasons: string[] = [];
  if (qc.length) reasons.push(`QC mention: ${qc[0]}`);
  if (feeTopic.length) reasons.push(`Fee topic: ${feeTopic[0]}`);
  if (flip.length) reasons.push(`Eligibility flip: ${flip[0]}`);

  const matched =
    qc.length > 0 &&
    feeTopic.length > 0 &&
    flip.length > 0 &&
    vetoes.length === 0;

  return { matched, reasons, vetoes };
}

/**
 * Build the templated reply for the "no action required" comment.
 * Uses "@<reporter>" mention syntax — the comment-poster will wrap it in a proper ADF
 * mention node if the reporter's accountId is known.
 */
export function buildQCAutoReimbComment(reporterName: string | null | undefined): string {
  const mention = reporterName ? `@${reporterName}` : 'team';
  return (
    `Hi ${mention},\n\n` +
    `As client just recently had a tier upgrade the fee reimbursement will be applied automatically on their next statement period. No action from ops required.\n\n` +
    `Thanks,\nAlbert`
  );
}
