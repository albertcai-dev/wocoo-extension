// Detection for "why was this interest charged?" tickets — the client isn't asking for
// the interest to be reversed, they want it explained. These route to the local Interest
// Validation tool (Single User Validation), not to an L3 agent and not to Reverse Fee.
//
// The distinguishing signal is an interest mention plus either an ask to look into it
// ("can we review?", "verify the source") or the evidence clients volunteer when they
// think the charge is wrong ("no cash advance", "statement was fully paid"). An explicit
// waiver/reversal ask vetoes the whole thing — that's Reverse Fee's job.

export interface InterestInvestigationDetection {
  matched: boolean;
  reasons: string[];
}

const INTEREST_SIGNALS = [
  'interest',
];

// An explicit ask to undo the charge — not an investigation.
const WAIVER_SIGNALS = [
  'waive', 'waiver', 'waived',
  'reverse the interest', 'reverse this interest', 'reverse interest',
  'refund the interest', 'refund this interest', 'refund interest',
  'reimburse the interest', 'reimburse interest',
  'remove the interest', 'remove this interest',
  'credit back', 'credit the interest',
  'interest reversal', 'interest refund',
];

const INVESTIGATE_SIGNALS = [
  'review', 'verify', 'confirm', 'explain', 'explanation',
  'investigate', 'look into', 'looking into', 'clarify', 'clarification',
  'understand', 'breakdown', 'break down', 'why was', 'why were', 'why is',
  'why they', 'why the', 'source of', 'where did', 'where this', 'reason for',
  'double check', 'double-check', 'check on', 'checking',
];

// Evidence clients volunteer when disputing an interest charge. Any of these alongside an
// interest mention reads as "please look at this", even without an explicit ask verb.
const CONTEXT_SIGNALS = [
  'cash advance',
  'fully paid', 'paid in full', 'paid off', 'statement balance',
  'did not see', "didn't see", 'do not see', "don't see",
  'no cash advance', 'not expecting', 'was not expecting', "wasn't expecting",
  'shouldn\'t have', 'should not have', 'unexpected',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectInterestInvestigation(
  summary: string,
  description: string,
  workType: string | null | undefined,
): InterestInvestigationDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const type = (workType || '').toLowerCase();

  const interest = findMatches(text, INTEREST_SIGNALS);
  const interestWorkType = type.includes('interest');
  if (!interest.length && !interestWorkType) {
    return { matched: false, reasons: [] };
  }

  const waiver = findMatches(text, WAIVER_SIGNALS);
  if (waiver.length) {
    return { matched: false, reasons: [`vetoed (handled by Reverse Fee — waiver ask): ${waiver[0]}`] };
  }

  const asks = findMatches(text, INVESTIGATE_SIGNALS);
  const context = findMatches(text, CONTEXT_SIGNALS);

  const reasons: string[] = [];
  if (interest.length) reasons.push(`Interest mentioned: ${interest[0]}`);
  else if (interestWorkType) reasons.push(`Interest work type: ${workType}`);
  if (asks.length) reasons.push(`Investigation ask: ${asks[0]}`);
  if (context.length) reasons.push(`Dispute evidence: ${context[0]}`);

  return { matched: asks.length > 0 || context.length > 0, reasons };
}
