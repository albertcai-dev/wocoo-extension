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
  /** Closing comments from Jira, oldest first. Absent when the caller did not ask for
   *  the `comment` field. */
  comments?: string[];
}

/** Comments kept per candidate. The resolution is nearly always the final comment, and
 *  the one before it supplies the reasoning; taking more multiplies prompt size across
 *  40 candidates for text that mostly restates the conclusion. */
export const MAX_CANDIDATE_COMMENTS = 2;

/** Per-comment character cap. Stops one rambling thread from crowding out 39 other
 *  candidates. */
export const COMMENT_CHAR_CAP = 600;

/** Flatten a candidate's comments into an outcome string: drop blanks, keep the last
 *  MAX_CANDIDATE_COMMENTS in chronological order, truncate each. */
export function outcomeFromComments(comments: string[] | undefined): string {
  const kept = (comments || [])
    .map((c) => (c || '').trim())
    .filter(Boolean)
    .slice(-MAX_CANDIDATE_COMMENTS)
    .map((c) => (c.length > COMMENT_CHAR_CAP ? c.slice(0, COMMENT_CHAR_CAP) + '…' : c));
  return kept.join('\n');
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
    // A hand-written note wins over a closing comment: it was written deliberately,
    // after the fact, to describe the resolution. A closing comment was written in the
    // moment and may be a handoff, a question, or an automated notice.
    const note = outcomeById.get(row.id) || '';
    if (note) {
      return {
        ticketId: row.id,
        summary: row.summary,
        description: row.description || '',
        source: 'logged' as const,
        outcome: note,
      };
    }
    const fromComments = outcomeFromComments(row.comments);
    return {
      ticketId: row.id,
      summary: row.summary,
      description: row.description || '',
      source: fromComments ? ('comments' as const) : ('intake-only' as const),
      outcome: fromComments,
    };
  });
}
