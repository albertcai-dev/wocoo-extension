// Live status of the local draft agent (the native host's `agent_status` reply), and the pure
// view model the Settings progress card renders from it.

export type StepId = 'read' | 'preset' | 'lookup' | 'precedent' | 'compass' | 'write';
export type RowState = 'done' | 'now' | 'skipped' | 'todo';
export type QueueTag = 'solve' | 'compass' | 'reply';

/** Checklist rows in table order. */
export const STEP_ROWS: { id: StepId; label: string }[] = [
  { id: 'read', label: 'Read ticket & client email' },
  { id: 'preset', label: 'Checking Preset' },
  { id: 'lookup', label: 'i2c / KOHO lookup' },
  { id: 'precedent', label: 'Precedent & guides' },
  { id: 'compass', label: 'Ask Compass' },
  { id: 'write', label: 'Write draft' },
];

const STEP_IDS = new Set<string>(STEP_ROWS.map((r) => r.id));
const QUEUE_TAGS = new Set<string>(['solve', 'compass', 'reply']);
const DEFAULT_MAX_ATTEMPTS = 3;
const SLOW_FACTOR = 3;
const SLOW_CUTOFF_S = 300;

const SYSTEM_LABELS: Record<string, string> = {
  i2c_credit: 'i2c credit',
  i2c_prepaid: 'i2c prepaid',
  koho: 'KOHO prepaid',
  atlas: 'Atlas',
};

/** Display tag for a jev route system; null for none, missing or unknown. */
export function systemLabel(system: string | null): string | null {
  if (system === null) return null;
  return Object.prototype.hasOwnProperty.call(SYSTEM_LABELS, system) ? SYSTEM_LABELS[system] : null;
}

/** All times are epoch seconds. */
export interface AgentStatus {
  mode: 'running' | 'paused';
  since: number | null;
  solo: string | null;
  tick: {
    phase: string | null;
    at: number | null;
    pollFailures: number;
    nextCheckAt: number | null;
    stale: boolean;
  };
  current: null | {
    key: string;
    summary: string;
    system: string | null;
    kind: string | null;
    resumeReason: string | null;
    stage: string | null;
    begunAt: number | null;
    attempts: number;
    maxAttempts: number;
    steps: { step: StepId; at: number }[];
    deadlineAt: number | null;
  };
  /** Sorted soonest timeout first, as the agent sends it. */
  waiting: { key: string; summary: string; askedAt: number | null; timeoutAt: number | null }[];
  queue: { key: string; summary: string; tag: QueueTag | null }[];
  typicalS: number | null;
  lastDrafted: { key: string; at: number | null } | null;
  draftedToday: number;
}

export type CardView = {
  header: 'running' | 'paused';
  /** Key, when paused with a current ticket. */
  finishing: string | null;
  /** Key, when Up next is replaced by a solo run. */
  solo: string | null;
  current: null | {
    key: string;
    summary: string;
    /** Display label (see systemLabel). */
    system: string | null;
    elapsedS: number;
    typicalS: number | null;
    /** The current attempt number; null on a first attempt. */
    attempt: number | null;
    maxAttempts: number;
    rows: { id: StepId; label: string; state: RowState; seconds: number | null }[];
    /** done / (6 - skipped), 0..100. */
    barPct: number;
    /** cutoffMin is null when the session has no deadline. */
    slow: null | { stepMin: number; cutoffMin: number | null; attempt: number; maxAttempts: number };
  };
  /** The "nothing being worked" line. */
  idleLine: null | { tone: 'neutral' | 'warning' | 'negative'; text: string; aside: string | null };
  waiting: { key: string; summary: string; minutesLeft: number; askedMinAgo: number }[];
  queue: { key: string; summary: string; tag: QueueTag | null }[];
  queueLabel: 'Up next' | 'Queued';
  emptyFooter: null | { lastKey: string | null; lastAt: number | null; draftedToday: number };
};

// ---- normalising ----

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function key(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj).filter((e): e is Obj => e !== null) : [];
}

function normaliseCurrent(v: unknown): AgentStatus['current'] {
  const c = obj(v);
  const k = c && key(c.key);
  if (!c || !k) return null;
  const steps: { step: StepId; at: number }[] = [];
  for (const e of list(c.steps)) {
    const at = num(e.at);
    if (typeof e.step === 'string' && STEP_IDS.has(e.step) && at !== null) steps.push({ step: e.step as StepId, at });
  }
  const maxAttempts = num(c.max_attempts);
  return {
    key: k,
    summary: str(c.summary) ?? '',
    system: str(c.system),
    kind: str(c.kind),
    resumeReason: str(c.resume_reason),
    stage: str(c.stage),
    begunAt: num(c.begun_at),
    attempts: num(c.attempts) ?? 0,
    maxAttempts: maxAttempts !== null && maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_ATTEMPTS,
    steps,
    deadlineAt: num(c.deadline_at),
  };
}

/** Turns a host reply into a status. Never throws: bad fields become null or empty, and an
 *  unexpected mode counts as paused, so junk never makes the card claim the agent is working. */
export function normaliseAgentStatus(reply: unknown): AgentStatus {
  const r = obj(reply) ?? {};
  const t = obj(r.tick) ?? {};
  const last = obj(r.last_drafted);
  const lastKey = last && key(last.key);
  const waiting: AgentStatus['waiting'] = [];
  for (const e of list(r.waiting)) {
    const k = key(e.key);
    if (k) waiting.push({ key: k, summary: str(e.summary) ?? '', askedAt: num(e.asked_at), timeoutAt: num(e.timeout_at) });
  }
  const queue: AgentStatus['queue'] = [];
  for (const e of list(r.queue)) {
    const k = key(e.key);
    const tag = typeof e.tag === 'string' && QUEUE_TAGS.has(e.tag) ? (e.tag as QueueTag) : null;
    if (k) queue.push({ key: k, summary: str(e.summary) ?? '', tag });
  }
  return {
    mode: r.mode === 'running' ? 'running' : 'paused',
    since: num(r.since),
    solo: key(r.solo),
    tick: {
      phase: str(t.phase),
      at: num(t.at),
      pollFailures: num(t.poll_failures) ?? 0,
      nextCheckAt: num(t.next_check_at),
      stale: t.stale === true,
    },
    current: normaliseCurrent(r.current),
    waiting,
    queue,
    typicalS: num(r.typical_s),
    lastDrafted: lastKey ? { key: lastKey, at: num(last.at) } : null,
    draftedToday: num(r.drafted_today) ?? 0,
  };
}

// ---- view model ----

/** Whole minutes, rounded up, at least 1. */
function minutesUp(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

type Cur = NonNullable<AgentStatus['current']>;
type Row = NonNullable<CardView['current']>['rows'][number];

function buildRows(c: Cur, now: number): Row[] {
  const steps = c.steps;
  const last = steps.length > 0 ? steps[steps.length - 1] : null;

  if (c.resumeReason !== null && c.resumeReason.startsWith('compass_')) {
    // Gathering and the Compass question happened before the agent parked the ticket; only the
    // write step is live on a resume.
    const writes = steps.filter((s) => s.step === 'write');
    const writeNow = writes.length > 0 || (steps.length === 0 && c.stage === 'write');
    return STEP_ROWS.map(({ id, label }) => {
      if (id !== 'write') return { id, label, state: 'done', seconds: null };
      if (!writeNow) return { id, label, state: 'todo', seconds: null };
      const since = writes.length > 0 ? writes[writes.length - 1].at : null;
      return { id, label, state: 'now', seconds: since === null ? null : Math.max(0, now - since) };
    });
  }

  const firstIdx = new Map<StepId, number>();
  steps.forEach((s, i) => {
    if (!firstIdx.has(s.step)) firstIdx.set(s.step, i);
  });
  const reachedOrder = STEP_ROWS.map((r) => firstIdx.has(r.id));
  return STEP_ROWS.map(({ id, label }, order) => {
    if (last && id === last.step) return { id, label, state: 'now', seconds: Math.max(0, now - last.at) };
    const i = firstIdx.get(id);
    if (i !== undefined) {
      const end = steps[i + 1].at; // i is never the last entry: that one is the now row
      return { id, label, state: 'done', seconds: Math.max(0, end - steps[i].at) };
    }
    const laterReached = reachedOrder.slice(order + 1).some(Boolean);
    return { id, label, state: laterReached ? 'skipped' : 'todo', seconds: null };
  });
}

function buildCurrent(c: Cur, s: AgentStatus, now: number): NonNullable<CardView['current']> {
  const rows = buildRows(c, now);
  const done = rows.filter((r) => r.state === 'done').length;
  const skipped = rows.filter((r) => r.state === 'skipped').length;
  const denom = STEP_ROWS.length - skipped;
  const barPct = denom > 0 ? Math.round((done / denom) * 100) : 0;

  const elapsedS = c.begunAt === null ? 0 : Math.max(0, now - c.begunAt);
  const overTypical = s.typicalS !== null && elapsedS > SLOW_FACTOR * s.typicalS;
  const nearCutoff = c.deadlineAt !== null && c.deadlineAt - now < SLOW_CUTOFF_S;
  let slow: NonNullable<CardView['current']>['slow'] = null;
  if (overTypical || nearCutoff) {
    const stepStart = c.steps.length > 0 ? c.steps[c.steps.length - 1].at : c.begunAt;
    slow = {
      stepMin: minutesUp(stepStart === null ? 0 : now - stepStart),
      cutoffMin: c.deadlineAt === null ? null : Math.max(0, Math.ceil((c.deadlineAt - now) / 60)),
      attempt: c.attempts + 1,
      maxAttempts: c.maxAttempts,
    };
  }

  return {
    key: c.key,
    summary: c.summary,
    system: systemLabel(c.system),
    elapsedS,
    typicalS: s.typicalS,
    attempt: c.attempts > 0 ? c.attempts + 1 : null,
    maxAttempts: c.maxAttempts,
    rows,
    barPct,
    slow,
  };
}

function buildIdle(s: AgentStatus, now: number): Pick<CardView, 'idleLine' | 'emptyFooter'> {
  const { tick } = s;
  const next = tick.nextCheckAt === null ? null : minutesUp(tick.nextCheckAt - now);
  const line = (tone: 'neutral' | 'warning' | 'negative', text: string, aside: string | null = null) => ({
    idleLine: { tone, text, aside },
    emptyFooter: null,
  });

  if (tick.stale) {
    return line('negative', `Agent hasn't checked in for ${minutesUp(tick.at === null ? 0 : now - tick.at)} min`);
  }
  if (tick.phase === 'poll_failed') {
    const base = 'Check failed · VPN or MCPLocker may be down';
    return line('negative', next === null ? base : `${base} · retrying in ${next}m`);
  }
  if (tick.phase === 'polling') return line('neutral', 'Checking for new tickets');
  if (tick.phase === 'deferred_foreign_pw') return line('warning', 'Waiting for your browser session to close');
  if (s.queue.length === 0) {
    return {
      idleLine: { tone: 'neutral', text: 'Queue empty', aside: next === null ? null : `checks again in ${next}m` },
      emptyFooter: { lastKey: s.lastDrafted?.key ?? null, lastAt: s.lastDrafted?.at ?? null, draftedToday: s.draftedToday },
    };
  }
  return line('neutral', next === null ? 'Between checks' : `Between checks · next check in ${next}m`);
}

/** The progress card's view of a status at `now` (epoch seconds). Pure. */
export function agentCardView(s: AgentStatus, now: number): CardView {
  const running = s.mode === 'running';
  const solo = running ? s.solo : null;
  const idle = running && s.current === null ? buildIdle(s, now) : { idleLine: null, emptyFooter: null };
  return {
    header: s.mode,
    finishing: !running && s.current !== null ? s.current.key : null,
    solo,
    current: s.current === null ? null : buildCurrent(s.current, s, now),
    ...idle,
    waiting: s.waiting.map((w) => ({
      key: w.key,
      summary: w.summary,
      minutesLeft: w.timeoutAt === null ? 0 : Math.max(0, Math.ceil((w.timeoutAt - now) / 60)),
      askedMinAgo: w.askedAt === null ? 0 : Math.max(0, Math.floor((now - w.askedAt) / 60)),
    })),
    queue: solo !== null ? [] : s.queue.map((q) => ({ ...q })),
    queueLabel: running ? 'Up next' : 'Queued',
  };
}
