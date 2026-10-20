// Client for the local draft agent's store, reached through the native messaging host
// (native-host/wocoo_launcher.py), which shells out to the agent's store CLI.

import type { AgentDraft, DraftOutcomeRow, ReadyDraftRow } from '../data/agentDraftTypes';

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
  /^Unknown action: '?(draft_|i2c_activity)/i,
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
