// Synthetic statement text for ccStatementParse tests.
//
// Deliberately NOT a capture of a real client's statement — a fixture lives in git
// forever, and a real one would put a client's name, address, card and full transaction
// history there. This reproduces the layout and, importantly, every pdf.js text-extraction
// artifact seen in real Wealthsimple statement PDFs:
//
//   - `BAL ANCE`            — kerning splits a word
//   - `$320.1 1`            — kerning splits an amount's last digit
//   - `Aug 1 1`             — kerning splits a day number, in either date column
//   - two summary columns merged onto one line (`- Payments … + Purchases …`)
//   - an FX sub-line on its own line, belonging to the row above it
//   - merchants that start with digits (`00103 MACS…`) or contain them (`DOLLARAMA #1496`)
//
// Shape is pages[pageIndex][lineIndex], matching extractStatementText's return value.

export const FIXTURE_PAGE_1 = [
  'Credit card statement',
  'Wealthsimple Jul 25 — Aug 24, 2026',
  '4126 50** **** 5666',
  'JAMIE T RIVERS',
  '99 EXAMPLE ST W, APT 4',
  'MONTREAL QC H2Y 1Z5',
  'STATEMENT BAL ANCE PAYMENT DUE DATE',
  '$1,234.56 Sep 15, 2026',
  'Statement date August 25, 2026 Minimum payment $61.72',
  'Credit limit $25,000.00',
  'If you only make the minimum payment each period, you will pay more in interest. The estimated time to pay your new',
  'balance in full if you only pay the minimum payment each month is 7 years and 8 months',
  'Account summary',
  'Previous balance $2,714.06',
  '- Payments $2,714.06 + Purchases $1,234.56',
  '- Other credits $0.00 + Fees $0.00',
  '+ Interest $0.00',
  'Total payments/credits $2,714.06',
  'Annual interest rate 20.99%',
  '+ Cash advances $0.00',
  'Cash advance interest rate 22.99%',
  'Total charges $1,234.56',
  'Total payments/credits –$2,714.06',
  'New balance $1,234.56',
  'Page 1 of 3 Wealthsimple Payments Inc., 400 - 80 Spadina Ave, Toronto, ON, M5V 2J4',
];

export const FIXTURE_PAGE_2 = [
  'Credit card statement',
  'Wealthsimple Jul 25 — Aug 24, 2026',
  '4126 50** **** 5666',
  'JAMIE T RIVERS',
  '99 EXAMPLE ST W, APT 4',
  'MONTREAL QC H2Y 1Z5',
  'Activity',
  'TRANS. DATE POSTED DATE TYPE DETAILS AMOUNT ($CAD)',
  'Jul 25 Jul 25 Payment From chequing account –$2,714.06',
  'Jul 26 Jul 26 Purchase DOLLARAMA #1496 $52.89',
  'Jul 27 Jul 28 Purchase HOTEL MOTEL GEORGES $320.1 1',
  'Jul 28 Jul 29 Purchase 00103 MACS CONV. STORES $18.45',
  'Aug 3 Aug 4 Purchase SIXT RENT BOOKING $560.60',
  '345.84 EUR • 1.620981 exchange rate',
  'Aug 10 Aug 1 1 Purchase AMZN MKTP CA*5H6IW8E00 $212.69',
  'Aug 1 1 Aug 1 1 Purchase APPLE.COM/BILL $14.94',
  'Page 2 of 3 Wealthsimple Payments Inc., 400 - 80 Spadina Ave, Toronto, ON, M5V 2J4',
];

export const FIXTURE_PAGE_3 = [
  'Credit card statement',
  'Wealthsimple Jul 25 — Aug 24, 2026',
  '4126 50** **** 5666',
  'JAMIE T RIVERS',
  '99 EXAMPLE ST W, APT 4',
  'MONTREAL QC H2Y 1Z5',
  'TRANS. DATE POSTED DATE TYPE DETAILS AMOUNT ($CAD)',
  'Aug 12 Aug 13 Refund settled SP STEVE MADDEN CA –$112.98',
  'Aug 20 Aug 20 Purchase LE CIRCUIT ELECTRIQUE $20.00',
  'Aug 22 Aug 23 Purchase GOOGLE *GOOGLE ONE $31.03',
  'Aug 24 Aug 24 Cash advance ATM WITHDRAWAL $200.00',
  'Page 3 of 3 Wealthsimple Payments Inc., 400 - 80 Spadina Ave, Toronto, ON, M5V 2J4',
];

export const FIXTURE_DISCLOSURE_PAGE = [
  'Credit card statement',
  'Wealthsimple Jul 25 — Aug 24, 2026',
  '4126 50** **** 5666',
  'JAMIE T RIVERS',
  '99 EXAMPLE ST W, APT 4',
  'MONTREAL QC H2Y 1Z5',
  'Information about your Wealthsimple Visa Infinite* credit card, Wealthsimple Visa Infinite +*',
  '1 Minimum payment is the minimum amount you must pay this month by the payment due date.',
  '3 Missed payments : Your annual interest rates will increase to 25.99% on purchases and 27.99% on cash advances, and cash-',
  'Toll-free (Canada + USA): 1-855-585-2672',
];

export const FIXTURE_PAGES: string[][] = [
  FIXTURE_PAGE_1,
  FIXTURE_PAGE_2,
  FIXTURE_PAGE_3,
  FIXTURE_DISCLOSURE_PAGE,
];
