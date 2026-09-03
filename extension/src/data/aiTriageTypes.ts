// Shapes for the AI verdict card (Ticket Knowledge Loop Phase 2). Kept in data/ next to
// the other pure ticket types so the prompt builder and the card share one definition.

export type TriageConfidence = 'high' | 'medium' | 'low';

/** One prior resolved ticket, as returned by the bridge's `getRecentLog`. */
export interface RecentLogRow {
  loggedAt: string;
  ticketId: string;
  summary: string;
  originalWorkType: string;
  finalWorkType: string;
  transition: string;
  movedToBoard: string;
  resolutionNote: string;
  toolsUsed: string;
}

/** One chunk of the Notion playbook, mirrored into the `Playbook` sheet tab. */
export interface PlaybookChunk {
  pageId: string;
  pageTitle: string;
  parentPath: string;
  chunkKey: string;
  chunkText: string;
  updatedAt: string;
}

/** One past Done WOCOO ticket offered to the model as precedent (§2b).
 *  `source` is `logged` when Albert's own log supplied a resolution note for this
 *  ticket, and `intake-only` when all we have is the original request text. The card
 *  must not present an intake-only entry as a resolution. */
export interface PrecedentCandidate {
  ticketId: string;
  summary: string;
  description: string;
  source: 'logged' | 'intake-only';
  /** The resolution note when `source === 'logged'`, otherwise the empty string. */
  outcome: string;
}

export interface SimilarTicket {
  ticketId: string;
  whatHappened: string;
  source: 'logged' | 'intake-only';
}

/** The model's answer, after parsing and validation. */
export interface TriageVerdict {
  workType: string;
  confidence: TriageConfidence;
  rationale: string;
  steps: string[];
  similarTickets: SimilarTicket[];
  gotchas: string[];
}

export interface TriagePromptInput {
  ticketId: string;
  summary: string;
  description: string;
  workType: string;
  allowedWorkTypes: string[];
  recentRows: RecentLogRow[];
  playbookChunks: PlaybookChunk[];
  precedent: PrecedentCandidate[];
}
