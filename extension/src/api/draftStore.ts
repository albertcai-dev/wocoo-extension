// Client for the local draft agent's store, reached through the native messaging host
// (native-host/wocoo_launcher.py), which shells out to the agent's store CLI.

import type { AgentDraft, DraftOutcomeRow, ReadyDraftRow } from '../data/agentDraftTypes';
import { normaliseAgentMode, type AgentMode, type AgentModeState } from '../data/agentMode';

export type { AgentMode };

const NATIVE_HOST = 'com.wealthsimple.wocoo_launcher';

/** The host is not installed or registered for this extension, or the store CLI failed. */
export class DraftStoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftStoreUnavailable';
  }
}

/** Errors meaning this machine has no draft agent set up: the native host isn't installed
 *  ("…host not found"), the host can't find the agent's store CLI ("Not found: …store_cli.py"),
 *  or an older launcher predates the draft actions ("Unknown action: 'draft_…'"). Teammates
 *  sharing the extension without the agent hit these on every ticket. */
const NOT_SET_UP = [
  /native messaging host not found/i,
  /^host not found/i,
  /^Not found: .*store_cli\.py$/i,
  /^Unknown action: '?(draft_|lesson_|i2c_activity|agent_mode_|agent_solve|agent_item|agent_team)/i,
];

/** True when the draft store failed only because it isn't set up here, so the UI should render
 *  nothing. Other failures (e.g. "Access … forbidden" from stale allowed_origins, a store CLI
 *  error or timeout) are real problems worth a one-line message. */
export function isDraftStoreNotSetUp(err: unknown): boolean {
  if (!(err instanceof DraftStoreUnavailable)) return false;
  return NOT_SET_UP.some((re) => re.test(err.message.trim()));
}

interface HostReply {
  ok?: boolean;
  error?: string;
  draft?: AgentDraft | null;
  items?: ReadyDraftRow[];
  mode?: unknown;
  since?: unknown;
}

function sendNative(message: object): Promise<HostReply | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message ?? 'Native host unavailable')); return; }
      resolve(response as HostReply | undefined);
    });
  });
}

async function call(message: object): Promise<HostReply> {
  let reply: HostReply | undefined;
  try {
    reply = await sendNative(message);
  } catch (e) {
    throw new DraftStoreUnavailable(e instanceof Error ? e.message : String(e));
  }
  if (!reply?.ok) throw new DraftStoreUnavailable(reply?.error || 'The draft store did not respond.');
  return reply;
}

/** The current draft for a ticket, or null when the agent has none to offer. */
export async function getDraft(key: string): Promise<AgentDraft | null> {
  const reply = await call({ action: 'draft_get', key });
  return reply.draft ?? null;
}

/** Drafts that are ready for review, oldest first. */
export async function listReadyDrafts(): Promise<ReadyDraftRow[]> {
  const reply = await call({ action: 'draft_list' });
  return reply.items ?? [];
}

/** Records how a draft was used. The store classifies it (posted as-is, edited, discarded...). */
export async function recordOutcome(row: DraftOutcomeRow): Promise<void> {
  await call({ action: 'draft_outcome', row });
}

/** Tells the agent the user is active in i2c, so it holds off its own i2c lookups. `ts` is epoch seconds. */
export async function reportI2cActivity(ts: number): Promise<void> {
  await call({ action: 'i2c_activity', ts });
}

/** Whether the agent is running or paused, and when that last changed (epoch seconds). */
export async function getAgentMode(): Promise<AgentModeState> {
  return normaliseAgentMode(await call({ action: 'agent_mode_get' }));
}

/** Runs or pauses the agent. A paused agent does no drafting and never touches the user's i2c session. */
export async function setAgentMode(mode: AgentMode): Promise<AgentModeState> {
  return normaliseAgentMode(await call({ action: 'agent_mode_set', mode }));
}

/** Where a ticket stands with the agent (for the Solve button). */
export interface AgentItemState {
  state: string | null;
  /** The agent is running for this ticket only (a Solve press switched it on). */
  solo: boolean;
  /** Pressed Solve and not finished yet. */
  priority: boolean;
}

/** "Solve using Sidekick Agent": draft this ticket now. `solo` = the agent was paused and now
 *  runs for this ticket only, pausing itself when it is solved. */
export async function solveTicket(key: string): Promise<{ state: string | null; solo: boolean }> {
  const reply = await call({ action: 'agent_solve', key }) as HostReply & { state?: unknown; solo?: unknown };
  return { state: typeof reply.state === 'string' ? reply.state : null, solo: reply.solo === true };
}

export async function getAgentItem(key: string): Promise<AgentItemState> {
  const reply = await call({ action: 'agent_item', key }) as HostReply & { state?: unknown; solo?: unknown; priority?: unknown };
  return { state: typeof reply.state === 'string' ? reply.state : null, solo: reply.solo === true, priority: reply.priority === true };
}

/** A lesson from the post-edit note, as the user judged it. */
export interface LessonVerdict {
  text: string;
  status: 'kept' | 'wrong';
  work_type?: string | null;
  category?: string;
  source_key?: string;
}

/** Saves the user's Keep / Wrong on a proposed lesson. Kept lessons steer future drafts. */
export async function saveLesson(lesson: LessonVerdict): Promise<void> {
  await call({ action: 'lesson_add', lesson });
}

let teamCache: Promise<Set<string>> | null = null;

/** Jira account ids of the user's team, from the draft agent's private config. Cached for the
 *  panel's lifetime; a failure is not cached, so the next call asks again. */
export function getTeam(): Promise<Set<string>> {
  if (!teamCache) {
    teamCache = call({ action: 'agent_team' }).then((reply) => {
      const ids = (reply as HostReply & { team?: unknown }).team;
      return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
    });
    teamCache.catch(() => { teamCache = null; });
  }
  return teamCache;
}

export function resetTeamCacheForTest(): void { teamCache = null; }
