// Pure readers for i2c's customer page (Accounts table + Card Details panel).

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\s*:\s*$/, '').toLowerCase();
const isLabel = (s: string) => /:\s*$/.test(s.trim());

export function readLabelValue(leaves: string[], label: string): string | null {
  const want = norm(label);
  const i = leaves.findIndex((l) => norm(l) === want);
  if (i < 0 || i + 1 >= leaves.length) return null;
  const next = leaves[i + 1].trim();
  if (!next || isLabel(next) || next === '-') return null;
  return next;
}

/**
 * Table grid from flat row records (direct cells only, with the index of the table each row
 * belongs to). Headers = first row containing `headerName`; data rows = the following rows of
 * that SAME table with a matching cell count, so a nested table's rows never leak in.
 */
export function gridFromRows(
  rows: { table: number; cells: string[] }[],
  headerName: string,
): { headers: string[]; rows: string[][] } {
  const want = norm(headerName);
  const h = rows.findIndex((r) => r.cells.some((c) => norm(c) === want));
  if (h < 0) return { headers: [], rows: [] };
  const { table, cells: headers } = rows[h];
  return {
    headers,
    rows: rows
      .slice(h + 1)
      .filter((r) => r.table === table && r.cells.length === headers.length)
      .map((r) => r.cells),
  };
}

/** The `columnName` cell of the row whose masked card number ends in `last4`. */
export function readColumnForLast4(headers: string[], rows: string[][], last4: string, columnName: string): string | null {
  const want = norm(columnName);
  const col = headers.findIndex((h) => norm(h) === want);
  if (col < 0) return null;
  const row = rows.find((r) => r.some((cell) => new RegExp(`[*x•]{3,}${last4}\\b`, 'i').test(cell)));
  const v = row?.[col]?.replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

export function readProgramForLast4(headers: string[], rows: string[][], last4: string): string | null {
  return readColumnForLast4(headers, rows, last4, 'Program');
}

export function parseI2cDelinquency(s: string | undefined): boolean | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (/not\s+delinquent/i.test(t)) return false;
  if (/delinquent/i.test(t)) return true;
  return null;
}

/** True when i2c's Customer Search page is showing its "No record found." banner
 *  (case-insensitive; tolerant of whitespace, "records", and the trailing period). */
export function pageSaysNoRecord(text: string): boolean {
  return /no\s+records?\s+found/i.test(text);
}
