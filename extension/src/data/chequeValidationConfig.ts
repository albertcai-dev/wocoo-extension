// Mobile Cheque Validation — channel + cc-list + message templates. Edit here when
// team membership changes or the channel is renamed.

export const MCV_CHANNEL_NAME = 'mobile-cheque-deposits-returns-working-group';

// Two Slack Workflow Builder webhooks — different message shapes for the two paths.
//
// ANOMALY workflow ("Personal Mobile Cheque Val"):
//   Single text variable `mcv_body` — extension sends the whole assembled anomaly text.
//   WB step DMs it as plain text (no cc, no pills, no bold — the anomaly template is
//   free-form and its content varies each time).
export const MCV_ANOMALY_WEBHOOK_URL = 'https://hooks.slack.com/triggers/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';
export const MCV_ANOMALY_WEBHOOK_VAR = 'mcv_body';

// READY workflow ("Mobile Cheque Validation - Ready DM"):
//   6 text variables — extension sends structured data. WB step body has the bold first
//   line + hardcoded mention pills for the 15 cc'd folks (typed as real @-pills in WB's
//   rich-text editor, not plain text). Dynamic parts (date + counts) come in via vars.
//   Setup order in the WB workflow:
//     Trigger: Webhook
//     Variables (all Text): mcv_date, received, processed, day1, ops_breach, risk_breach
//     Send Message → DM to Albert with the templated body (bold + mention pills baked in)
export const MCV_READY_WEBHOOK_URL = 'https://hooks.slack.com/triggers/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';
export const MCV_READY_WEBHOOK_VARS = {
  date: 'mcv_date',
  received: 'received',
  processed: 'processed',
  day1: 'day1',
  opsBreach: 'ops_breach',
  riskBreach: 'risk_breach',
} as const;

/** Names typed verbatim into Slack's @mention autocomplete. Order matches the canonical
 *  cc list from Albert's post. If a name needs disambiguation, write the full handle. */
export const MCV_CC_NAMES = [
  'Estelle',
  'Muaiz Khan',
  'Jonathan Fawcett',
  'Vanessa',
  'Nick Kiss',
  'Eugene',
  'Paula Bastos',
  'Odi',
  'Taylor',
  'Rose',
  'adriana',
  'Luke Gazmin',
  'Albert',
  'Ishan',
  'Amanda Burke',
];

/** "2026-06-15" → "June 15th, 2026" */
export function formatMCVDate(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const suffix = (n: number) => {
    if (n % 100 >= 11 && n % 100 <= 13) return 'th';
    if (n % 10 === 1) return 'st';
    if (n % 10 === 2) return 'nd';
    if (n % 10 === 3) return 'rd';
    return 'th';
  };
  return `${months[m - 1]} ${d}${suffix(d)}, ${y}`;
}

export interface MCVTotals {
  receivedCount: number;
  processedCount: number;
  day1Reversed: number;
  opsSlaBreach: number;
  riskSlaBreach: number;
}

export function buildMCVMessage(dateKey: string, totals: MCVTotals): string {
  return [
    `Hey Team, Here's a Validation update on mobile cheque deposit returns for ${formatMCVDate(dateKey)}.`,
    ``,
    `Cheque Returns: ✍️`,
    `Of the cheque ${totals.receivedCount} return images received, we have successfully processed ${totals.processedCount} ✅`,
    `Additionally ${totals.day1Reversed} "Day 1 Cheques" received via email have been reversed`,
    ``,
    `Breaches: 🤚`,
    `${totals.opsSlaBreach} Cheques breached Ops Reversal SLA`,
    `${totals.riskSlaBreach} Cheques breached Risk SLA`,
    ``,
    `cc: ${MCV_CC_NAMES.map((n) => '@' + n).join(' ')}`,
  ].join('\n');
}

export function buildMCVAnomalyDM(dateKey: string, anomalies: { kind: string; detail: string }[]): string {
  return [
    `⚠ Mobile Cheque Validation needs attention for ${formatMCVDate(dateKey)}.`,
    ``,
    `Channel post was NOT sent. Issues found:`,
    ...anomalies.map((a) => `• ${a.kind}: ${a.detail}`),
    ``,
    `Open the tracker sheet to investigate.`,
  ].join('\n');
}
