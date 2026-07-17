// Configuration for the Wires Pending Posting assistant.
// Lock all sheet/column constants here so content scripts and the orchestrator agree.

export const WIRES_SHEET_ID = '1QdnxRmBxSAilFe_5QtDhsm3fZfAfxsUBLoChEMhdQZw';
export const WIRES_SHEET_TAB = 'Incoming Wires';
export const WIRES_SHEET_GID = 186014769;
export const WIRES_SHEET_URL = `https://docs.google.com/spreadsheets/d/${WIRES_SHEET_ID}/edit?gid=${WIRES_SHEET_GID}#gid=${WIRES_SHEET_GID}`;

// Column letters as documented by Albert. Header row is row 1.
export const COL = {
  WIRE_TIMESTAMP: 'A',
  SENDER_NAME: 'B',
  AMOUNT: 'C',                  // e.g. "$74.36"
  CURRENCY: 'D',
  WIRE_TYPE: 'E',
  SENDING_FI: 'F',
  NOTES: 'G',
  CUSTODIAN_ACCOUNT_ID: 'H',    // plain text OR hyperlink to Atlassian
  ACCOUNT_CONFIRMED_DATE: 'I',
  E2E_IDENTIFIER: 'J',
  FINAL_STATUS_TIMESTAMP: 'K',
  WIRE_STATUS: 'L',             // "Pending posting" → "Posted" once verified
} as const;

export const PENDING_POSTING_STATUS = 'Pending posting';
export const POSTED_STATUS = 'Posted';

export const LEDGE_URL = 'https://ledge.wealthsimple.com/account-inquiry';

// One row's worth of data the orchestrator pulls from the sheet for verification.
export interface WireRow {
  /** 1-indexed spreadsheet row number (header is row 1, so the first data row is 2). */
  rowNumber: number;
  /** Column C as raw display text ("$39,986.49"). */
  amountText: string;
  /** Parsed amount as a number (39986.49). */
  amount: number;
  /** Column D currency code ("CAD", "USD"). */
  currency: string;
  /** Column H plain-text content (custodian account ID or display text for hyperlink). */
  custodianRaw: string;
  /** Column H hyperlink URL if the cell is a hyperlink — null otherwise. */
  custodianHyperlink: string | null;
  /** Column A wire_timestamp display text (e.g. "5/29/2026" or "2026-05-29"). Used by
   *  the Ledge driver to widen the From-date filter when the wire predates Ledge's
   *  default search window. Empty string if absent. */
  wireTimestamp: string;
}

// The orchestrator emits one of these per row as the run progresses.
export type WireRowStatus =
  | { kind: 'pending' }
  | { kind: 'checking'; via: 'ledge' | 'jira' }
  | { kind: 'posted' }
  | { kind: 'anomaly'; reason: string }
  | { kind: 'skipped'; reason: string };

export interface WireRowResult {
  row: WireRow;
  status: WireRowStatus;
}
