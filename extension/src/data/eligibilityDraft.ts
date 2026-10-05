// Renders the reply body. Format is byte-identical to CC Ops Automation's
// sendAutoRepliescheck2, so insurers see no change.

import type { CardFact } from './eligibilityTypes';

export function renderEligibilityDraft(args: {
  clientEmail: string | null;
  emailWasProvided: boolean;
  cards: CardFact[];
  requestedLast4: string;
}): string {
  const { clientEmail, emailWasProvided, cards, requestedLast4 } = args;
  for (const c of cards) {
    if (c.delinquent === null || !c.creationDate || !c.product) {
      throw new Error(`Card ${c.last4} has unknown standing, date or product — cannot draft.`);
    }
  }
  const ordered = [
    ...cards.filter((c) => c.last4 === requestedLast4),
    ...cards.filter((c) => c.last4 !== requestedLast4),
  ];
  const who = emailWasProvided && clientEmail ? ' ' + clientEmail : '';
  const blocks = ordered.map((c) =>
    '• Last 4 digits of card: ' + c.last4.padStart(4, '0') + '\n' +
    '• Status: ' + (c.delinquent ? 'the card is not in good standing' : 'the card is in good standing') + '\n' +
    '• Activation date: ' + c.creationDate + '\n' +
    '• Product: ' + c.product,
  );
  return (
    'Hi,\n\n' +
    'Here are the requested details for client' + who + ':\n\n' +
    blocks.join('\n\n') + '\n\n' +
    'Best,\nCash and Card Operations\n\n-- \n'
  );
}
