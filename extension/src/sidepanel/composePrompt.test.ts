import { describe, it, expect } from 'vitest';
import { buildTriagePrompt, parseTriageVerdict } from './composePrompt';
import type { RecentLogRow, PlaybookChunk } from '../data/aiTriageTypes';

const row: RecentLogRow = {
  loggedAt: '2026-08-01T10:00:00Z',
  ticketId: 'WOCOO-100',
  summary: 'Duplicate payment posted twice',
  originalWorkType: 'Overpayment',
  finalWorkType: 'Overpayment',
  transition: 'Done',
  movedToBoard: '',
  resolutionNote: 'Refunded via CRED, client confirmed.',
  toolsUsed: 'Atlas, Ledge',
};

const chunk: PlaybookChunk = {
  pageId: 'p1',
  pageTitle: 'Overpayment',
  parentPath: 'Work types',
  chunkKey: 'p1#steps',
  chunkText: 'Check Ledge for the duplicate before refunding.',
  updatedAt: '2026-08-01T00:00:00Z',
};

describe('buildTriagePrompt', () => {
  it('puts ticket, log rows and playbook chunks in the user message', () => {
    const msgs = buildTriagePrompt({
      ticketId: 'WOCOO-222',
      summary: 'Client charged twice',
      description: 'Two identical charges on the same day.',
      workType: 'Overpayment',
      allowedWorkTypes: ['Overpayment', 'Reverse Fee'],
      recentRows: [row],
      playbookChunks: [chunk],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    const user = msgs[1].content;
    expect(user).toContain('WOCOO-222');
    expect(user).toContain('Refunded via CRED, client confirmed.');
    expect(user).toContain('Check Ledge for the duplicate before refunding.');
  });

  it('lists the allowed work types so the model cannot invent one', () => {
    const msgs = buildTriagePrompt({
      ticketId: 'WOCOO-222',
      summary: 's',
      description: 'd',
      workType: 'Overpayment',
      allowedWorkTypes: ['Overpayment', 'Reverse Fee'],
      recentRows: [],
      playbookChunks: [],
    });
    expect(msgs[1].content).toContain('Reverse Fee');
  });

  it('says so explicitly when there is no prior history', () => {
    const msgs = buildTriagePrompt({
      ticketId: 'WOCOO-222',
      summary: 's',
      description: 'd',
      workType: 'Overpayment',
      allowedWorkTypes: ['Overpayment'],
      recentRows: [],
      playbookChunks: [],
    });
    expect(msgs[1].content).toContain('(none)');
  });
});

describe('parseTriageVerdict', () => {
  it('parses a well-formed verdict', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Overpayment',
      confidence: 'high',
      rationale: 'Matches two prior tickets.',
      steps: ['Check Ledge', 'Refund via CRED'],
      similar_tickets: [{ ticket_id: 'WOCOO-100', what_happened: 'Refunded via CRED.' }],
      gotchas: ['Confirm the second charge settled.'],
    }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.workType).toBe('Overpayment');
      expect(res.verdict.confidence).toBe('high');
      expect(res.verdict.steps).toEqual(['Check Ledge', 'Refund via CRED']);
      expect(res.verdict.similarTickets[0].ticketId).toBe('WOCOO-100');
    }
  });

  it('returns an error instead of throwing on malformed JSON', () => {
    const res = parseTriageVerdict('not json at all');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/parse/i);
  });

  it('returns an error when work_type is missing', () => {
    const res = parseTriageVerdict(JSON.stringify({ confidence: 'high' }));
    expect(res.ok).toBe(false);
  });

  it('falls back to low confidence when the value is not a known level', () => {
    const res = parseTriageVerdict(JSON.stringify({ work_type: 'Overpayment', confidence: 'certain' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict.confidence).toBe('low');
  });

  it('tolerates a fenced code block around the JSON', () => {
    const res = parseTriageVerdict('```json\n{"work_type":"Overpayment"}\n```');
    expect(res.ok).toBe(true);
  });
});
