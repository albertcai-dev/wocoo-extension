// Heuristic to detect credit-card overpayment tickets that should be routed to the
// Overpayment Triage workflow. Mirrors [[cred-route-detect]] / [[wallet-triage-detect]].
//
// The Overpayment Triage workflow handles clients who overpaid their credit card
// and want the credit balance refunded to their chequing account. Per the WOCOO
// Wiki criteria (memory: wocoo-jira-fields), the workflow only applies if the
// amount is ≥ $1,000 — but we don't gate detection on amount because the agent
// reads the description to confirm. The card surfaces the suggestion; the agent
// decides whether to run the workflow.

export interface OverpaymentTriageDetection {
  matched: boolean;
  reasons: string[];
}

const CC_TOPIC_SIGNALS = [
  'credit card', 'cc ', ' cc', 'credit-card', 'cc application',
];

const OVERPAYMENT_ACTION_SIGNALS = [
  'overpayment', 'over payment', 'over-payment', 'overpaid',
  'double payment', 'duplicate payment', 'extra payment',
  'credit balance', 'positive balance', 'negative balance',
  'refund the overpayment', 'refund overpayment',
  // Balance-movement patterns — refunds/credits accumulated on the CC, client
  // wants them moved back to their chequing. Same-shape ticket as an explicit
  // "overpayment", just phrased in terms of the client's action.
  'move refunds', 'transfer refunds',
  'refunds to chequing', 'refund to chequing',
  'balance to chequing', 'balance to their chequing',
  'move cc balance', 'transfer cc balance', 'move the cc balance',
  'funds back to chequing', 'funds back to their chequing',
  'move the balance to', 'transfer the balance to',
];

// Veto signals — phrasing that puts the ticket on a different workflow.
const VETOES = [
  'fee waiver', 'annual fee', 'fee reversal', 'dispute', 'chargeback',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectOverpaymentTriage(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): OverpaymentTriageDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  const vetoes = findMatches(text, VETOES);
  if (vetoes.length) return { matched: false, reasons: [`vetoed: ${vetoes[0]}`] };

  const ccTopic = findMatches(text, CC_TOPIC_SIGNALS);
  const action = findMatches(text, OVERPAYMENT_ACTION_SIGNALS);

  const reasons: string[] = [];
  if (ccTopic.length) reasons.push(`CC topic: ${ccTopic[0].trim()}`);
  if (action.length) reasons.push(`Overpayment action: ${action[0].trim()}`);

  const matched = ccTopic.length > 0 && action.length > 0;
  return { matched, reasons };
}
