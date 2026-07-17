// Heuristic to detect tickets that look like a credit-card-into-wallet provisioning
// issue (Apple Pay / Google Pay / Samsung Pay / etc.). Mirrors the shape of
// [[cred-route-detect]] — exports a CCDetection-style result the WalletTriageCard
// uses to decide whether to surface the recommendation.

export interface WalletTriageDetection {
  matched: boolean;
  reasons: string[];
}

const CC_TOPIC_SIGNALS = [
  'credit card', 'cc ', ' cc', 'credit-card', 'cc application',
];

// Wallet / provisioning signals. Includes the technical Visa decline reasons
// because some agents quote them verbatim from i2c rather than saying "Apple Pay".
const WALLET_SIGNALS = [
  'apple pay', 'google pay', 'samsung pay', 'garmin pay',
  'virtual wallet', 'phone wallet', 'mobile wallet',
  'wallet provisioning', 'tokenization',
  'visa provisioning service', 'red path',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectWalletTriage(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): WalletTriageDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const ccTopic = findMatches(text, CC_TOPIC_SIGNALS);
  const wallet = findMatches(text, WALLET_SIGNALS);

  const reasons: string[] = [];
  if (ccTopic.length) reasons.push(`CC topic: ${ccTopic[0].trim()}`);
  if (wallet.length) reasons.push(`Wallet signal: ${wallet[0].trim()}`);

  // Match rule: BOTH a credit-card topic signal AND a wallet signal must appear.
  const matched = ccTopic.length > 0 && wallet.length > 0;
  return { matched, reasons };
}
