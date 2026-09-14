// Pure prompt construction + response parsing. No network, no chrome APIs — everything
// here is unit-tested, so prompt iteration costs an HMR reload rather than a GAS deploy.

import type {
  PlaybookChunk,
  PrecedentCandidate,
  RecentLogRow,
  TriageConfidence,
  TriagePromptInput,
  TriageVerdict,
} from '../data/aiTriageTypes';

const SYSTEM = [
  'You are a triage assistant for a Wealthsimple client-experience agent working WOCOO tickets.',
  'You answer only from the prior resolved tickets, their closing comments, and the playbook excerpts you are given.',
  'Never invent a work type that is not in the allowed list.',
  'Never cite a ticket key that does not appear in the PRECEDENT CANDIDATES block.',
  'When the history does not support a confident answer, say so and set confidence to "low".',
  'Reply with a single JSON object and nothing else.',
].join(' ');

const OUTPUT_CONTRACT = `Reply with JSON of exactly this shape:
{
  "work_type": "<one of the allowed work types>",
  "confidence": "high" | "medium" | "low",
  "rationale": "<two sentences at most>",
  "steps": ["<ordered action>", "..."],
  "similar_tickets": [{ "ticket_id": "WOCOO-123", "what_happened": "<one line>", "source": "logged" | "comments" | "intake-only" }],
  "gotchas": ["<one line>", "..."]
}`;

function renderRow(r: RecentLogRow): string {
  const moved = r.movedToBoard ? ` -> ${r.movedToBoard}` : '';
  return [
    `- ${r.ticketId} (${r.loggedAt}) [${r.originalWorkType} -> ${r.finalWorkType}${moved}, ${r.transition}]`,
    `  summary: ${r.summary}`,
    `  resolution: ${r.resolutionNote}`,
    r.toolsUsed ? `  tools: ${r.toolsUsed}` : '',
  ].filter(Boolean).join('\n');
}

function renderCandidate(c: PrecedentCandidate): string {
  return [
    `- ${c.ticketId} [${c.source}]`,
    `  summary: ${c.summary}`,
    c.description ? `  request: ${c.description}` : '',
    c.outcome ? `  outcome: ${c.outcome}` : '  outcome: (not recorded — treat the request text as context, not as a resolution)',
  ].filter(Boolean).join('\n');
}

function renderChunk(c: PlaybookChunk): string {
  return `- [${c.parentPath} / ${c.pageTitle}] ${c.chunkText}`;
}

export function buildTriagePrompt(input: TriagePromptInput): Array<{ role: 'system' | 'user'; content: string }> {
  const rows = input.recentRows.length ? input.recentRows.map(renderRow).join('\n') : '(none)';
  const chunks = input.playbookChunks.length ? input.playbookChunks.map(renderChunk).join('\n') : '(none)';
  const candidates = input.precedent.length ? input.precedent.map(renderCandidate).join('\n') : '(none)';

  const user = [
    '## Current ticket',
    `id: ${input.ticketId}`,
    `current work type: ${input.workType}`,
    `summary: ${input.summary}`,
    `description: ${input.description}`,
    '',
    '## Allowed work types',
    input.allowedWorkTypes.map((w) => `- ${w}`).join('\n') || '(none)',
    '',
    '## Prior resolved tickets',
    rows,
    '',
    '## Playbook excerpts',
    chunks,
    '',
    '## PRECEDENT CANDIDATES',
    'Past Done WOCOO tickets of the same work type. Rank these, keep the best 3-5, and',
    'cite their keys verbatim. Each carries a source tag saying how much you can trust',
    'its outcome:',
    '- marked logged: an agent wrote the resolution down deliberately afterwards. Most',
    '  reliable; prefer these when they conflict with anything else.',
    '- marked comments: the outcome is read from the ticket\'s own closing comments. It is',
    '  evidence of what was done, but a closing comment can also be a handoff, a question',
    '  or an automated notice — read it before relying on it.',
    '- marked intake-only: no recorded outcome at all. Its text is the original request,',
    '  not what was done. Do not present it as a resolution.',
    candidates,
    '',
    '## Output',
    OUTPUT_CONTRACT,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

function asConfidence(v: unknown): TriageConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

/** Strip a ```json fence if the model wrapped its answer in one. */
function unfence(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : raw.trim();
}

export function parseTriageVerdict(
  raw: string,
  allowedTicketIds: string[],
): { ok: true; verdict: TriageVerdict } | { ok: false; error: string } {
  let obj: any;
  try {
    obj = JSON.parse(unfence(raw));
  } catch {
    return { ok: false, error: 'Could not parse the model response as JSON.' };
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Could not parse the model response as JSON.' };
  }
  if (!obj.work_type || typeof obj.work_type !== 'string') {
    return { ok: false, error: 'The model response is missing work_type.' };
  }
  // The model will otherwise emit plausible-looking WOCOO keys that do not exist, so
  // anything outside the candidate set it was handed is dropped rather than rendered.
  const allowed = new Set(allowedTicketIds);
  const similar = Array.isArray(obj.similar_tickets)
    ? obj.similar_tickets
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any) => ({
          ticketId: String(s.ticket_id ?? ''),
          whatHappened: String(s.what_happened ?? ''),
          source: s.source === 'logged' ? ('logged' as const) : ('intake-only' as const),
        }))
        .filter((s: { ticketId: string }) => s.ticketId && allowed.has(s.ticketId))
    : [];

  return {
    ok: true,
    verdict: {
      workType: obj.work_type,
      confidence: asConfidence(obj.confidence),
      rationale: String(obj.rationale ?? ''),
      steps: asStringArray(obj.steps),
      similarTickets: similar,
      gotchas: asStringArray(obj.gotchas),
    },
  };
}
