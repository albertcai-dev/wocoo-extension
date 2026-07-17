// Types for the Phase 1 ticket log — payload shapes shared between the sidepanel
// (which emits transitions) and the Apps Script bridge (which writes rows).

export type TicketTransitionKind = 'Done' | 'Cancelled' | 'Moved';

export interface TicketLogPayload {
  ticketId: string;
  ticketLink: string;
  summary: string;
  descriptionSnippet: string; // first ~500 chars, trimmed by caller
  originalWorkType: string;
  finalWorkType: string; // blank if unchanged
  transition: TicketTransitionKind;
  movedToBoard: string; // blank unless transition === 'Moved'
  timeOnTicketMinutes: number; // 0 if unknown
}

export interface TicketLogUpdatePayload {
  rowNumber: number;
  resolutionNote: string;
  toolsUsed: string;
  mistriaged: boolean;
  novelPattern: boolean;
  novelNote: string;
}
