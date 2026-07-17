// Wallet Triage workflow constants — URLs the workflow opens, and the
// comment template fragment used after the @mention.

// Dashboard URL stripped of `native_filters_key`. Per [[preset-native-filters-key]]:
// the Preset content script can't clear filter chips baked into that URL param,
// so we apply the identity_id filter via chrome.storage.local instead.
export const WALLET_TRIAGE_DASHBOARD_URL =
  'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/8014/';

// Internal reference doc that agents consult alongside the Preset dashboard
// when triaging wallet-provisioning issues.
export const WALLET_TRIAGE_DOC_URL =
  'https://docs.google.com/document/d/18G1-lYpfxS-FHDVTYwKyypmnXF_0evFO2pFTJRRIbXU/edit?tab=t.0#heading=h.oqcm6k38vnmt';

// ===== Decision tree outcomes (Step 2 of the workflow) =====

export type WalletTriageOutcomeKey =
  | 'MAX_TOKEN_LIMIT'
  | 'DEVICE_TOKEN_MATCH'
  | 'NO_DECLINE'
  | 'DEVICE_SCORE'
  | 'WOCOO_REVIEW';

export interface WalletTriageOutcome {
  key: WalletTriageOutcomeKey;
  /** Card title shown in the Step 2 picker. */
  label: string;
  /** One-line description shown under the title — names the chart that triggers this outcome. */
  subtitle: string;
  /** Template body — comes after "Hi @<reporter> after looking into the Preset dashboard doc <doc-url> ". */
  bodyTemplate: string;
  /** true → transition to Done on submit; false → leave the ticket open. */
  shouldTransition: boolean;
}

export const WALLET_TRIAGE_OUTCOMES: WalletTriageOutcome[] = [
  {
    key: 'MAX_TOKEN_LIMIT',
    label: 'Max token limit hit',
    subtitle: 'Step 1 chart: distinct_token_count = 20',
    bodyTemplate:
      'I can see that the client has hit the maximum token limit (20 tokens). ' +
      'A token must be deactivated before a new one can be added. ' +
      'Please ask the client to deactivate an existing token first, then retry.',
    shouldTransition: true,
  },
  {
    key: 'DEVICE_TOKEN_MATCH',
    label: 'Active device token matches',
    subtitle: "Step 2 chart: token_device_number matches client's device",
    bodyTemplate:
      "I can see there's an active device token matching the client's device. " +
      "I'll deactivate the matching token in i2c — please ask the client to try adding the card again.",
    shouldTransition: true,
  },
  {
    key: 'NO_DECLINE',
    label: 'No decline on record',
    subtitle: 'Step 3 chart: empty / blank error_message',
    bodyTemplate:
      "I don't see any decline on record. " +
      'Please ask the client to try adding the card again; escalate if the issue persists.',
    shouldTransition: true,
  },
  {
    key: 'DEVICE_SCORE',
    label: 'Device score issue',
    subtitle: 'Step 3 chart: error_message present + scr_info_devicescore ≤ 3',
    bodyTemplate:
      'I can see that the decline is due to a device score issue. ' +
      'Please send the client the device score macro.',
    shouldTransition: true,
  },
  {
    key: 'WOCOO_REVIEW',
    label: 'Other decline — WOCOO review',
    subtitle: 'Step 3 chart: error_message present + scr_info_devicescore > 3',
    bodyTemplate:
      "I see a decline that isn't related to device score. Cutting to WOCOO for review.",
    shouldTransition: false,
  },
];

/**
 * Build the full templated comment text the Step 3 textarea pre-fills with.
 * The literal "@<reporter name>" and doc URL substrings inside the result are
 * detected at submit time and re-emitted as ADF mention + link nodes.
 */
export function buildOutcomeCommentText(reporterName: string, docUrl: string, body: string): string {
  return `Hi @${reporterName} after looking into the Preset dashboard doc ${docUrl} ${body}`;
}
