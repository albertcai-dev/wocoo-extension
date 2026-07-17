// Heuristic to detect Quebec residents who need a MANUAL annual-fee waiver — the
// inverse of [[qc-auto-reimb-detect]], which catches the "client just became
// eligible, system auto-handles" case. Mirrors the existing detector shape.
//
// Mutual exclusion with QCAutoReimb: if any ELIGIBILITY_FLIP_SIGNALS are present,
// QCAutoReimb fires and we suppress this card. If those signals are absent and
// the QC + fee-topic combination matches, this card fires.

import { ELIGIBILITY_FLIP_SIGNALS } from './qcAutoReimbDetect';

export interface QCFeeWaiverDetection {
  matched: boolean;
  reasons: string[];
}

const QC_SIGNALS = ['qc', 'quebec', 'québec'];

const FEE_TOPIC_SIGNALS = [
  'fee waiver', 'fee waived', 'fees waived', 'fee reimbursement',
  'annual fee', 'cc fee', 'credit card fee',
  'waive the fee', 'reimburse the fee', 'reimburse the annual',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectQCFeeWaiver(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): QCFeeWaiverDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  const vetoes = findMatches(text, ELIGIBILITY_FLIP_SIGNALS);
  if (vetoes.length) return { matched: false, reasons: [`vetoed (handled by QCAutoReimb): ${vetoes[0]}`] };

  const qc = findMatches(text, QC_SIGNALS);
  const feeTopic = findMatches(text, FEE_TOPIC_SIGNALS);

  const reasons: string[] = [];
  if (qc.length) reasons.push(`QC mention: ${qc[0]}`);
  if (feeTopic.length) reasons.push(`Fee topic: ${feeTopic[0].trim()}`);

  const matched = qc.length > 0 && feeTopic.length > 0;
  return { matched, reasons };
}
