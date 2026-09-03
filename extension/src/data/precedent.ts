// Pure precedent logic for the AI verdict card (spec §2b). Retrieval is deterministic:
// work type plus recency, no keyword guessing and no LLM-authored JQL. The model only
// ranks and summarises the candidates this module shapes.
//
// WOCOO's "work type" IS `issuetype.name` — there is no separate custom field to query.

import type { PrecedentCandidate, RecentLogRow } from './aiTriageTypes';

/** Candidate cap. Enough history to rank against without blowing the prompt budget. */
export const PRECEDENT_MAX_RESULTS = 40;

/** The subset of a Jira `TicketRow` this module needs, so the pure code stays free of
 *  the wider row type and its network origin. */
export interface PrecedentRowInput {
  id: string;
  summary: string;
  description?: string;
}

export function buildPrecedentJql(workType: string, excludeKey: string): string {
  const escaped = workType.replace(/"/g, '\\"');
  const parts = [
    'project = WOCOO',
    'statusCategory = Done',
    `issuetype = "${escaped}"`,
  ];
  if (excludeKey) parts.push(`key != ${excludeKey}`);
  return `${parts.join(' AND ')} ORDER BY created DESC`;
}

export function joinPrecedentOutcomes(
  rows: PrecedentRowInput[],
  logRows: RecentLogRow[],
): PrecedentCandidate[] {
  // getRecentLog already returns only rows with a non-empty resolution note for the
  // matching work type, so this index is exactly the join population. The trim guard
  // covers a whitespace-only cell slipping through the sheet-side filter.
  const outcomeById = new Map<string, string>();
  for (const r of logRows) {
    const note = (r.resolutionNote || '').trim();
    if (r.ticketId && note) outcomeById.set(r.ticketId, note);
  }

  return rows.map((row) => {
    const outcome = outcomeById.get(row.id) || '';
    return {
      ticketId: row.id,
      summary: row.summary,
      description: row.description || '',
      source: outcome ? ('logged' as const) : ('intake-only' as const),
      outcome,
    };
  });
}
