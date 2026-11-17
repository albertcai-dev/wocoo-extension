// "Activate token" / "Deactivate token" i2c chains: the Sidekick Agent names a wallet token, and
// its draft card's button runs the usual login → customer chain, opens Manage Card Tokens, clicks
// Select on that token's row and fills the Change Status form, Comments = the Jira ticket link.
//   activate_token:   the InActive row → Status Active, Reason Authenticated with CSR.
//   deactivate_token: the Active row with the agent's exact Token ID → Status Deactivate, Reason
//                     Other. Never an InActive row (those get activated) or a DeActivated one.
// The user clicks Update Status; that click ticks the card's "I've done this".
//
// Pure helpers live here so they're testable; content/i2c.ts owns the DOM.

/** The two i2c flows that change a token's status. */
export type TokenFlow = 'activate_token' | 'deactivate_token';

export function isTokenFlow(v: unknown): v is TokenFlow {
  return v === 'activate_token' || v === 'deactivate_token';
}

/** Which token to change, as the agent read it on Manage Card Tokens. */
export interface TokenTarget {
  /** Token ID, digits only; deactivate_token matches on this alone. */
  tokenId?: string | null;
  /** Last 4 of the card the token is on. */
  cardLast4?: string | null;
  /** Device name as i2c shows it, e.g. "Fullmarginflux". */
  device?: string | null;
  /** Created On as i2c shows it, e.g. "10/31/2026 03:35 PM". */
  created?: string | null;
}

/** chrome.storage.local keys. */
export const TOKEN_TARGET_KEY = 'pending_i2c_token_target';
/** The chain's progress on Manage Card Tokens, across page loads. */
export const TOKEN_STEP_KEY = 'pending_i2c_token_step';
/** Set once the form is filled: the ticket whose Update Status click we're waiting for. */
export const TOKEN_AWAIT_UPDATE_KEY = 'pending_i2c_token_await_update';
/** Written when the user clicks Update Status; the draft card ticks "I've done this" from it. */
export const TOKEN_ACTIVATED_KEY = 'i2c_token_activated';

/** How long a filled form keeps waiting for Update Status, and how long a click counts. */
export const TOKEN_AWAIT_MAX_AGE_MS = 30 * 60_000;

export interface TokenAwait { sourceTicketId: string; at: number }
export interface TokenActivated { sourceTicketId: string; at: number }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The Manage Card Tokens table: the header row with a Status column and a token/device column. */
export function locateTokenColumns(rows: string[][]): { headerAt: number; statusAt: number } | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(norm);
    const statusAt = cells.findIndex((c) => /^(Token\s+)?Status$/i.test(c));
    if (statusAt < 0) continue;
    if (!cells.some((c) => /Token|Device/i.test(c) && !/Status/i.test(c))) continue;
    return { headerAt: i, statusAt };
  }
  return null;
}

/** "InActive" (provisioned, never verified) — never "Active" or "DeActivated". */
export function isInactiveStatus(s: string): boolean {
  return /^in\s*-?\s*active$/i.test(norm(s));
}

/** "Active" only — never "InActive" or "DeActivated". */
export function isActiveStatus(s: string): boolean {
  return /^active$/i.test(norm(s));
}

/** The header's Token ID column ("Token ID" / "Token Number" / "Token No."), or -1. */
export function locateTokenIdColumn(rows: string[][], headerAt: number): number {
  return (rows[headerAt] ?? []).findIndex((c) => /^Token\s*(ID|Number|No\.?)$/i.test(norm(c)));
}

/**
 * deactivate_token: the data row whose Token ID equals the agent's, and only if it is Active.
 * No device / created fallback: two rows can share a device name, and this is irreversible.
 */
export function pickActiveTokenRowById(rows: string[][], target: TokenTarget): number | null {
  if (!target.tokenId) return null;
  const cols = locateTokenColumns(rows);
  if (!cols) return null;
  const idAt = locateTokenIdColumn(rows, cols.headerAt);
  if (idAt < 0) return null;
  const hits: number[] = [];
  for (let i = cols.headerAt + 1; i < rows.length; i++) {
    if (!isActiveStatus(rows[i][cols.statusAt] ?? '')) continue;
    if ((rows[i][idAt] ?? '').replace(/\s+/g, '') === target.tokenId) hits.push(i);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** i2c writes "10/31/2026 03:35 PM"; the agent may drop the leading zeros or the time. */
function sameCreated(cellText: string, created: string): boolean {
  const key = (s: string) => {
    const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    const date = `${+m[1]}/${+m[2]}/${m[3]}`;
    return m[4] ? `${date} ${+m[4]}:${m[5]}` : date;
  };
  const want = key(created);
  if (!want) return false;
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/g;
  for (const m of cellText.matchAll(re)) {
    const got = key(m[0]);
    if (got && (got === want || got.startsWith(want + ' ') || want.startsWith(got + ' '))) return true;
  }
  return false;
}

/**
 * Which data row (index into `rows`) to click Select on. Only InActive rows qualify; with one,
 * that's it. With several, the agent's device / created time must narrow it to exactly one,
 * otherwise null: the user picks, never a guess.
 */
export function pickInactiveTokenRow(rows: string[][], target: TokenTarget): number | null {
  const cols = locateTokenColumns(rows);
  if (!cols) return null;
  const inactive: number[] = [];
  for (let i = cols.headerAt + 1; i < rows.length; i++) {
    if (isInactiveStatus(rows[i][cols.statusAt] ?? '')) inactive.push(i);
  }
  if (inactive.length === 1) return inactive[0];
  if (inactive.length === 0) return null;

  const text = (i: number) => norm(rows[i].join(' '));
  let narrowed = inactive;
  const device = target.device ? norm(target.device).toLowerCase() : '';
  if (device) {
    const hit = narrowed.filter((i) => text(i).toLowerCase().includes(device));
    if (hit.length) narrowed = hit;
  }
  if (narrowed.length > 1 && target.created) {
    const hit = narrowed.filter((i) => sameCreated(text(i), target.created!));
    if (hit.length) narrowed = hit;
  }
  return narrowed.length === 1 ? narrowed[0] : null;
}

/** Index of the option matching `re`, or -1. */
export function findOption(options: string[], re: RegExp): number {
  return options.findIndex((o) => re.test(norm(o)));
}

/** The Status dropdown's "Active" (some i2c builds say "Activate"); never InActive/DeActivated. */
export const ACTIVE_OPTION_RE = /^activ(e|ate|ated)$/i;
export const CSR_REASON_RE = /^authenticated\s+with\s+csr$/i;
export const UPDATE_STATUS_RE = /^update\s+status$/i;
/** The Status dropdown's deactivate option; never InActive/Active. */
export const DEACTIVATE_OPTION_RE = /^(de-?activ(e|ate|ated)|delete)$/i;
export const OTHER_REASON_RE = /^other$/i;

/** What each flow picks on the Change Status form. */
export function tokenFormFor(flow: TokenFlow): { statusRe: RegExp; reasonRe: RegExp; statusLabel: string; reasonLabel: string } {
  return flow === 'deactivate_token'
    ? { statusRe: DEACTIVATE_OPTION_RE, reasonRe: OTHER_REASON_RE, statusLabel: 'Deactivate', reasonLabel: 'Other' }
    : { statusRe: ACTIVE_OPTION_RE, reasonRe: CSR_REASON_RE, statusLabel: 'Active', reasonLabel: 'Authenticated with CSR' };
}

/** A TokenTarget from the draft card's action_needed.token (agent JSON), or null. */
export function parseTokenTarget(v: unknown): TokenTarget | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  const last4 = str(o.card_last4 ?? o.cardLast4);
  const id = str(o.token_id ?? o.tokenId)?.replace(/\s+/g, '') ?? null;
  const t: TokenTarget = {
    cardLast4: last4 && /^\d{4}$/.test(last4) ? last4 : null,
    device: str(o.device),
    created: str(o.created),
  };
  // Only when the agent sent one (activate_token drafts have none).
  if ((o.token_id ?? o.tokenId) !== undefined) t.tokenId = id && /^\d{12,19}$/.test(id) ? id : null;
  return t;
}

/** A fresh await/activated record for this ticket, or null. */
export function freshRecord(v: unknown, now: number, ticketId?: string): TokenAwait | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.sourceTicketId !== 'string' || typeof o.at !== 'number') return null;
  if (now - o.at > TOKEN_AWAIT_MAX_AGE_MS || o.at > now + 60_000) return null;
  if (ticketId !== undefined && o.sourceTicketId !== ticketId) return null;
  return { sourceTicketId: o.sourceTicketId, at: o.at };
}

/** Fill the Change Status form only after Select, only on Manage Card Tokens (another i2c page
 *  can have its own "New Status" form), and only once the flow's status option is there. */
export function canFillTokenForm(s: { step: string | null; onTokenPage: boolean; hasStatusOption: boolean }): boolean {
  return s.step === 'selected' && s.onTokenPage && s.hasStatusOption;
}

/** The dropdown's current option text matches `re` (e.g. Reason still "Other" after a reload). */
export function selectedOptionMatches(text: string | null | undefined, re: RegExp): boolean {
  return !!text && re.test(norm(text));
}
