// Wealthsimple credit card statement parser.
//
// Pure: takes the per-page visual lines that ccStatementPdf.extractStatementText produces
// and returns structured fields. No DOM, no pdf.js, no network — so it is unit-testable
// against a text fixture.
//
// Deliberately deterministic rather than model-driven. Every number here ends up on a
// document a client reads, so a parser that fails loudly (blank field, zero rows, an
// arithmetic warning) is worth more than a model that fails plausibly.
//
// The parser never throws on bad input. It fills what it can and appends to `warnings`;
// the workflow decides what is fatal, and every field it produces stays editable in the UI.

export interface StatementActivityRow {
  transDate: string;
  postedDate: string;
  type: string;
  /** May contain a single "\n" separating the merchant from its FX sub-line. */
  details: string;
  /** Includes the currency symbol, and an en-dash for credits: "–$2,714.06". */
  amount: string;
}

export interface ParsedStatement {
  cardMasked: string;
  nameOnStatement: string;
  /** The stale address, exactly as printed. Shown for contrast; never used as output. */
  addressLines: string[];

  statementDate: string;
  openingDate: string;
  closingDate: string;
  paymentDueDate: string;
  creditLimit: string;
  minimumPayment: string;
  statementBalance: string;

  previousBalance: string;
  payments: string;
  otherCredits: string;
  purchases: string;
  fees: string;
  interest: string;
  cashAdvances: string;
  totalCharges: string;
  totalPaymentsCredits: string;
  newBalance: string;
  annualInterestRate: string;
  cashAdvanceInterestRate: string;

  rows: StatementActivityRow[];
  warnings: string[];
}

/**
 * Transaction types, longest first so "Refund settled" wins over "Refund" and
 * "Cash advance" over "Cash". Anchoring the TYPE column to a known set is what keeps the
 * DETAILS column unambiguous — merchant names can otherwise look like anything.
 */
const ROW_TYPES = [
  'Refund settled',
  'Balance transfer',
  'Cash advance',
  'Cash-like',
  'Adjustment',
  'Reversal',
  'Purchase',
  'Payment',
  'Interest',
  'Refund',
  'Credit',
  'Fee',
];

/** "Jul 25", and the kerning-split "Aug 1 1". Greedy, so the longer day wins. */
const DATE = String.raw`[A-Z][a-z]{2}\s+\d(?:\s?\d)?`;

/**
 * "$52.89", "–$2,714.06", and the kerning-split "$320.1 1". Spaces are tolerated inside
 * the digit runs and stripped by `tidyAmount`; a leading en-dash, hyphen or minus all
 * normalize to an en-dash, which is what real statements print.
 */
const AMOUNT = String.raw`[–\-−]?\$[\d,][\d,\s]*\.[\d\s]*\d`;

const ROW_RE = new RegExp(
  String.raw`^(${DATE})\s+(${DATE})\s+(${ROW_TYPES.join('|')})\s+(.+?)\s+(${AMOUNT})\s*$`,
);

/** "345.84 EUR • 1.620981 exchange rate" — belongs to the row above, not a row itself. */
const FX_SUBLINE_RE = /^[\d,.\s]+[A-Z]{3}\s*[•·]\s*[\d.\s]+exchange rate$/;

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseStatement(pages: string[][]): ParsedStatement {
  const warnings: string[] = [];
  const page1 = pages[0] ?? [];
  const page1Text = page1.join('\n');

  const identity = parseIdentity(pages);
  const period = parsePeriod(page1Text);
  const headline = parseHeadline(page1);

  const s: ParsedStatement = {
    cardMasked: identity.cardMasked,
    nameOnStatement: identity.name,
    addressLines: identity.addressLines,

    statementDate: firstMatch(page1Text, new RegExp(String.raw`Statement date\s+((?:${MONTHS})\s+\d{1,2},?\s*\d{4})`, 'i')),
    openingDate: period.opening,
    closingDate: period.closing,
    paymentDueDate: headline.dueDate,
    creditLimit: amountField(page1Text, String.raw`Credit limit`),
    minimumPayment: amountField(page1Text, String.raw`Minimum payment`),
    // The headline pair ("$1,234.56   Sep 15, 2026") is the reliable source; the label
    // itself arrives kerning-split as "STATEMENT BAL ANCE", so it is only a fallback.
    statementBalance: headline.balance || amountField(page1Text, String.raw`Statement bal\s?ance`),

    previousBalance: amountField(page1Text, String.raw`Previous balance`),
    payments: amountField(page1Text, String.raw`[-–−]\s*Payments`),
    otherCredits: amountField(page1Text, String.raw`[-–−]\s*Other credits`),
    purchases: amountField(page1Text, String.raw`\+\s*Purchases`),
    fees: amountField(page1Text, String.raw`\+\s*Fees`),
    // "+ Interest" only — never the "Annual interest rate" / "Cash advance interest
    // rate" rows, which carry a percentage rather than a dollar figure.
    interest: amountField(page1Text, String.raw`\+\s*Interest`),
    cashAdvances: amountField(page1Text, String.raw`\+\s*Cash advances`),
    totalCharges: amountField(page1Text, String.raw`Total charges`),
    totalPaymentsCredits: amountField(page1Text, String.raw`Total payments/credits`),
    newBalance: amountField(page1Text, String.raw`New balance`),
    annualInterestRate: percentField(page1Text, String.raw`Annual interest rate`),
    cashAdvanceInterestRate: percentField(page1Text, String.raw`Cash advance interest rate`),

    rows: parseRows(pages),
    warnings,
  };

  if (!s.rows.length) {
    warnings.push('Found no activity rows. Either this is not a Wealthsimple statement, or its layout changed.');
  }
  for (const [label, value] of [
    ['statement date', s.statementDate],
    ['payment due date', s.paymentDueDate],
    ['credit limit', s.creditLimit],
    ['minimum payment', s.minimumPayment],
    ['statement balance', s.statementBalance],
    ['new balance', s.newBalance],
  ] as const) {
    if (!value) warnings.push(`Could not find the ${label} — fill it in below.`);
  }

  const charged = s.rows
    .filter((r) => !isCredit(r.amount))
    .reduce((sum, r) => sum + numericAmount(r.amount), 0);
  const totalCharges = numericAmount(s.totalCharges);
  if (s.rows.length && totalCharges > 0 && Math.abs(charged - totalCharges) > 0.01) {
    warnings.push(
      `Activity charges add up to ${formatAmount(charged)} but the summary says total charges are ` +
      `${s.totalCharges}. Check for a missed row before generating.`,
    );
  }

  return s;
}

// ============================================================
// Identity block — repeats on every page, so page 1 is enough
// ============================================================

const CARD_RE = /^\d{4}\s+\d{2}\*{2}\s+\*{4}\s+\d{4}$/;

function parseIdentity(pages: string[][]): { cardMasked: string; name: string; addressLines: string[] } {
  for (const lines of pages) {
    const cardIdx = lines.findIndex((l) => CARD_RE.test(l.trim()));
    if (cardIdx === -1) continue;

    // Layout below the card number is: name, then 1-3 address lines, then a section
    // heading ("Activity", "Account summary") or the statement's body copy.
    const name = (lines[cardIdx + 1] ?? '').trim();
    const addressLines: string[] = [];
    for (let i = cardIdx + 2; i < lines.length && addressLines.length < 3; i++) {
      const line = lines[i].trim();
      if (!line || isSectionHeading(line)) break;
      addressLines.push(line);
    }
    return { cardMasked: lines[cardIdx].trim(), name, addressLines };
  }
  return { cardMasked: '', name: '', addressLines: [] };
}

function isSectionHeading(line: string): boolean {
  return /^(Activity|Account summary|TRANS\.|STATEMENT|Information about|If you only)/i.test(line);
}

// ============================================================
// Period, headline pair
// ============================================================

/**
 * "Wealthsimple Jul 25 — Aug 24, 2026" carries only the closing year, so the opening
 * year is inferred: a period that runs Dec -> Jan opened in the previous year.
 */
function parsePeriod(text: string): { opening: string; closing: string } {
  const m = text.match(
    new RegExp(String.raw`\b([A-Z][a-z]{2})\s+(\d{1,2})\s*[—–-]\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})`),
  );
  if (!m) return { opening: '', closing: '' };

  const [, openMonth, openDay, closeMonth, closeDay, closeYear] = m;
  const openIdx = MONTH_ABBREVS.indexOf(openMonth);
  const closeIdx = MONTH_ABBREVS.indexOf(closeMonth);
  const openYear = openIdx > closeIdx && openIdx !== -1 && closeIdx !== -1
    ? String(Number(closeYear) - 1)
    : closeYear;

  return {
    opening: `${openMonth} ${openDay}, ${openYear}`,
    closing: `${closeMonth} ${closeDay}, ${closeYear}`,
  };
}

/** The big "$1,234.56   Sep 15, 2026" pair under the STATEMENT BALANCE / DUE DATE labels. */
function parseHeadline(lines: string[]): { balance: string; dueDate: string } {
  const re = new RegExp(String.raw`^(${AMOUNT})\s+([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})$`);
  for (const line of lines) {
    const m = line.trim().match(re);
    if (m) return { balance: tidyAmount(m[1]), dueDate: m[2].replace(/\s+/g, ' ') };
  }
  return { balance: '', dueDate: '' };
}

// ============================================================
// Activity rows
// ============================================================

function parseRows(pages: string[][]): StatementActivityRow[] {
  const rows: StatementActivityRow[] = [];

  for (const lines of pages) {
    for (const raw of lines) {
      const line = raw.trim();

      if (FX_SUBLINE_RE.test(line)) {
        // Belongs to the row immediately above. If there is no such row the sub-line is
        // dropped rather than guessed at.
        const last = rows[rows.length - 1];
        if (last && !last.details.includes('\n')) last.details += `\n${line}`;
        continue;
      }

      const m = line.match(ROW_RE);
      if (!m) continue;
      const [, transDate, postedDate, type, details, amount] = m;
      rows.push({
        transDate: tidyDate(transDate),
        postedDate: tidyDate(postedDate),
        type,
        details: details.trim(),
        amount: tidyAmount(amount),
      });
    }
  }

  return rows;
}

// ============================================================
// Field helpers
// ============================================================

function firstMatch(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function amountField(text: string, labelPattern: string): string {
  const m = text.match(new RegExp(labelPattern + String.raw`\s*:?\s+(${AMOUNT})`, 'i'));
  return m ? tidyAmount(m[1]) : '';
}

function percentField(text: string, labelPattern: string): string {
  const m = text.match(new RegExp(labelPattern + String.raw`\s*:?\s+([\d.\s]+\s*%)`, 'i'));
  return m ? m[1].replace(/\s+/g, '') : '';
}

/** "Aug 1 1" -> "Aug 11". Only touches the day, never the month. */
function tidyDate(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  const month = parts.shift() ?? '';
  return `${month} ${parts.join('')}`;
}

/**
 * "$320.1 1" -> "$320.11", and any of -/−/– -> the en-dash real statements print.
 * Spaces inside the digits are kerning artifacts; there are never real spaces there.
 */
function tidyAmount(raw: string): string {
  const cleaned = raw.replace(/\s+/g, '');
  return cleaned.replace(/^[-−]/, '–');
}

function isCredit(amount: string): boolean {
  return /^[–\-−]/.test(amount);
}

function numericAmount(amount: string): number {
  const n = Number(amount.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatAmount(n: number): string {
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
