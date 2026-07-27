// Heuristic to detect a "waive CC fee for N months" retention request. Mutually
// exclusive with QCFeeWaiver (QC signal vetoes) — QCAutoReimb sits alongside but
// requires QC + fee + flip, so it can't collide once we've dropped the QC path.

import { CLIENT_LEAVING_SIGNALS } from './clientLeavingSignals';

export interface RetentionFeeWaiverDetection {
  matched: boolean;
  reasons: string[];
}

const QC_SIGNALS = ['qc', 'quebec', 'québec'];

const FEE_TOPIC_SIGNALS = [
  'fee waiver', 'fee waived', 'fees waived', 'fee reimbursement',
  'annual fee', 'cc fee', 'cc fees', 'credit card fee',
  'waive the fee', 'waive cc fee', 'waive credit card fee',
  'waive the annual', 'reimburse the fee', 'reimburse the annual',
  // "Fee Credit Offer" is the summary convention for retention-tracker-sourced tickets;
  // "$120 in fees covered" is the shape of the description on those same tickets.
  'fee credit', 'fees covered',
];

// A retention waiver almost always references a time span the credit should cover.
// `annual` is included because "waive the annual fee" implies 12 months.
// Singular ' month' is deliberately excluded — it substring-matches " monthly" (an
// adjective describing a *single* fee's frequency), which pulled reverse-fee tickets
// like "waive the monthly fee charged on May 22" into Retention. Require plural or
// an explicit "a/per month" span to indicate a real multi-period retention ask.
const DURATION_SIGNALS = [
  ' months', ' year', ' years', 'a year', 'a month', 'per month', 'annual',
];

// Explicit retention/goodwill vocabulary — a strong positive signal on its own.
const RETENTION_SIGNALS = ['retention', 'goodwill', 'loyalty', 'retain'];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectRetentionFeeWaiver(
  summary: string,
  description: string,
): RetentionFeeWaiverDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  const qc = findMatches(text, QC_SIGNALS);
  if (qc.length) return { matched: false, reasons: [`vetoed (handled by QCFeeWaiver): ${qc[0]}`] };

  // No flip veto here: retention offers commonly reference "direct deposit" as a
  // condition ("waive fees WHILE client brings DD over"). QCAutoReimb requires
  // QC+fee+flip, so once we've cleared the QC check above it can't match either
  // path — vetoing on flip alone was silently dropping retention tickets.

  // Client is closing / cancelling / hasn't used the card → this is a reversal,
  // not retention. Let ReverseFee handle it.
  const leaving = findMatches(text, CLIENT_LEAVING_SIGNALS);
  if (leaving.length) return { matched: false, reasons: [`vetoed (handled by ReverseFee — client is closing): ${leaving[0].trim()}`] };

  const feeTopic = findMatches(text, FEE_TOPIC_SIGNALS);
  const duration = findMatches(text, DURATION_SIGNALS);
  const retention = findMatches(text, RETENTION_SIGNALS);

  const reasons: string[] = [];
  if (feeTopic.length) reasons.push(`Fee topic: ${feeTopic[0].trim()}`);
  if (retention.length) reasons.push(`Retention signal: ${retention[0]}`);
  if (duration.length) reasons.push(`Duration: ${duration[0].trim()}`);

  // Match: fee topic must be present, PLUS either an explicit retention marker or a
  // duration reference (which is the shape of a real retention ask: "waive the fee for
  // N months / a year").
  const matched = feeTopic.length > 0 && (retention.length > 0 || duration.length > 0);
  return { matched, reasons };
}
