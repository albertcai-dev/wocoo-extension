// "Activate token" i2c chain: the Sidekick Agent spots an InActive wallet token, and its draft
// card's button runs the usual login → customer chain, opens Manage Card Tokens, clicks Select
// on that token's row and fills Status = Active, Reason = Authenticated with CSR, Comments = the
// Jira ticket link. The user clicks Update Status; that click ticks the card's "I've done this".
//
// Pure helpers live here so they're testable; content/i2c.ts owns the DOM.

/** Which token to activate, as the agent read it on Manage Card Tokens. */
export interface TokenTarget {
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

/** A TokenTarget from the draft card's action_needed.token (agent JSON), or null. */
export function parseTokenTarget(v: unknown): TokenTarget | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  const last4 = str(o.card_last4 ?? o.cardLast4);
  const t: TokenTarget = {
    cardLast4: last4 && /^\d{4}$/.test(last4) ? last4 : null,
    device: str(o.device),
    created: str(o.created),
  };
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
