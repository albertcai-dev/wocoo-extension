// Types for drafts written by the local draft agent. These mirror the agent's draft
// schema (schema version 1) field for field; the agent's store validates drafts before
// they are written, so the extension treats them as already well-formed.

import type { CommentSegment } from '../api/jira';

/** A comment segment as the agent writes it. A mention's `text` is "@Display Name" and its
 *  `accountId` is usually absent: Sidekick resolves the name to an accountId when posting. */
export type DraftSegment = CommentSegment;

export type DraftOutcome = 'draft' | 'move' | 'no_new_angle' | 'needs_info';
export type DraftKind = 'new' | 'followup';

export type DraftFlag =
  | 'thin_precedent'
  | 'docs_silent'
  | 'guide_vs_precedent'
  | 'cxo_differs'
  | 'no_new_angle'
  | 'compass_no_reply'
  | 'i2c_deferred'
  | 'amount_mismatch';

export type DraftMoveDestination =
  | 'EOC' | 'DBO' | 'CRED' | 'FRAUD' | 'PRR' | 'PFO' | 'BOPSFUND' | 'WORS' | 'BOTI';

export type DraftEvidenceKind = 'ticket' | 'i2c' | 'koho' | 'precedent' | 'doc' | 'cxo' | 'compass';

export type DraftWorkflow = 'reverse_fee' | 'reverse_interest_fee' | 'overpayment';

export interface DraftEvidence {
  kind: DraftEvidenceKind;
  label: string;
  detail: string;
  url?: string | null;
}

export interface DraftMove {
  destination: DraftMoveDestination;
  issue_type: string;
  fields?: Record<string, unknown>;
  reason: string;
  /** The comment Sidekick posts with the move, in the user's voice. */
  comment?: string | null;
  sidekick_supported: boolean;
}

export interface DraftActionNeeded {
  summary: string;
  workflow?: DraftWorkflow | null;
}

export interface AgentDraft {
  schema: 1;
  ticket: string;
  kind: DraftKind;
  outcome: DraftOutcome;
  /** ISO-8601 timestamps. */
  created_at: string;
  ticket_updated: string;
  last_comment_id: string | null;
  work_type: string;
  summary: string;
  segments: DraftSegment[];
  /** Target status name (e.g. "Done"), not a transition name; null leaves the status alone. */
  suggested_status: string | null;
  move: DraftMove | null;
  action_needed: DraftActionNeeded | null;
  evidence: DraftEvidence[];
  flags: DraftFlag[];
  compass_thread: string | null;
}

/** One row of the store's ready list. */
export interface ReadyDraftRow {
  key: string;
  summary: string;
  /** Digest marker: tool needed, flagged, followup, or empty. */
  marker: string;
  kind: DraftKind;
  outcome: DraftOutcome;
  url: string;
  created_at: string;
  assigned_at: number | null;
}

/** What Sidekick records when a draft is posted or discarded. The store adds `classification`. */
export interface DraftOutcomeRow {
  key: string;
  work_type: string;
  draft_created_at: string;
  recorded_at: string;
  via: 'sidekick' | 'jira';
  draft_text: string;
  posted_text: string | null;
  suggested_status: string | null;
  actual_status: string | null;
  flags: DraftFlag[];
  assigned_at: string | null;
}
