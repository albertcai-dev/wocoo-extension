// Service worker — opens the side panel + routes ticket-detection events from
// the content script to the side panel via chrome.storage.session.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('sidePanel.setPanelBehavior failed:', err));

const CURRENT_KEY = 'current_ticket_key';

// "Sticky" current ticket: once we identify a WOCOO ticket the side panel sticks to it
// until we positively identify a DIFFERENT WOCOO ticket. Switching tabs to non-Jira pages
// (Atlas, Notion, Gmail, etc.) does NOT clear the panel. Within the browser session the
// last-viewed ticket persists. Closing the browser clears chrome.storage.session naturally.

// Update the current ticket key in session storage when a content script fires.
chrome.runtime.onMessage.addListener((msg, _sender) => {
  // Phase 1 Ticket Log: relay DOM-observed transitions from the content script to
  // the sidepanel. The sidepanel registers its own chrome.runtime.onMessage listener
  // and re-emits into the in-process event bus. If no sidepanel is open, sendMessage
  // silently no-ops.
  if (msg?.type === 'wocoo:transition-detected') {
    try {
      chrome.runtime.sendMessage({
        type: 'wocoo:transition-detected',
        ticketId: msg.ticketId,
        statusName: msg.statusName,
      }).catch(() => { /* no sidepanel open */ });
    } catch {
      /* no sidepanel open */
    }
    return;
  }
  if (msg?.type === 'wocoo:ticket-changed') {
    const key: string | null = msg.key ?? null;
    if (key) {
      // Positive detection — overwrite. Different ticket → panel updates.
      chrome.storage.session.set({ [CURRENT_KEY]: key });
    }
    // If the page no longer points at a WOCOO ticket (e.g. user closed the modal),
    // leave the stored key alone so the panel remains on the last one.
  }
});

// Also watch tab updates as a backup signal: when an agent clicks between Jira tabs,
// the active tab changes but the content script may already have its key cached.
// Same detection rules as the content script (path → selectedIssue query → hash).
function extractTicketKeyFromUrl(rawUrl: string): string | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  // Only trust Atlassian URLs — otherwise an Atlas link to "WOCOO-XXX" would hijack the panel.
  if (!/atlassian\.net$/i.test(url.hostname)) return null;
  const pathMatch = url.pathname.match(/\/browse\/(WOCOO-\d+)/);
  if (pathMatch) return pathMatch[1];
  const sel = url.searchParams.get('selectedIssue');
  if (sel && /^WOCOO-\d+$/.test(sel)) return sel;
  const newerPath = url.pathname.match(/\/issues?\/(WOCOO-\d+)/);
  if (newerPath) return newerPath[1];
  const hashMatch = url.hash.match(/WOCOO-\d+/);
  if (hashMatch) return hashMatch[0];
  const anyMatch = (url.pathname + url.search + url.hash).match(/WOCOO-\d+/);
  if (anyMatch) return anyMatch[0];
  return null;
}

async function rebroadcastActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return; // No URL — leave the sticky key alone.
  const key = extractTicketKeyFromUrl(tab.url);
  if (key) {
    chrome.storage.session.set({ [CURRENT_KEY]: key });
  }
  // No WOCOO ticket in this tab's URL — leave the sticky key alone.
}

chrome.tabs.onActivated.addListener(() => { rebroadcastActiveTab(); });
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.url) rebroadcastActiveTab();
});

import {
  MCV_ALARM_NAME,
  scheduleNextMcvAlarm,
  handleMcvAlarm,
  runMcvIfMissed,
} from './chequeValidationScheduler';
import {
  REPLY_POLL_ALARM_NAME,
  REPLY_POLL_TRIGGER_MSG,
  scheduleReplyPoll,
  runReplyPollNow,
} from './replyPollScheduler';

// On install / startup, seed once. `scheduleReplyPoll` just registers a chrome.alarms
// entry — no bridge tab opens. The first actual poll runs at the +5 min mark, and only
// if the user has actually sent a Koho email or opened an i2c form (the `has_tracked_replies`
// gate inside `runReplyPollNow`). This keeps startup silent when there's nothing to check.
chrome.runtime.onInstalled.addListener(() => {
  rebroadcastActiveTab();
  void scheduleNextMcvAlarm();
  void runMcvIfMissed();
  void scheduleReplyPoll();
});
chrome.runtime.onStartup.addListener(() => {
  rebroadcastActiveTab();
  void scheduleNextMcvAlarm();
  void runMcvIfMissed();
  void scheduleReplyPoll();
});

// Daily 9 AM Mobile Cheque Validation alarm — one-shot, re-schedules itself.
// Plus the 5-min reply-poll alarm.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MCV_ALARM_NAME) void handleMcvAlarm();
  if (alarm.name === REPLY_POLL_ALARM_NAME) void runReplyPollNow('alarm');
});

// On-demand poll trigger from the sidepanel (🔄 Refresh replies button, or focus).
// The listener returns true so Chrome keeps the message channel open until sendResponse.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== REPLY_POLL_TRIGGER_MSG) return undefined;
  runReplyPollNow('sidepanel-trigger').then((map) => {
    sendResponse({ ok: true, count: Object.keys(map).length });
  }).catch((e) => {
    sendResponse({ ok: false, error: e?.message || String(e) });
  });
  return true;
});
