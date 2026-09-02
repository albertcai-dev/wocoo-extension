// Apps Script bridge — calls the published Google Apps Script web app that the v3 Magic
// dashboard already uses for move-logging (and other workflows). The Apps Script reads
// query-string args, performs the work (e.g. appends a row to a Google Sheet), and
// renders an HTML page that postMessages a result back to the parent window.
//
// We invoke it from the side panel by creating a hidden iframe at the URL — same pattern
// as v3's `callBridgeViaIframe`. The handler on the Apps Script side dictates parameter
// names + reply-action strings; this file just adapts to it.

import type { TicketLogPayload, TicketLogUpdatePayload } from '../data/ticketLogTypes';
import {
  BRIDGE_URL,
  registerBridgeTab,
  unregisterBridgeTab,
  sweepExpiredBridgeTabs,
} from './bridgeTabs';

/** Append a row to the v3 Moves sheet. Fire-and-warn — if the sheet write fails, the
 *  Jira move itself still succeeded. */
export async function logMoveViaBridge(args: {
  sourceTicketId: string;
  destProject: string;
  destDetail?: string;
  operatorName?: string;
  notes: string;
}): Promise<void> {
  await callBridge('logMove', {
    sourceTicketId: args.sourceTicketId,
    destProject: args.destProject,
    destDetail: args.destDetail || '',
    operatorName: args.operatorName || '',
    notes: args.notes,
  }, 'moveLogged', 30_000, true);
}

/** Send a Koho support email via the Apps Script bridge (which calls GmailApp.sendEmail).
 *  Resolves with { recipient, from, sentAt } on success. */
export async function sendKohoEmailViaBridge(args: {
  ticketId: string;
  subject: string;
  body: string;
}): Promise<{ recipient: string; from: string; sentAt: string }> {
  const res = await callBridge('sendKohoEmail', {
    ticketId: args.ticketId,
    subject: args.subject,
    body: args.body,
  }, 'kohoEmailSent', 30_000, true);
  return {
    recipient: String(res.recipient || ''),
    from: String(res.from || ''),
    sentAt: String(res.sentAt || ''),
  };
}

/**
 * Read all `wire_status = Pending posting` rows from the wires sheet via the Apps Script
 * bridge. Apps Script does the filter + hyperlink detection server-side and returns the
 * minimal payload the assistant needs to drive verification.
 */
export interface PendingWireRowFromBridge {
  rowNumber: number;
  amountText: string;
  amount: number;
  currency: string;
  custodianRaw: string;
  custodianHyperlink: string | null;
  wireTimestamp: string;
}
export async function readPendingWiresViaBridge(sheetId: string, tabName: string): Promise<PendingWireRowFromBridge[]> {
  // 30s default was too tight — sheet reads over the growing wires log routinely brush
  // ~40–60s. Give ourselves comfortable headroom (Apps Script's own ceiling is 6 min).
  const res = await callBridge('readPendingWires', { sheetId, tabName }, 'pendingWiresRead', 120_000, true);
  const raw = (res.rows as unknown) ?? [];
  if (!Array.isArray(raw)) throw new Error('Bridge returned no rows array.');
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      rowNumber: Number(o.rowNumber),
      amountText: String(o.amountText ?? ''),
      amount: Number(o.amount),
      currency: String(o.currency ?? ''),
      custodianRaw: String(o.custodianRaw ?? ''),
      custodianHyperlink: o.custodianHyperlink ? String(o.custodianHyperlink) : null,
      wireTimestamp: String(o.wireTimestamp ?? ''),
    };
  });
}

/** Flip a single row's column L (wire_status) to "Posted" via the Apps Script bridge. */
export async function markWirePostedViaBridge(sheetId: string, tabName: string, rowNumber: number): Promise<void> {
  await callBridge('markWirePosted', { sheetId, tabName, row: String(rowNumber) }, 'wirePosted', 30_000, true);
}

// ============ Mobile Cheque Validation bridge calls ============

export interface MCVAnomaly { kind: string; detail: string }
export interface MCVTotalsFromBridge {
  receivedCount: number; processedCount: number; day1Reversed: number;
  opsSlaBreach: number; riskSlaBreach: number;
}
export interface MCVRecord {
  date: string;
  status: 'ready' | 'anomaly';
  totals: MCVTotalsFromBridge;
  anomalies: MCVAnomaly[];
  // Non-blocking caveats about the run — e.g. the Day 1 Rejects tab was missing, so
  // day1Reversed is a skipped 0 rather than a verified 0. Optional: older bridge
  // deployments don't send it.
  notes?: string[];
  computedAt: string;
  sentAt: string | null;
}

/** Trigger the daily validation on demand. Used by the manual "Run now" button and (on
 *  bootstrap) when no scheduled record yet exists. */
export async function runMobileChequeValidationViaBridge(): Promise<MCVRecord> {
  // 50k-row CSV paste + Main recalc + Main read takes longer than the default 30s.
  // 120s gives comfortable headroom; Apps Script's own ceiling is 6 minutes.
  const res = await callBridge('runMobileChequeValidation', {}, 'mobileChequeValidationRun', 120_000, true);
  const record = res.record as unknown as MCVRecord | undefined;
  if (!record) throw new Error('Bridge returned no validation record.');
  return record;
}

/** Read the cached validation status for "today" (key = yesterday's date in the
 *  script's timezone). Returns { dateKey, record: null } if no run has happened. */
export async function getMobileChequeValidationStatusViaBridge(): Promise<{ dateKey: string; record: MCVRecord | null }> {
  const res = await callBridge('getMobileChequeValidationStatus', {}, 'mobileChequeValidationStatus', 30_000, true);
  return {
    dateKey: String(res.dateKey || ''),
    record: (res.record as MCVRecord | null) ?? null,
  };
}

/** Mark the day's validation as posted (channel or DM) so the Home tile shows the
 *  "already sent" state on subsequent loads. */
export async function markMobileChequeValidationSentViaBridge(dateKey: string): Promise<void> {
  await callBridge('markMobileChequeValidationSent', { dateKey }, 'mobileChequeValidationMarkSent', 30_000, true);
}

function callBridge(
  action: string,
  params: Record<string, string>,
  expectedReply: string,
  timeoutMs = 30_000,
  openInBackground = false,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const url = BRIDGE_URL + '?' + qs;

  console.debug('[wocoo-bridge] →', action, params, '(expected reply:', expectedReply + ', timeout:', timeoutMs + 'ms, headless:', openInBackground + ')');

  if (openInBackground) {
    // Headless path — matches the Atlas account-lookup pattern in
    // src/data/atlasAccountLookup.ts: open the GAS URL as a background tab so it
    // doesn't steal focus, and close it from the extension side after receiving the
    // reply. The window.postMessage path is dropped here (a background tab has no
    // window.opener), so we rely on the gasBridge content script forwarding via
    // chrome.runtime.sendMessage.
    //
    // Tabs opened here are also recorded in the persistent registry in ./bridgeTabs, so a
    // worker eviction mid-call (which kills the timeout below before it can close the tab)
    // degrades to "swept a bit late" instead of "leaked forever".
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let tabId: number | null = null;

      // Opportunistic: clear anything already abandoned before adding another tab. Keeps
      // leaks bounded even if the alarms that normally drive the sweep never fire.
      void sweepExpiredBridgeTabs();

      const cleanup = () => {
        settled = true;
        chrome.runtime.onMessage.removeListener(onChromeMessage);
        clearTimeout(timeoutId);
        if (tabId != null) {
          const id = tabId;
          void unregisterBridgeTab(id);
          void chrome.tabs.remove(id).catch(() => { /* tab may already be closed */ });
        }
      };

      function handlePayload(data: Record<string, unknown>) {
        const replyAction = data.action as string | undefined;
        const error = data.error as string | undefined;
        if (replyAction === expectedReply) {
          cleanup();
          resolve(data);
        } else if (error) {
          cleanup();
          reject(new Error(error));
        }
      }

      function onChromeMessage(msg: unknown) {
        if (!msg || typeof msg !== 'object') return;
        const m = msg as { source?: string; payload?: Record<string, unknown> };
        if (m.source !== 'wocoo-gas-bridge' || !m.payload) return;
        console.debug('[wocoo-bridge] ← runtime.sendMessage:', m.payload);
        handlePayload(m.payload);
      }

      chrome.runtime.onMessage.addListener(onChromeMessage);
      const timeoutId = setTimeout(() => {
        if (settled) return;
        console.warn('[wocoo-bridge] ⏱ timed out:', action);
        cleanup();
        reject(new Error(`Bridge call (${action}) timed out after ${Math.round(timeoutMs / 1000)}s — Apps Script never replied.`));
      }, timeoutMs);

      chrome.tabs.create({ url, active: false }).then((tab) => {
        if (settled) {
          // Race: reply arrived before the tab handle did. Close immediately.
          if (tab.id != null) void chrome.tabs.remove(tab.id).catch(() => {});
          return;
        }
        tabId = tab.id ?? null;
        if (tabId != null) void registerBridgeTab(tabId, action, timeoutMs);
      }).catch((e: any) => {
        if (settled) return;
        cleanup();
        reject(new Error(`Bridge call (${action}) could not open a background tab: ${e?.message || String(e)}`));
      });
    });
  }

  // Foreground / legacy path — unchanged. Opens a top-level tab via window.open
  // (not an iframe: extension iframes are third-party for script.google.com so
  // Chrome strips Google auth cookies via SameSite=Lax). The GAS reply script
  // postMessages back to window.opener then closes itself.
  return new Promise((resolve, reject) => {
    const popup = window.open(url, '_blank');
    if (!popup) {
      reject(new Error(`Bridge call (${action}) blocked: could not open bridge tab. Allow popups from the side panel and try again.`));
      return;
    }

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      console.warn('[wocoo-bridge] ⏱ timed out:', action);
      cleanup();
      try { popup.close(); } catch { /* fine */ }
      reject(new Error(`Bridge call (${action}) timed out after ${Math.round(timeoutMs / 1000)}s — Apps Script never replied. Check that the script is still deployed and the bridge tab loaded (look for a script.google.com tab that didn't self-close).`));
    }, timeoutMs);

    function cleanup() {
      settled = true;
      window.removeEventListener('message', onWindowMessage);
      chrome.runtime.onMessage.removeListener(onChromeMessage);
      window.clearTimeout(timeoutId);
    }

    function handlePayload(data: Record<string, unknown>) {
      const action = data.action as string | undefined;
      const error = data.error as string | undefined;
      if (action === expectedReply) {
        cleanup();
        resolve(data);
      } else if (error) {
        cleanup();
        reject(new Error(error));
      }
    }

    // Path 1: direct window.postMessage. Fires when GAS renders its top-level tab AND
    // its sandbox iframe can somehow reach us. Rare in the window.open topology but
    // kept for safety.
    function onWindowMessage(e: MessageEvent) {
      if (!e.data || typeof e.data !== 'object') return;
      const data = e.data as Record<string, unknown>;
      console.debug('[wocoo-bridge] ← window.postMessage:', e.origin, data);
      handlePayload(data);
    }

    // Path 2: forwarded via gasBridge content script running on script.google.com. This
    // is the reliable path — the content script listens for the sandbox's postMessage
    // to window.parent (which it can hear same-origin) and re-sends via chrome.runtime.
    function onChromeMessage(msg: unknown) {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { source?: string; payload?: Record<string, unknown> };
      if (m.source !== 'wocoo-gas-bridge' || !m.payload) return;
      console.debug('[wocoo-bridge] ← runtime.sendMessage:', m.payload);
      handlePayload(m.payload);
    }

    window.addEventListener('message', onWindowMessage);
    chrome.runtime.onMessage.addListener(onChromeMessage);
  });
}

/**
 * Parse a pasted Zendesk transcript via the Apps Script bridge → MagicAI.
 * Returns a 3–5 sentence summary + 4–7 bulleted key facts.
 */
export async function parseTranscriptViaBridge(text: string): Promise<{ summary: string; keyFacts: string[] }> {
  const res = await callBridge('parseTranscript', { text }, 'transcriptParsed');
  return {
    summary: String((res as any).summary ?? ''),
    keyFacts: Array.isArray((res as any).keyFacts)
      ? (res as any).keyFacts.map((x: unknown) => String(x))
      : [],
  };
}

// ============ Ticket Log bridge calls (Phase 1 of Ticket Knowledge Loop) ============

/** Append a row to the Ticket Log sheet. Fires immediately on transition; the row is
 *  bare-metadata until the user saves the note prompt (updateTicketLogViaBridge).
 *  Runs headless — the background tab pattern (chrome.tabs.create + auto-close) means
 *  the operator never sees a script.google.com tab flash open during Clone/Move. */
export async function logTicketViaBridge(p: TicketLogPayload): Promise<{ rowNumber: number; loggedAt: string }> {
  const res = await callBridge('logTicket', {
    ticket_id: p.ticketId,
    ticket_link: p.ticketLink,
    summary: p.summary,
    description_snippet: p.descriptionSnippet,
    original_work_type: p.originalWorkType,
    final_work_type: p.finalWorkType,
    transition: p.transition,
    moved_to_board: p.movedToBoard,
    time_on_ticket_minutes: String(p.timeOnTicketMinutes),
  }, 'ticketLogged', 30_000, true);
  return {
    rowNumber: Number(res.row_number),
    loggedAt: String(res.logged_at || ''),
  };
}

/** Fill in note/tools/flags on an existing row (row_number returned by logTicketViaBridge).
 *  Also headless — the NotePrompt "Save" click shouldn't open a visible GAS tab. */
export async function updateTicketLogViaBridge(p: TicketLogUpdatePayload): Promise<void> {
  await callBridge('updateTicketLog', {
    row_number: String(p.rowNumber),
    resolution_note: p.resolutionNote,
    tools_used: p.toolsUsed,
    mistriaged: p.mistriaged ? 'true' : 'false',
    novel_pattern: p.novelPattern ? 'true' : 'false',
    novel_note: p.novelNote,
  }, 'ticketLogUpdated', 30_000, true);
}

// ============ Ticket Reply tracking (Koho + i2c) ============
// Every outbound Koho email + i2c form submission records a tracking row.
// The extension polls Gmail via `checkForReplies` and surfaces new inbound
// messages as red-dot badges on the Home tile + a deep-link pill on the
// ticket panel.

/** Register that a Koho email was just sent for this WOCOO ticket. Fire-and-forget —
 *  also flips `has_tracked_replies` so the alarm-driven poll starts running.
 *
 *  clientEmail becomes the row's trackKey, mirroring i2c. Searching Sent for
 *  `[WOCOO-XXXXX]` only ever found threads the extension itself composed; a Koho email
 *  written by hand carries no ticket id anywhere, so those rows never matched a reply.
 *  The client's address appears in the thread either way. */
export async function logKohoSendViaBridge(wocooTicketId: string, clientEmail?: string): Promise<void> {
  await callBridge('logKohoSend', { wocooTicketId, clientEmail: clientEmail || '' }, 'kohoSendLogged', 30_000, true);
  try { await chrome.storage.local.set({ has_tracked_replies: true }); } catch { /* fine */ }
}

/** WOCOO ids of koho rows still keyed by ticket id. The sheet names the work rather than
 *  the caller guessing, because the rows needing migration are mostly closed tickets that
 *  never appear in the Home list. */
export async function listKohoRowsNeedingEmailViaBridge(): Promise<string[]> {
  const res = await callBridge('listKohoRowsNeedingEmail', {}, 'kohoRowsNeedingEmailListed', 30_000, true);
  const raw = res.ids;
  return Array.isArray(raw) ? raw.map((x) => String(x)).filter(Boolean) : [];
}

/** Repoint existing koho rows from ticket-id trackKeys to client-email ones. GAS only
 *  touches koho rows whose trackKey has no '@', so it's idempotent and can't clobber
 *  rows already migrated (or i2c rows). Chunked for the same URL-length reason as the
 *  i2c backfill. */
export async function backfillKohoTrackKeysViaBridge(
  entries: Array<{ wocooTicketId: string; clientEmail: string }>,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i += I2C_BACKFILL_CHUNK) {
    const chunk = entries.slice(i, i + I2C_BACKFILL_CHUNK);
    const res = await callBridge('backfillKohoTrackKeys', { entries: JSON.stringify(chunk) }, 'kohoTrackKeysBackfilled', 60_000, true);
    updated += Number(res.updated || 0);
    skipped += Number(res.skipped || 0);
  }
  return { updated, skipped };
}

/** Register that the user just opened the i2c "Open & Fill Form" for this WOCOO ticket.
 *  clientEmail is the search key — i2c support notification bodies reference it. */
export async function logI2cSubmitViaBridge(wocooTicketId: string, clientEmail: string): Promise<void> {
  await callBridge('logI2cSubmit', { wocooTicketId, clientEmail }, 'i2cSubmitLogged', 30_000, true);
  try { await chrome.storage.local.set({ has_tracked_replies: true }); } catch { /* fine */ }
}

export interface TicketReply {
  wocooTicketId: string;
  kind: 'koho' | 'i2c';
  /** Empty when the tracking row exists but no inbound reply has been matched yet —
   *  the pill then falls back to a Gmail search on `trackKey`. */
  messageId: string;
  /** The tracking sheet's trackKey (ticket id for Koho, client email for i2c). Used
   *  to build the Gmail search fallback. */
  trackKey?: string;
  from: string;
  snippet: string;
  receivedAt: string;
  /** True when the tracking-sheet row has `acknowledged=TRUE`. Missing on old bridge
   *  deployments — treat undefined as false. When the bridge is updated to return
   *  acked rows too, the pill renders them in a muted "seen" style rather than
   *  disappearing, so the Gmail deeplink stays reachable. */
  acked?: boolean;
}

/** Poll Gmail for new inbound replies. The bridge returns every tracked reply row
 *  it knows about (acked or not) so the extension can keep the deeplink visible
 *  after ack. Old-bridge fallback: rows without `acked` are treated as unacked. */
export async function checkForRepliesViaBridge(): Promise<TicketReply[]> {
  const res = await callBridge('checkForReplies', {}, 'repliesChecked', 60_000, true);
  const raw = (res.replies as unknown) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      wocooTicketId: String(o.wocooTicketId ?? ''),
      kind: (String(o.kind ?? '').toLowerCase() === 'i2c' ? 'i2c' : 'koho') as 'koho' | 'i2c',
      messageId: String(o.messageId ?? ''),
      trackKey: o.trackKey != null ? String(o.trackKey) : undefined,
      from: String(o.from ?? ''),
      snippet: String(o.snippet ?? ''),
      receivedAt: String(o.receivedAt ?? ''),
      acked: o.acked === true || o.acked === 'TRUE' || o.acked === 'true',
    };
    // A row with no messageId is still a tracked ticket — keep it so the panel can
    // offer a Gmail search for the outbound thread instead of showing nothing.
  }).filter((r) => r.wocooTicketId);
}

/** Every row of the reply-tracking sheet, verbatim — no Gmail work, no filtering on
 *  `acknowledged`. `checkForReplies` only surfaces tickets it matched a live inbound
 *  message for, so this is what guarantees a ticket that's merely *present* in the
 *  sheet keeps an "open the email" chip on the panel forever.
 *
 *  Deliberately tolerant: an Apps Script deployment that doesn't know the action never
 *  posts a reply, so callBridge times out. Callers swallow that and fall back to the
 *  checkForReplies-only behaviour. */
export async function listTrackedTicketsViaBridge(): Promise<TicketReply[]> {
  const res = await callBridge('listTrackedTickets', {}, 'trackedTicketsListed', 30_000, true);
  const raw = (res.tickets as unknown) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      wocooTicketId: String(o.wocooTicketId ?? ''),
      kind: (String(o.kind ?? '').toLowerCase() === 'i2c' ? 'i2c' : 'koho') as 'koho' | 'i2c',
      // The sheet's lastSeenMsgId. Blank until a reply has been matched.
      messageId: String(o.messageId ?? ''),
      trackKey: o.trackKey != null ? String(o.trackKey) : undefined,
      from: '',
      snippet: '',
      // The sheet has no reply timestamp, only when we sent. Leave blank rather than
      // passing createdAt off as a received date — the chip hides the date when empty.
      receivedAt: '',
      acked: o.acked === true || o.acked === 'TRUE' || o.acked === 'true',
    };
  }).filter((r) => r.wocooTicketId);
}

/** Flip a tracking row's `acknowledged` flag so the red dot / pill goes away.
 *  Called when the user clicks through to the Gmail permalink. */
export async function acknowledgeReplyViaBridge(wocooTicketId: string, messageId: string): Promise<void> {
  await callBridge('acknowledgeReply', { wocooTicketId, messageId }, 'replyAcknowledged', 30_000, true);
}

// ============ i2c thread lookup (I2cThreadLookup.gs) ============

export interface I2cThreadLookup {
  /** Gmail's own thread URL. Empty when nothing matched — that's a normal result, not an
   *  error, so callers fall back to a Gmail search rather than surfacing a failure. */
  permalink: string;
  threadId: string;
  /** Last message in the thread. Used as the deep-link anchor if `threadId` is ever absent —
   *  Gmail resolves a message ID to its containing thread. */
  messageId: string;
  subject: string;
  from: string;
  lastDate: string;
  /** Threads that mentioned the ref at all. >1 means `permalink` is a best guess, so the
   *  UI should say "best match" instead of implying certainty. */
  matchCount: number;
}

const I2C_THREAD_CACHE_KEY = 'i2c_thread_cache';
/** Threads don't move once resolved, so cache generously — this exists to keep the second
 *  click instant, not to guard against staleness. A miss (permalink: '') is cached far more
 *  briefly, since the i2c notification may simply not have landed yet. */
const I2C_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const I2C_THREAD_MISS_TTL_MS = 10 * 60 * 1000;

type I2cThreadCache = Record<string, { at: number; result: I2cThreadLookup }>;

/** Resolve an i2c ref (e.g. "PO-420974") to its exact Gmail thread, via the GAS bridge.
 *  Cached in chrome.storage.local so repeat clicks don't spawn another bridge tab.
 *
 *  Throws only on a genuine bridge failure (timeout, GAS error, action not deployed).
 *  "No matching thread" resolves normally with an empty `permalink`. */
export async function findI2cThreadViaBridge(i2cRef: string, opts?: { force?: boolean }): Promise<I2cThreadLookup> {
  const ref = i2cRef.trim().toUpperCase();
  if (!ref) return { permalink: '', threadId: '', messageId: '', subject: '', from: '', lastDate: '', matchCount: 0 };

  if (!opts?.force) {
    const stored = (await chrome.storage.local.get(I2C_THREAD_CACHE_KEY))[I2C_THREAD_CACHE_KEY] as I2cThreadCache | undefined;
    const hit = stored?.[ref];
    if (hit) {
      const ttl = hit.result.permalink ? I2C_THREAD_TTL_MS : I2C_THREAD_MISS_TTL_MS;
      if (Date.now() - hit.at < ttl) return hit.result;
    }
  }

  const res = await callBridge('findI2cThread', { i2cRef: ref }, 'i2cThreadResolved', 45_000, true);
  const result: I2cThreadLookup = {
    permalink: String(res.permalink || ''),
    threadId: String(res.threadId || ''),
    messageId: String(res.messageId || ''),
    subject: String(res.subject || ''),
    from: String(res.from || ''),
    lastDate: String(res.lastDate || ''),
    matchCount: Number(res.matchCount || 0),
  };

  try {
    const stored = (await chrome.storage.local.get(I2C_THREAD_CACHE_KEY))[I2C_THREAD_CACHE_KEY] as I2cThreadCache | undefined;
    await chrome.storage.local.set({ [I2C_THREAD_CACHE_KEY]: { ...(stored || {}), [ref]: { at: Date.now(), result } } });
  } catch { /* cache is a nicety — a write failure shouldn't fail the lookup */ }

  return result;
}

/** Gmail URL for a resolved lookup, or '' if it resolved to nothing.
 *
 *  Built from the thread ID, NOT from `permalink`. Apps Script's
 *  `GmailThread.getPermalink()` returns the legacy sync form —
 *  `https://mail.google.com/mail?extsrc=sync&client=docs&plid=…` — which carries no thread
 *  fragment, ignores the `u/<n>` account selector, and in practice dumps you on the inbox.
 *  Verified against PO-420974 on 2026-08-03. The hex thread ID in an `#all/<id>` fragment
 *  does open the exact thread, so that's the primary. `#all` rather than `#inbox` so an
 *  archived thread still resolves.
 *
 *  `permalink` is kept as a last resort purely in case a future Apps Script version starts
 *  returning a real deep link — hence the `#` test, which the legacy sync form fails. */
export function i2cThreadUrl(result: I2cThreadLookup): string {
  const anchor = result.threadId || result.messageId;
  if (anchor) return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(anchor)}`;
  if (result.permalink.includes('#')) return result.permalink;
  return '';
}

/** Batch-backfill i2c tracking rows for previously-emailed clients. The extension
 *  already has Jira access, so it walks the assigned-ticket list and hands GAS a
 *  {wocooTicketId, clientEmail, createdAt} tuple per ticket with a client email.
 *  GAS dedupes on (wocooId + email). Anchor createdAt in the past so the poll
 *  actually searches historical i2c messages.
 *
 *  Sent in chunks because every bridge call is a GET: the whole batch rides in the query
 *  string, and a full Home list (~50 entries × ~150 URL-encoded bytes) lands right on the
 *  ~8KB request-line limit. Chunking is safe — GAS dedupes server-side, so a retried or
 *  overlapping chunk adds nothing. */
const I2C_BACKFILL_CHUNK = 20;

export async function backfillI2cViaBridge(
  entries: Array<{ wocooTicketId: string; clientEmail: string; createdAt: string }>,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i += I2C_BACKFILL_CHUNK) {
    const chunk = entries.slice(i, i + I2C_BACKFILL_CHUNK);
    const res = await callBridge('backfillI2cBatch', { entries: JSON.stringify(chunk) }, 'i2cBackfillLogged', 60_000, true);
    added += Number(res.added || 0);
    skipped += Number(res.skipped || 0);
  }
  if (added > 0) {
    try { await chrome.storage.local.set({ has_tracked_replies: true }); } catch { /* fine */ }
  }
  return { added, skipped };
}

export interface RefundLetterParams {
  clientName: string;
  addressStreet: string;
  addressCityProvince: string;
  addressPostal: string;
  closedCardLast4: string;
  newCardLast4: string;
  refundDates: string;
  declineReason: string;
  agentFirstName: string;
  /** 'refund' / 'refunds' and 'was' / 'were' — the body sentence agrees with the count. */
  refundNoun: string;
  refundVerb: string;
  letterDate?: string;
  wocooTicketId?: string;
  /** Ask the bridge for base64 PDF bytes so we can attach it to the Jira ticket. */
  includePdfBase64?: boolean;
}

export interface RefundLetterResult {
  docId: string;
  docUrl: string;
  pdfId: string;
  pdfUrl: string;
  fileName: string;
  pdfBase64?: string;
}

/** Copy the tokenized template, fill it, export a PDF. See RefundLetter.gs in the
 *  wocoo-gas-bridge repo — 90s because a Doc copy + PDF export is slower than a
 *  sheet append. */
export async function createRefundLetterViaBridge(p: RefundLetterParams): Promise<RefundLetterResult> {
  const params: Record<string, string> = {
    clientName: p.clientName,
    addressStreet: p.addressStreet,
    addressCityProvince: p.addressCityProvince,
    addressPostal: p.addressPostal,
    closedCardLast4: p.closedCardLast4,
    newCardLast4: p.newCardLast4,
    refundDates: p.refundDates,
    declineReason: p.declineReason,
    agentFirstName: p.agentFirstName,
    refundNoun: p.refundNoun,
    refundVerb: p.refundVerb,
    wocooTicketId: p.wocooTicketId || '',
  };
  if (p.letterDate) params.letterDate = p.letterDate;
  if (p.includePdfBase64) params.includePdfBase64 = '1';

  const res = await callBridge('createRefundLetter', params, 'refundLetterCreated', 90_000, true);
  if (res.ok === false) throw new Error(String(res.error || 'Bridge could not create the letter'));
  const result = res.result as RefundLetterResult | undefined;
  if (!result || !result.docUrl) throw new Error('Bridge returned no letter links.');
  return result;
}
