// Prefill for the Create REIMB modal: pulls the amount and reason out of the Sidekick
// Agent's free-text note, and shortens the WOCOO summary into a REIMB title.

import { REIMBURSEMENT_REASON_LABELS } from './reimbConfig';

export interface ReimbNotePrefill {
  amount?: number;
  reason?: (typeof REIMBURSEMENT_REASON_LABELS)[number];
}

const MONEY = String.raw`(?:CA)?\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

function toNumber(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

/**
 * The note often names several dollar figures (the purchase and the payout), so the
 * payout is picked by phrasing: "= $9.31" first, then "reimburse ... $X" / "for $X".
 * A note with a single dollar figure uses it. Anything else is left for the user.
 */
export function parseReimbAgentNote(note: string | undefined): ReimbNotePrefill {
  if (!note) return {};
  const out: ReimbNotePrefill = {};

  const cued =
    note.match(new RegExp(String.raw`=\s*` + MONEY, 'i')) ||
    note.match(new RegExp(String.raw`reimburse\w*\b[^$.]{0,40}?` + MONEY, 'i')) ||
    note.match(new RegExp(String.raw`\bfor\s+` + MONEY, 'i'));
  if (cued) {
    out.amount = toNumber(cued[1]);
  } else {
    const all = [...note.matchAll(new RegExp(MONEY, 'gi'))];
    if (all.length === 1) out.amount = toNumber(all[0][1]);
  }

  const lower = note.toLowerCase();
  const reason = REIMBURSEMENT_REASON_LABELS.find((l) => lower.includes(l.toLowerCase()));
  if (reason) out.reason = reason;

  return out;
}

/** "Missing cashback — settled $465.41 purchase coded MCC 5094" → "Missing cashback". */
export function conciseReimbSummary(summary: string | undefined): string {
  const s = (summary || '').trim();
  const head = s.split(/\s+[—–-]\s+|:\s+|\s*\|\s*/)[0].trim();
  return head || s;
}
