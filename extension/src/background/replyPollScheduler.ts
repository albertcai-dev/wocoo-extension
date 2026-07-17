// Ticket-reply polling — checks Gmail every 5 min (via the Apps Script bridge)
// for new inbound replies to outbound Koho emails + i2c form submissions, and
// mirrors the result into chrome.storage.local so the sidepanel can render red
// dots / reordered Home + a deep-link pill on the ticket panel.

import { checkForRepliesViaBridge, type TicketReply } from '../api/bridge';

export const REPLY_POLL_ALARM_NAME = 'reply-poll-5min';
export const REPLY_POLL_TRIGGER_MSG = 'wocoo:reply-poll-now';
export const REPLIES_STORAGE_KEY = 'ticket_replies';
export const HAS_TRACKED_STORAGE_KEY = 'has_tracked_replies';

const REPLY_POLL_PERIOD_MIN = 5;

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-reply-poll]', msg, ...args);
}

/** Register a 5-min repeating alarm. chrome.alarms.create replaces by name so this
 *  is idempotent — safe to call on install, startup, and after service-worker restarts.
 *  First fire is at the +5 min mark so freshly-reloaded extensions don't flash a
 *  bridge tab immediately on startup. */
export async function scheduleReplyPoll(): Promise<void> {
  await chrome.alarms.create(REPLY_POLL_ALARM_NAME, {
    periodInMinutes: REPLY_POLL_PERIOD_MIN,
  });
  log('scheduled reply poll every', REPLY_POLL_PERIOD_MIN, 'min');
}

/** Set by `logKohoSendViaBridge` / `logI2cSubmitViaBridge` when they succeed. Read by
 *  the alarm handler to skip pointless polls before any row exists. Manual Refresh
 *  ignores this and polls unconditionally so the user can force a check. */
export async function markHasTrackedReplies(): Promise<void> {
  await chrome.storage.local.set({ [HAS_TRACKED_STORAGE_KEY]: true });
}

/** Storage shape we mirror the bridge result into. Keyed by wocooTicketId so the
 *  ticket panel + Home rows can look up their own reply without scanning an array. */
export type TicketRepliesMap = Record<string, TicketReply>;

/** Run one poll immediately, write the map into chrome.storage.local, and broadcast
 *  a runtime message so any open panel can react without waiting for its storage
 *  onChanged listener to fire. Never throws — bridge errors are logged and swallowed.
 *
 *  Alarm-driven polls skip when nothing has been tracked yet (no Koho send / i2c
 *  submit ever fired). Manual polls (reason='sidepanel-trigger') bypass that gate
 *  so the Refresh button always feels responsive. */
export async function runReplyPollNow(reason: string): Promise<TicketRepliesMap> {
  try {
    if (reason !== 'sidepanel-trigger') {
      const st = await chrome.storage.local.get(HAS_TRACKED_STORAGE_KEY);
      if (!st[HAS_TRACKED_STORAGE_KEY]) {
        log('skipping (' + reason + ') — no tracked rows yet');
        return {};
      }
    }
    log('polling (' + reason + ')');
    const replies = await checkForRepliesViaBridge();
    const map: TicketRepliesMap = {};
    // If Gmail returns multiple replies for the same ticket (unlikely — the sheet has
    // one row per send + i2c-open — but possible when both a Koho and i2c thread
    // exist for the same WOCOO ticket), keep the latest by receivedAt.
    for (const r of replies) {
      const prior = map[r.wocooTicketId];
      if (!prior || (r.receivedAt || '') > (prior.receivedAt || '')) {
        map[r.wocooTicketId] = r;
      }
    }
    await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
    log('poll complete —', replies.length, 'unacknowledged replies across', Object.keys(map).length, 'tickets');
    return map;
  } catch (e) {
    log('poll failed', e);
    // On failure, DON'T clobber the existing map — a transient bridge error shouldn't
    // hide reply badges the user already saw.
    const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
    return (cur[REPLIES_STORAGE_KEY] as TicketRepliesMap | undefined) || {};
  }
}

/** Locally clear a single reply so the badge/pill disappears immediately after the
 *  user clicks the Gmail deep link. The next poll will re-add it if the bridge
 *  hasn't recorded the acknowledgement yet (rare race). */
export async function removeReplyLocally(wocooTicketId: string): Promise<void> {
  const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
  const map = (cur[REPLIES_STORAGE_KEY] as TicketRepliesMap | undefined) || {};
  if (!(wocooTicketId in map)) return;
  delete map[wocooTicketId];
  await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
}
