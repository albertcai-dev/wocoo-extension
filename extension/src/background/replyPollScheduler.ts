// Ticket-reply polling — checks Gmail every 5 min (via the Apps Script bridge)
// for new inbound replies to outbound Koho emails + i2c form submissions, and
// mirrors the result into chrome.storage.local so the sidepanel can render red
// dots / reordered Home + a deep-link pill on the ticket panel.

import { checkForRepliesViaBridge, listTrackedTicketsViaBridge, type TicketReply } from '../api/bridge';

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

/** Storage shape we mirror the bridge result into. Keyed by wocooTicketId so the
 *  ticket panel + Home rows can look up their own reply without scanning an array. */
export type TicketRepliesMap = Record<string, TicketReply>;

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
    const prior = await chrome.storage.local.get([REPLIES_STORAGE_KEY, REPLIES_ARCHIVE_KEY]);
    const priorMap = (prior[REPLIES_STORAGE_KEY] as TicketRepliesMap | undefined) || {};
    const archive = (prior[REPLIES_ARCHIVE_KEY] as TicketRepliesMap | undefined) || {};

    const map: TicketRepliesMap = {};
    // If the bridge returns multiple replies for the same ticket (unlikely — the sheet
    // has one row per send + i2c-open — but possible when both a Koho and i2c thread
    // exist for the same WOCOO ticket), keep the latest by receivedAt.
    for (const r of replies) {
      const cur = map[r.wocooTicketId];
      if (!cur || (r.receivedAt || '') > (cur.receivedAt || '')) {
        map[r.wocooTicketId] = r;
      }
    }
    // Carry forward prior entries the bridge no longer returned (old-bridge fallback:
    // the deployment still filters unacked, so an ack causes a row to vanish). Mark
    // them acked so the pill renders in the muted state.
    // …and the same for anything only the archive still remembers, so a ticket the
    // bridge has forgotten about keeps its chip on the panel.
    for (const source of [priorMap, archive]) {
      for (const [id, entry] of Object.entries(source)) {
        if (!(id in map)) map[id] = { ...entry, acked: true };
      }
    }

    // Last: everything in the tracking sheet earns an entry even when Gmail matched
    // nothing — presence in the sheet is what guarantees the ticket a chip. These are
    // content-free (no snippet, no received date), so they only ever fill gaps left by
    // the two richer sources above, and always render muted: `checkForReplies` is the
    // sole detector of genuinely-new replies, so a row known only from the sheet has
    // nothing to alert about. Tolerate the action missing on older deployments.
    let tracked: TicketReply[] = [];
    try {
      tracked = await listTrackedTicketsViaBridge();
    } catch (e) {
      log('listTrackedTickets unavailable — falling back to replies only', e);
    }
    for (const t of tracked) {
      if (!(t.wocooTicketId in map)) map[t.wocooTicketId] = { ...t, acked: true };
    }

    // Archive is append-only: keep whichever copy of a ticket's reply is newest, but
    // never drop a ticket that was in it.
    const nextArchive: TicketRepliesMap = { ...archive };
    for (const [id, entry] of Object.entries(map)) {
      const cur = nextArchive[id];
      if (!cur || (entry.receivedAt || '') >= (cur.receivedAt || '')) nextArchive[id] = entry;
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
    return (cur[REPLIES_STORAGE_KEY] as TicketRepliesMap | undefined) || {};
  }
}

/** Locally clear a single reply so the badge/pill disappears immediately. Only hides
 *  it until the next poll — the archive isn't touched, by design, so the ticket's
 *  Gmail deeplink comes back rather than being lost. */
export async function removeReplyLocally(wocooTicketId: string): Promise<void> {
  const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
  const map = (cur[REPLIES_STORAGE_KEY] as TicketRepliesMap | undefined) || {};
  if (!(wocooTicketId in map)) return;
  delete map[wocooTicketId];
  await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
}
