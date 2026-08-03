// Detection for tickets that must route to an L3 agent rather than being handled
// in-panel: fee reversals, QC fee waivers, eligible-DD verification, Code 450,
// joint-account CC/fee asks, and direct-deposit timing analysis.

import { detectReverseFee } from './reverseFeeDetect';
import { detectQCFeeWaiver } from './qcFeeWaiverDetect';
import { detectQCAutoReimb } from './qcAutoReimbDetect';
import { detectInterestInvestigation } from './interestInvestigationDetect';

export interface L3EscalationDetection {
  matched: boolean;
  reasons: string[];
}

const CODE_450_SIGNALS = ['code 450', '450 dd'];

const CC_FEE_WAIVER_PHRASES = [
  'cc fee waiver',
  'credit card fee waiver',
  'cc fees waiver',
  'credit card fees waiver',
];

const FEE_ACTION_VERBS =
  'reverse|reversed|refund|refunded|waive|waived|remove|removed|reimburse|reimbursed|credit';

// "refund the CC fee", "waive fees on their credit card", "credit card fee … reversed"
const CC_FEE_ACTION_PATTERNS = [
  new RegExp(`\\b(?:${FEE_ACTION_VERBS})\\b(?:\\s+\\w+){0,4}?\\s+(?:credit\\s+card|cc)\\s+fees?\\b`, 'i'),
  new RegExp(
    `\\b(?:${FEE_ACTION_VERBS})\\b(?:\\s+\\w+){0,4}?\\s+fees?\\s+(?:on|for|from)\\s+(?:the\\s+|their\\s+|his\\s+|her\\s+)?(?:credit\\s+card|cc)\\b`,
    'i',
  ),
  new RegExp(`\\b(?:credit\\s+card|cc)\\s+fees?\\b[\\s\\S]{0,80}?\\b(?:${FEE_ACTION_VERBS})\\b`, 'i'),
];

const JOINT_SIGNALS = [
  'joint account', 'joint holder', ' joint ',
  'co-holder', 'coholder', 'co holder',
  'secondary holder', 'secondary cardholder',
  'add a person', 'add another person', 'adding a person',
];

const CC_FEE_CONTEXT = [
  'credit card', 'cc ', 'cc:',
  'annual fee', 'fee waiver', 'fee waived',
  'waive the fee', 'reverse the fee', 'refund the fee',
];

const DD_ANALYSIS_PATTERNS = [
  /\b(analyze|analyse|check|verify|confirm|review|look\s+into|look\s+at)\s+(the\s+)?(direct\s+deposit|dd)\b/i,
  /\banaly[sz]e\s+(a\s+|the\s+)?(specific\s+)?(direct\s+deposit|dd)\b/i,
];

const FEE_WORD = /\bfees?\b/i;
const DD_WORD = /\b(?:dd|dds|direct\s+deposits?|monthly\s+dd|monthly\s+direct\s+deposit)\b/i;
const CC_SIGNALS = ['credit card', 'cc ', 'cc:', 'cc fee', 'cc fees'];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectL3Escalation(
  summary: string,
  description: string,
  workType: string | null | undefined,
  attachmentCount: number = 0,
): L3EscalationDetection {
  const raw = `${summary || ''}\n${description || ''}`;
  const text = raw.toLowerCase();
  const reasons: string[] = [];

  // "Why was I charged this interest?" tickets look like Reverse Fee to the detector
  // below (interest mentioned in summary/description) but the agent's first move is the
  // Interest Validation tool, not an L3 handoff.
  const investigation = detectInterestInvestigation(summary, description, workType);
  if (investigation.matched) {
    return { matched: false, reasons: [`vetoed (handled by Interest Investigation): ${investigation.reasons[0] || 'matched'}`] };
  }

  const reverseFee = detectReverseFee(summary, description, workType, attachmentCount);
  if (reverseFee.matched) reasons.push(`Reverse Fee: ${reverseFee.reasons[0] || 'matched'}`);

  const qcFeeWaiver = detectQCFeeWaiver(summary, description, workType);
  if (qcFeeWaiver.matched) reasons.push(`QC Fee Waiver: ${qcFeeWaiver.reasons[0] || 'matched'}`);

  const eligibleDD = detectQCAutoReimb(summary, description);
  if (eligibleDD.matched) reasons.push(`Verify Eligible DD: ${eligibleDD.reasons[0] || 'matched'}`);

  const code450 = findMatches(text, CODE_450_SIGNALS);
  if (code450.length) reasons.push(`Code 450: ${code450[0]}`);

  const waiverPhrases = findMatches(text, CC_FEE_WAIVER_PHRASES);
  let feeActionMatch: string | null = null;
  for (const re of CC_FEE_ACTION_PATTERNS) {
    const m = raw.match(re);
    if (m) { feeActionMatch = m[0]; break; }
  }
  const ccFeeAction = waiverPhrases.length > 0 || feeActionMatch !== null;
  if (ccFeeAction) reasons.push(`CC fee-action ask: ${(waiverPhrases[0] || feeActionMatch || '').trim()}`);

  const joint = findMatches(text, JOINT_SIGNALS);
  const ccContext = findMatches(text, CC_FEE_CONTEXT);
  const jointCC = joint.length > 0 && ccContext.length > 0;
  if (jointCC) reasons.push(`Joint account + CC/fee: ${joint[0].trim()} · ${ccContext[0].trim()}`);

  let ddAnalysis: string | null = null;
  for (const re of DD_ANALYSIS_PATTERNS) {
    const m = raw.match(re);
    if (m) { ddAnalysis = m[0]; break; }
  }
  if (ddAnalysis) reasons.push(`DD analysis request: ${ddAnalysis.trim()}`);

  // Credit-card ticket that mentions both a fee and a direct deposit — the DD timing
  // analysis these need is an L3 job.
  const ccWorkType = (workType || '').toLowerCase().includes('credit card');
  const ccMention = findMatches(text, CC_SIGNALS).length > 0;
  const feeHit = raw.match(FEE_WORD);
  const ddHit = raw.match(DD_WORD);
  const ccFeeDD = (ccWorkType || ccMention) && feeHit !== null && ddHit !== null;
  if (ccFeeDD && feeHit && ddHit) reasons.push(`CC + fee + DD: ${feeHit[0]} · ${ddHit[0]}`);

  return {
    matched:
      reverseFee.matched ||
      qcFeeWaiver.matched ||
      eligibleDD.matched ||
      code450.length > 0 ||
      ccFeeAction ||
      jointCC ||
      ddAnalysis !== null ||
      ccFeeDD,
    reasons,
  };
}

export function buildL3EscalationComment(reporterName: string | null | undefined): string {
  return `Hi ${reporterName ? `@${reporterName}` : 'team'} for these cases please connect with an L3 agent to resolve, thank you!`;
}
