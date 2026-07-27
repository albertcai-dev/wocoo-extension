// Retention Fee Waiver — constants + description parser.
//
// Simpler than QC Fee Waiver: pick N months, credit $20 × N via i2c Admin Funds Credit,
// post confirmation comment, mark ticket Done.

export const RETENTION_RATE_PER_MONTH = 20;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Return 0-based month index for a full or 3-letter month name, or null on miss. */
function monthNameToIndex(name: string): number | null {
  const lower = name.toLowerCase();
  const full = MONTH_NAMES.indexOf(lower);
  if (full >= 0) return full;
  if (lower.length >= 3) {
    const abbr = MONTH_NAMES.findIndex((m) => m.startsWith(lower.slice(0, 3)));
    if (abbr >= 0) return abbr;
  }
  return null;
}

/** Best-effort auto-parse of "months to waive" from ticket text (summary + description
 *  concatenated). Priority order:
 *    1. `<N> month(s)` — "12 months", "3 month".
 *    2. `<N> year(s)` → N × 12 months (capped at 12; multi-year is unlikely + capped).
 *    3. `a year` / `one year` / `the year` — bare "year" without a numeric qualifier.
 *    4. `<Month> <YYYY> [-/to/through] <Month> <YYYY>` — retention offers frequently
 *       describe the credit window as a date range ("August 2026 - August 2027"); compute
 *       months by (y2-y1)*12 + (m2-m1), which treats the endpoints as month starts, so
 *       "Aug 2026 – Aug 2027" is 12 months (Aug through the following Jul, inclusive).
 *    5. `$<amount>` — back-derive months = amount / $20 when evenly divisible.
 *
 *  Returns null when nothing sensible matches; the workflow prefills `1` as a fallback
 *  so the agent can type over it in one keystroke. Values outside 1–12 are rejected /
 *  clamped (a retention credit spanning more than a card-year is almost certainly a
 *  parse error). */
export function parseRetentionMonthsFromText(text: string): number | null {
  if (!text) return null;

  const monthsMatch = text.match(/\b(\d+)[\s-]+months?\b/i);
  if (monthsMatch) {
    const n = parseInt(monthsMatch[1], 10);
    if (n > 0 && n <= 12) return n;
  }

  const yearsMatch = text.match(/\b(\d+)[\s-]+years?\b/i);
  if (yearsMatch) {
    const y = parseInt(yearsMatch[1], 10);
    if (y >= 1) return 12;
  }

  if (/\b(?:a|an|one|the)\s+year\b/i.test(text)) {
    return 12;
  }

  const rangeMatch = text.match(
    /\b([A-Za-z]+)\s+(\d{4})\s*(?:[-–—]+|to|through|thru)\s*([A-Za-z]+)\s+(\d{4})\b/i,
  );
  if (rangeMatch) {
    const m1 = monthNameToIndex(rangeMatch[1]);
    const y1 = parseInt(rangeMatch[2], 10);
    const m2 = monthNameToIndex(rangeMatch[3]);
    const y2 = parseInt(rangeMatch[4], 10);
    if (m1 !== null && m2 !== null && y1 > 0 && y2 > 0) {
      const diff = (y2 - y1) * 12 + (m2 - m1);
      if (diff > 0 && diff <= 12) return diff;
      if (diff > 12) return 12;
    }
  }

  const amountMatch = text.match(/\$(\d+)\b/);
  if (amountMatch) {
    const dollars = parseInt(amountMatch[1], 10);
    if (dollars > 0 && dollars % RETENTION_RATE_PER_MONTH === 0) {
      const derived = dollars / RETENTION_RATE_PER_MONTH;
      if (derived > 0 && derived <= 12) return derived;
    }
  }

  return null;
}

// Deprecated alias — kept so any older imports still resolve. Prefer parseRetentionMonthsFromText.
export const parseRetentionMonthsFromDescription = parseRetentionMonthsFromText;

export function buildRetentionCommentTemplate(reporter: string, months?: number | null): string {
  const mention = reporter ? `@${reporter}` : '@team';
  const qualifier = months && months > 0 ? `${months} month ` : '';
  return `Hi ${mention} the ${qualifier}fee credit has been added to client's cc account!`;
}
