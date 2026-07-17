// Apps Script bridge — calls the published Google Apps Script web app that the v3 Magic
// dashboard already uses for move-logging (and other workflows). The Apps Script reads
// query-string args, performs the work (e.g. appends a row to a Google Sheet), and
// renders an HTML page that postMessages a result back to the parent window.
//
// We invoke it from the side panel by creating a hidden iframe at the URL — same pattern
// as v3's `callBridgeViaIframe`. The handler on the Apps Script side dictates parameter
// names + reply-action strings; this file just adapts to it.

import type { TicketLogPayload, TicketLogUpdatePayload } from '../data/ticketLogTypes';

const BRIDGE_URL =
  'https://script.google.com/a/macros/wealthsimple.com/s/AKfycbzWtgcWj8MgRW-MV9Yf9O5cLgDdktBsMw7vno760EJTjTMQsQKrKg9sZK7LCA73XuA-rA/exec';

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
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let tabId: number | null = null;

      const cleanup = () => {
        settled = true;
        chrome.runtime.onMessage.removeListener(onChromeMessage);
        clearTimeout(timeoutId);
        if (tabId != null) {
          void chrome.tabs.remove(tabId).catch(() => { /* tab may already be closed */ });
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
 *  the reply-poll later locates the thread by searching Sent for `[WOCOO-XXXXX]`.
 *  Also flips `has_tracked_replies` so the alarm-driven poll starts running. */
export async function logKohoSendViaBridge(wocooTicketId: string): Promise<void> {
  await callBridge('logKohoSend', { wocooTicketId }, 'kohoSendLogged', 30_000, true);
  try { await chrome.storage.local.set({ has_tracked_replies: true }); } catch { /* fine */ }
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
  messageId: string;
  from: string;
  snippet: string;
  receivedAt: string;
}

/** Poll Gmail for new inbound replies to every unacknowledged tracked row.
 *  Returns the flat list — the caller keys it by wocooTicketId. */
export async function checkForRepliesViaBridge(): Promise<TicketReply[]> {
  const res = await callBridge('checkForReplies', {}, 'repliesChecked', 60_000, true);
  const raw = (res.replies as unknown) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      wocooTicketId: String(o.wocooTicketId ?? ''),
      kind: (o.kind === 'i2c' ? 'i2c' : 'koho') as 'koho' | 'i2c',
      messageId: String(o.messageId ?? ''),
      from: String(o.from ?? ''),
      snippet: String(o.snippet ?? ''),
      receivedAt: String(o.receivedAt ?? ''),
    };
  }).filter((r) => r.wocooTicketId && r.messageId);
}

/** Flip a tracking row's `acknowledged` flag so the red dot / pill goes away.
 *  Called when the user clicks through to the Gmail permalink. */
export async function acknowledgeReplyViaBridge(wocooTicketId: string, messageId: string): Promise<void> {
  await callBridge('acknowledgeReply', { wocooTicketId, messageId }, 'replyAcknowledged', 30_000, true);
}

/** Batch-backfill i2c tracking rows for previously-emailed clients. The extension
 *  already has Jira access, so it walks the assigned-ticket list and hands GAS a
 *  {wocooTicketId, clientEmail, createdAt} tuple per ticket with a client email.
 *  GAS dedupes on (wocooId + email). Anchor createdAt in the past so the poll
 *  actually searches historical i2c messages. */
export async function backfillI2cViaBridge(
  entries: Array<{ wocooTicketId: string; clientEmail: string; createdAt: string }>,
): Promise<{ added: number; skipped: number }> {
  const res = await callBridge('backfillI2cBatch', { entries: JSON.stringify(entries) }, 'i2cBackfillLogged', 60_000, true);
  const added = Number(res.added || 0);
  const skipped = Number(res.skipped || 0);
  if (added > 0) {
    try { await chrome.storage.local.set({ has_tracked_replies: true }); } catch { /* fine */ }
  }
  return { added, skipped };
}
