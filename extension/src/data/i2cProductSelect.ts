// Which row to click on i2c's "Product Search Result" page.
//
// i2c shows this interstitial when an email matches more than one cardholder product —
// e.g. a retail prepaid card alongside a Visa Infinite credit card. Every i2c flow the
// extension drives is credit-side (the side panel only offers i2c on credit card and
// interest work types; prepaid and cash go to Koho), so the credit row is always the
// one we want.
//
// Matching is on the Program Category column rather than the program name. Names carry
// tier, format and province — "Wealthsimple Visa Infinite Plus Basic 01 Physical Quebec"
// — so any name pattern would be guessing at i2c's naming scheme. Category is a closed
// vocabulary: Credit or Debit.

export interface ProductRow {
  /** The Program Category cell: "Credit" or "Debit". */
  category: string;
  /** The Status cell: "ACTIVE", "CLOSED", … */
  status: string;
}

/**
 * Index of the row to click, or `null` to leave the choice to the agent.
 *
 * Returns an index only when exactly one row is an active credit product. Abstaining on
 * ambiguity is deliberate: these flows apply real debits, so one extra click costs less
 * than picking the wrong card. Mirrors `ensureAccountSelected`, which also refuses to
 * choose when a client has several accounts.
 */
export function pickCreditProduct(rows: ProductRow[]): number | null {
  const matches: number[] = [];
  rows.forEach((row, i) => {
    const category = (row.category || '').trim().toLowerCase();
    const status = (row.status || '').trim().toLowerCase();
    if (category === 'credit' && status === 'active') matches.push(i);
  });
  return matches.length === 1 ? matches[0] : null;
}
