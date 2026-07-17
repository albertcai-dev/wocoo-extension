// Runs on every wealthsimple.atlassian.net page. Watches the URL for a WOCOO ticket key
// (Jira is an SPA, so we listen for history.pushState as well as the initial load) and
// pushes the detected key to the service worker.
//
// Atlassian uses several URL shapes for a WOCOO ticket depending on board/queue/backlog
// view + new vs legacy product. Rather than enumerate, prefer the canonical patterns and
// fall back to "first WOCOO-N anywhere in the URL." Sticky behaviour in the service worker
// guarantees we never *clear* on a missed detection — only overwrite on a positive match.

function currentTicketKey(): string | null {
  // Highest-confidence: full-page ticket view.
  const pathMatch = location.pathname.match(/\/browse\/(WOCOO-\d+)/);
  if (pathMatch) return pathMatch[1];
  // Common: detail-view modal on boards/queues uses ?selectedIssue=WOCOO-N.
  const sel = new URLSearchParams(location.search).get('selectedIssue');
  if (sel && /^WOCOO-\d+$/.test(sel)) return sel;
  // Newer board path: /jira/.../boards/N/issue/WOCOO-N or .../issues/WOCOO-N.
  const newerPath = location.pathname.match(/\/issues?\/(WOCOO-\d+)/);
  if (newerPath) return newerPath[1];
  // Hash fallback.
  const hashMatch = location.hash.match(/WOCOO-\d+/);
  if (hashMatch) return hashMatch[0];
  // Last resort: scan the whole URL (search + path) for WOCOO-N. Catches the long-form
  // board URLs Jira sometimes emits ("/jira/.../detail/WOCOO-22682", "?focusedIssue=…", etc.)
  const anyMatch = (location.pathname + location.search + location.hash).match(/WOCOO-\d+/);
  if (anyMatch) return anyMatch[0];
  return null;
}

let lastSent: string | null | undefined; // undefined = not yet sent

function broadcast(): void {
  const key = currentTicketKey();
  // Only broadcast positive ticket detections. Going from a ticket back to "no ticket"
  // (e.g. closing the board modal) shouldn't clear the side panel — sticky behavior is
  // handled by the service worker only ever overwriting on a positive match.
  if (!key) return;
  if (key === lastSent) return;
  lastSent = key;
  try {
    chrome.runtime.sendMessage({ type: 'wocoo:ticket-changed', key });
  } catch (e) {
    // Service worker might be sleeping; ignore — next navigation will retry.
  }
}

// Initial load
broadcast();

// SPA navigation: patch history.pushState/replaceState + listen for popstate
const _push = history.pushState;
history.pushState = function (...args: Parameters<typeof history.pushState>) {
  const r = _push.apply(this, args);
  setTimeout(broadcast, 50);
  return r;
};
const _replace = history.replaceState;
history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
  const r = _replace.apply(this, args);
  setTimeout(broadcast, 50);
  return r;
};
window.addEventListener('popstate', () => setTimeout(broadcast, 50));
window.addEventListener('hashchange', () => setTimeout(broadcast, 50));

// ------------------------------------------------------------
// Status-pill observer: detects when a WOCOO ticket transitions to Done / Cancelled
// (or any other status) while the user is viewing it in Jira, whether the transition
// came from the sidepanel or from Jira's own status dropdown.
//
// The selector Atlassian uses for the status pill on the detail view is not stable
// across product surfaces; we use a defensive combination of aria-label + data-testid
// and fall back to text content of any element with role="button" whose text matches
// a known WOCOO status ("Done", "Cancelled", "In Progress", etc.). Only "terminal"
// transitions (Done / Cancelled) are broadcast — other status transitions are noisy
// and not useful for the ticket log.
// ------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['Done', 'Cancelled', 'Canceled']);

function findStatusPillText(): string | null {
  // Jira "status" button typically has data-testid containing "status-field" OR
  // aria-label starting with "Change status". Try both, take the visible text.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    '[data-testid*="status" i], [aria-label*="Change status" i]'
  ));
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
  }
  return null;
}

let lastStatusByTicket: Record<string, string> = {};

function checkStatusChange(): void {
  const key = currentTicketKey();
  if (!key) return;
  const status = findStatusPillText();
  if (!status) return;
  const prev = lastStatusByTicket[key];
  if (prev === status) return;
  lastStatusByTicket[key] = status;
  if (prev == null) return; // first observation; don't fire — user just landed
  if (!TERMINAL_STATUSES.has(status)) return;
  try {
    chrome.runtime.sendMessage({
      type: 'wocoo:transition-detected',
      ticketId: key,
      statusName: status,
    });
  } catch (e) {
    // Service worker asleep or panel closed — nothing to do.
  }
}

// Observe body mutations at a coarse level; the status pill lives deep in a
// virtualized tree so a global observer is simpler than pinning to the pill's
// container (which re-mounts on nav). Debounce to avoid thrashing on typing.
let mutationDebounce: number | null = null;
const bodyObserver = new MutationObserver(() => {
  if (mutationDebounce != null) window.clearTimeout(mutationDebounce);
  mutationDebounce = window.setTimeout(() => { mutationDebounce = null; checkStatusChange(); }, 250);
});
bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

// Also check on SPA navigations (the URL change handlers above fire broadcast(); do
// a status check on the same beat).
window.addEventListener('popstate', () => setTimeout(checkStatusChange, 400));
window.addEventListener('hashchange', () => setTimeout(checkStatusChange, 400));
