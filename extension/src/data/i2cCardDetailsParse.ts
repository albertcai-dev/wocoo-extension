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
