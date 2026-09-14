// Ticket-reply polling — checks Gmail every 5 min (via the Apps Script bridge) for new
// inbound replies to outbound Koho emails, i2c form submissions, and manually linked
// email threads, and mirrors the result into chrome.storage.local as a list of tracked
// threads per ticket, so the sidepanel can render red cards / reordered Home + deep-link
// chips on the ticket panel.

import { checkForRepliesViaBridge, listTrackedTicketsViaBridge, type TicketReply } from '../api/bridge';
import { entryKey, mergeEntries, normalizeRepliesMap, sortEntries } from '../data/emailLink';

export const REPLY_POLL_ALARM_NAME = 'reply-poll-5min';
export const REPLY_POLL_TRIGGER_MSG = 'wocoo:reply-poll-now';
export const REPLIES_STORAGE_KEY = 'ticket_replies';
/** Append-only union of every tracked reply we've ever polled. Nothing prunes it, so
 *  a ticket that has been emailed keeps its Gmail deeplink for good — even once the
 *  row is acknowledged and the bridge stops returning it. */
export const REPLIES_ARCHIVE_KEY = 'ticket_replies_archive';
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

/** Storage shape we mirror the bridge result into. Keyed by wocooTicketId, holding every
 *  tracked thread for that ticket: a Koho thread, an i2c thread, and any number of
 *  manually linked email threads can coexist. */
export type TicketRepliesMap = Record<string, TicketReply[]>;

/** Run one poll immediately, write the map into chrome.storage.local, and broadcast
 *  a runtime message so any open panel can react without waiting for its storage
 *  onChanged listener to fire. Never throws — bridge errors are logged and swallowed.
 *
 *  Alarm-driven polls skip when nothing has been tracked yet (no Koho send / i2c
 *  submit ever fired). Manual polls (reason='sidepanel-trigger') bypass that gate
 *  so the Refresh button always feels responsive.
 *
 *  Merge semantics: the new bridge returns every known tracked reply (acked or not)
 *  so the poll fully rebuilds the map from scratch. On old bridge deployments that
 *  only return unacked, this would silently drop previously-seen acked entries —
 *  we intentionally preserve prior entries whose messageId wasn't in the new poll
 *  and mark them `acked=true` so the deeplink survives the bridge upgrade window.
 *
 *  The same entries are also folded into an append-only archive. Rebuilding the live
 *  map can only ever lose an entry (bridge filters acked rows, a poll returns a short
 *  list, an ack write races the poll write); the archive can't, so the ticket panel
 *  falls back to it and the "open the email" chip never disappears on a read ticket. */
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

    // Presence in the sheet is what guarantees a ticket a chip, even when Gmail matched
    // nothing. Tolerate the action missing on older deployments.
    let tracked: TicketReply[] = [];
    try {
      tracked = await listTrackedTicketsViaBridge();
    } catch (e) {
      log('listTrackedTickets unavailable — falling back to replies only', e);
    }

    const stored = await chrome.storage.local.get([REPLIES_STORAGE_KEY, REPLIES_ARCHIVE_KEY]);
    const priorMap = normalizeRepliesMap(stored[REPLIES_STORAGE_KEY]);
    const archive = normalizeRepliesMap(stored[REPLIES_ARCHIVE_KEY]);

    const byTicket = (list: TicketReply[]): Record<string, TicketReply[]> => {
      const out: Record<string, TicketReply[]> = {};
      for (const r of list) (out[r.wocooTicketId] ||= []).push(r);
      return out;
    };
    const polledByTicket = byTicket(replies);
    const trackedByTicket = byTicket(tracked);

    const ticketIds = new Set([
      ...Object.keys(polledByTicket),
      ...Object.keys(priorMap),
      ...Object.keys(archive),
      ...Object.keys(trackedByTicket),
    ]);

    const map: TicketRepliesMap = {};
    for (const id of ticketIds) {
      const entries = mergeEntries({
        polled: polledByTicket[id] || [],
        prior: priorMap[id] || [],
        archived: archive[id] || [],
        tracked: trackedByTicket[id] || [],
      });
      if (entries.length) map[id] = entries;
    }

    // Archive is append-only per entry: keep whichever copy of a thread is newest, but
    // never drop a thread that was in it.
    const nextArchive: TicketRepliesMap = {};
    for (const id of new Set([...Object.keys(archive), ...Object.keys(map)])) {
      const merged = new Map<string, TicketReply>();
      for (const r of archive[id] || []) merged.set(entryKey(r), r);
      for (const r of map[id] || []) {
        const k = entryKey(r);
        const cur = merged.get(k);
        if (!cur || (r.receivedAt || '') >= (cur.receivedAt || '')) merged.set(k, r);
      }
      if (merged.size) nextArchive[id] = sortEntries([...merged.values()]);
    }

    await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map, [REPLIES_ARCHIVE_KEY]: nextArchive });
    log('poll complete —', replies.length, 'replies across', Object.keys(map).length, 'tickets',
        '(' + Object.keys(nextArchive).length + ' archived)');
    return map;
  } catch (e) {
    log('poll failed', e);
    // On failure, DON'T clobber the existing map — a transient bridge error shouldn't
    // hide reply badges the user already saw.
    const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
    return normalizeRepliesMap(cur[REPLIES_STORAGE_KEY]);
  }
}

/** Locally clear tracked threads so the badge/card disappears immediately. Only hides
 *  them until the next poll — the archive isn't touched, by design, so the ticket's
 *  Gmail deeplink comes back rather than being lost.
 *
 *  `key` is an `entryKey`; omit it to clear every thread on the ticket. */
export async function removeReplyLocally(wocooTicketId: string, key?: string): Promise<void> {
  const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
  const map = normalizeRepliesMap(cur[REPLIES_STORAGE_KEY]);
  const entries = map[wocooTicketId];
  if (!entries) return;
  if (key) {
    const next = entries.filter((r) => entryKey(r) !== key);
    if (next.length === entries.length) return;
    if (next.length) map[wocooTicketId] = next;
    else delete map[wocooTicketId];
  } else {
    delete map[wocooTicketId];
  }
  await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
}
