// Compares the i2c running balance to the workflow's amount. Overpayment compares absolute
// values (its running balances are negative: a credit on the card). Estate is sign-aware: a
// positive running balance is what the client owes, and a card in credit owes nothing — it
// must never read as a "match".

export type CompareMode = 'abs' | 'owed';

export function compareBalance(
  runningBalance: number,
  amount: number | null,
  mode: CompareMode,
): { matches: boolean; diff: number | null; nothingOwed: boolean } {
  if (mode === 'abs') {
    const diff = amount != null ? Math.abs(Math.abs(runningBalance) - amount) : null;
    return { matches: diff != null && diff < 0.01, diff, nothingOwed: false };
  }
  if (runningBalance <= 0) return { matches: false, diff: null, nothingOwed: true };
  const diff = amount != null ? Math.abs(runningBalance - amount) : null;
  return { matches: diff != null && diff < 0.01, diff, nothingOwed: false };
}
