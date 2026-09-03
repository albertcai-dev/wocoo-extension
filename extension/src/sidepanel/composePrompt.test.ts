import { describe, it, expect } from 'vitest';
import { buildTriagePrompt, parseTriageVerdict } from './composePrompt';
import type { RecentLogRow, PlaybookChunk, PrecedentCandidate } from '../data/aiTriageTypes';

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

const candidate: PrecedentCandidate = {
  ticketId: 'WOCOO-24990',
  summary: 'Interest charged after paying at 11:35 PM',
  description: 'Client made final payment at 11:35 PM on July 6; due date July 6.',
  source: 'logged',
  outcome: 'Reversed as a one-time exception.',
};

const intakeOnly: PrecedentCandidate = {
  ticketId: 'WOCOO-24715',
  summary: 'Interest Charge',
  description: 'Client paid June 26th 11:37 pm PST.',
  source: 'intake-only',
  outcome: '',
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
      precedent: [],
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
      precedent: [],
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
      precedent: [],
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
    }), ['WOCOO-100']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.workType).toBe('Overpayment');
      expect(res.verdict.confidence).toBe('high');
      expect(res.verdict.steps).toEqual(['Check Ledge', 'Refund via CRED']);
      expect(res.verdict.similarTickets[0].ticketId).toBe('WOCOO-100');
    }
  });

  it('returns an error instead of throwing on malformed JSON', () => {
    const res = parseTriageVerdict('not json at all', []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/parse/i);
  });

  it('returns an error when work_type is missing', () => {
    const res = parseTriageVerdict(JSON.stringify({ confidence: 'high' }), []);
    expect(res.ok).toBe(false);
  });

  it('falls back to low confidence when the value is not a known level', () => {
    const res = parseTriageVerdict(JSON.stringify({ work_type: 'Overpayment', confidence: 'certain' }), []);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict.confidence).toBe('low');
  });

  it('tolerates a fenced code block around the JSON', () => {
    const res = parseTriageVerdict('```json\n{"work_type":"Overpayment"}\n```', []);
    expect(res.ok).toBe(true);
  });
});

describe('buildTriagePrompt precedent block', () => {
  const base = {
    ticketId: 'WOCOO-222',
    summary: 'Client charged interest after a late-night payment',
    description: 'Paid at 11:40 PM on the due date.',
    workType: 'Credit Card: Statements',
    allowedWorkTypes: ['Credit Card: Statements'],
    recentRows: [] as RecentLogRow[],
    playbookChunks: [] as PlaybookChunk[],
  };

  it('renders each candidate with its key, summary, description and outcome', () => {
    const user = buildTriagePrompt({ ...base, precedent: [candidate] })[1].content;
    expect(user).toContain('PRECEDENT CANDIDATES');
    expect(user).toContain('WOCOO-24990');
    expect(user).toContain('Interest charged after paying at 11:35 PM');
    expect(user).toContain('Client made final payment at 11:35 PM on July 6');
    expect(user).toContain('Reversed as a one-time exception.');
  });

  it('labels a candidate with no resolution note as intake-only', () => {
    const user = buildTriagePrompt({ ...base, precedent: [intakeOnly] })[1].content;
    expect(user).toContain('intake-only');
    expect(user).not.toContain('outcome: \n');
  });

  it('renders (none) when there are no candidates', () => {
    const user = buildTriagePrompt({ ...base, precedent: [] })[1].content;
    expect(user).toContain('PRECEDENT CANDIDATES');
    expect(user).toContain('(none)');
  });

  it('renders all 40 candidates when the cap is full', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...candidate, ticketId: `WOCOO-${1000 + i}` }));
    const user = buildTriagePrompt({ ...base, precedent: many })[1].content;
    expect(user).toContain('WOCOO-1000');
    expect(user).toContain('WOCOO-1039');
  });

  it('forbids citing a key outside the candidate block', () => {
    const system = buildTriagePrompt({ ...base, precedent: [candidate] })[0].content;
    expect(system.toLowerCase()).toContain('candidate');
  });
});

describe('parseTriageVerdict candidate-set validation', () => {
  it('keeps a cited key that is in the candidate set and carries its source', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Credit Card: Statements',
      confidence: 'high',
      similar_tickets: [{ ticket_id: 'WOCOO-24990', what_happened: 'Reversed once.', source: 'logged' }],
    }), ['WOCOO-24990']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets).toEqual([
      { ticketId: 'WOCOO-24990', whatHappened: 'Reversed once.', source: 'logged' },
    ]);
  });

  it('drops a cited key that is not in the candidate set', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Credit Card: Statements',
      similar_tickets: [
        { ticket_id: 'WOCOO-24990', what_happened: 'Real.', source: 'logged' },
        { ticket_id: 'WOCOO-99999', what_happened: 'Invented.', source: 'logged' },
      ],
    }), ['WOCOO-24990']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets.map((s) => s.ticketId)).toEqual(['WOCOO-24990']);
  });

  it('defaults an unrecognised source to intake-only', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Overpayment',
      similar_tickets: [{ ticket_id: 'WOCOO-100', what_happened: 'x', source: 'guessed' }],
    }), ['WOCOO-100']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets[0].source).toBe('intake-only');
  });

  it('accepts an empty similar_tickets array', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Overpayment', similar_tickets: [],
    }), ['WOCOO-100']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets).toEqual([]);
  });
});
