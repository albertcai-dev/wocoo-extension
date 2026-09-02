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

export interface SimilarTicket {
  ticketId: string;
  whatHappened: string;
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
}
