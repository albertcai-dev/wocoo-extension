// Maps a resolved request to a row in the CC Ops Automation `Requests` sheet.

import type { EligibilityRequest, Resolution } from './eligibilityTypes';

export type LogStatus = 'DRAFTED' | 'READ_EMAIL' | 'NEEDS_REVIEW' | 'NO_MATCH' | 'ALREADY_HAS_ONE_REPLY';

export interface EligibilityLogRow {
  request_message_id: string; thread_id: string; insurer_email: string; client_email: string; status: string;
  last4: string; is_delinquent: string; activation_date: string; card_product: string;
  match_method: string; draft_id: string; notes: string;
}

export function toLogRow(req: EligibilityRequest, res: Resolution, status: LogStatus, draftId: string): EligibilityLogRow {
  const join = (xs: string[]) => xs.join(', ');
  const anyDelinquent = res.cards.some((c) => c.delinquent === true);
  const notes = [
    res.note,
    res.flags.length ? `Flags: ${res.flags.join(', ')}.` : '',
    req.claimNumber ? `Claim ${req.claimNumber}.` : '',
  ].filter(Boolean).join(' ');
  return {
    request_message_id: req.messageId,
    thread_id: req.threadId,
    insurer_email: req.insurerEmail,
    client_email: res.clientEmail ?? '',
    status,
    last4: join(res.cards.map((c) => c.last4)),
    is_delinquent: res.cards.length ? (anyDelinquent ? 'TRUE' : 'FALSE') : '',
    activation_date: join(res.cards.map((c) => c.creationDate)),
    card_product: join(res.cards.map((c) => c.product)),
    match_method: res.method ?? '',
    draft_id: draftId,
    notes,
  };
}
