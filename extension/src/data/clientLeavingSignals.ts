// Phrases that indicate the client is closing / cancelling / has not used the card.
// Shared by reverseFeeDetect and retentionFeeWaiverDetect so a "close the card +
// annual fee" ticket flips cleanly from Retention to Reverse Fee (retention only
// applies when the client is being retained; if they're leaving anyway, the fee
// is a reversal, not a goodwill credit).

export const CLIENT_LEAVING_SIGNALS = [
  'close the card', 'close my card', 'close their card', 'close this card',
  'closing the card', 'closing my card', 'closing their card',
  'closed the card', 'closed my card', 'closed his card', 'closed her card',
  'cancel the card', 'cancel my card', 'cancel their card', 'cancel this card',
  'cancelling the card', 'cancelled the card', 'canceled the card',
  // "CC" abbreviation variants — clients / agents commonly write "close their CC"
  // instead of "close their card". Mirror the full "card" set so the abbreviation
  // triggers the same leaving-signal detection.
  'close the cc', 'close my cc', 'close their cc', 'close this cc',
  'closing the cc', 'closing my cc', 'closing their cc',
  'closed the cc', 'closed my cc', 'closed his cc', 'closed her cc',
  'cancel the cc', 'cancel my cc', 'cancel their cc', 'cancel this cc',
  'cancelling the cc', 'cancelled the cc', 'canceled the cc',
  'have not used', "haven't used", 'havent used', 'has not used', 'never used',
  'not used it', 'never activated', 'unused card',
];
