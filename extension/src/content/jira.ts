// Runs on every wealthsimple.atlassian.net page. Watches the URL for a WOCOO ticket key
// (Jira is an SPA, so we listen for history.pushState as well as the initial load) and
// pushes the detected key to the service worker.
//
// Atlassian uses several URL shapes for a WOCOO ticket depending on board/queue/backlog
// view + new vs legacy product. Rather than enumerate, prefer the canonical patterns and
// fall back to "first WOCOO-N anywhere in the URL." Sticky behaviour in the service worker
// guarantees we never *clear* on a missed detection — only overwrite on a positive match.

import {
  PREFILL_COMMENT_MESSAGE, fallbackLine, insertionBlocker, isBusyElsewhere, opsToPasteHtml, opsToPlainText,
  readInsertionState, segmentsToEditorOps, shouldPrefill,
  type EditorOp, type FocusedElementInfo, type InsertionBlock, type PrefillCommentMessage, type PrefillCommentReply,
} from '../data/commentPrefill';
import { JIRA_WHOAMI_MESSAGE } from '../data/jiraIdentity';
import { JIRA_COMMENT_SELECTORS } from '../data/jiraCommentSelectors';

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

// ------------------------------------------------------------
// Comment prefill: the side panel sends the agent draft for this ticket and we put it into
// Jira's NEW-comment editor UNSAVED, for the user to edit and Save himself.
//
// SAFETY: nothing here clicks Save, dispatches a submit, or synthesises Enter / Cmd+Enter /
// Ctrl+Enter key events, and execCommand is only ever 'insertText' with single-line text (never
// 'insertParagraph' / 'insertLineBreak'). Paragraph breaks only arrive inside a paste's HTML;
// when the paste isn't taken, only the first line goes in and the reply says 'partial'.
// No synthetic keystrokes at all: mentions arrive inside the paste (step 3 below).
//
// Before every paste and execCommand the insertion guard
// re-checks: editor still attached, focus still inside it, page still on the ticket, selection a
// collapsed caret with nothing after it. Any failure aborts with reason 'interrupted'. Focus is
// set once at the start and never stolen back. An automatic prefill (msg.auto) does not start at
// all while the user is typing in another input/textarea/contenteditable ('busy-elsewhere').
//
// Insertion strategy (no trusted typing available to a content script):
//   1. Open the editor by clicking the collapsed "Add a comment…" placeholder; only an editor
//      inside the new-comment container (never one inside an existing comment) is used.
//   2. Text: a synthetic `paste` ClipboardEvent carrying text/plain + text/html. ProseMirror reads
//      event.clipboardData, so links and paragraphs go in in one step. If the editor did not
//      take it, execCommand('insertText') of the first line only ('partial').
//   3. Mentions go in the same paste, as span[data-mention-id] in the HTML, which the editor
//      parses into a mention pill (as when pasting a copied comment). Typing "@Name" through the
//      typeahead was tried first and lost characters on the live page (2026-10-20). If the
//      editor drops the span, the plain "@Name" text remains.
// ------------------------------------------------------------


const PREFILL_EDITOR_WAIT_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isShown(el: Element): boolean {
  return el instanceof HTMLElement && el.getClientRects().length > 0;
}

function firstShown(selectors: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const sel of selectors) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
      if (isShown(el)) return el;
    }
  }
  return null;
}

async function pollFor<T>(fn: () => T | null, timeoutMs: number, stepMs = 120): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

/** Whether anything between `el` and `container` (exclusive) is an existing comment item. */
function insideExistingComment(el: HTMLElement, container: HTMLElement): boolean {
  const S = JIRA_COMMENT_SELECTORS;
  for (let n: HTMLElement | null = el.parentElement; n && n !== container; n = n.parentElement) {
    if (S.existingCommentItem.some((sel) => n!.matches(sel))) return true;
    if (S.existingCommentId.test(n.id)) return true;
    if (n.querySelector(S.existingCommentMarkers)) return true;
  }
  return false;
}

/** The new-comment editor: inside a new-comment container, not inside an existing comment. */
function findCommentEditor(): HTMLElement | null {
  const S = JIRA_COMMENT_SELECTORS;
  for (const csel of S.newCommentContainer) {
    for (const container of Array.from(document.querySelectorAll<HTMLElement>(csel))) {
      if (!isShown(container)) continue;
      for (const esel of S.editor) {
        for (const ed of Array.from(container.querySelectorAll<HTMLElement>(esel))) {
          if (isShown(ed) && ed.isContentEditable && !insideExistingComment(ed, container)) return ed;
        }
      }
    }
  }
  return null;
}

function findCommentPlaceholder(): HTMLElement | null {
  const S = JIRA_COMMENT_SELECTORS;
  const bySelector = firstShown(S.placeholder);
  if (bySelector) return bySelector;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(S.placeholderTextCandidates))) {
    if (!isShown(el) || el.isContentEditable) continue;
    const own = (el as HTMLTextAreaElement).placeholder || el.getAttribute('aria-label') || el.textContent || '';
    if (S.placeholderText.test(own.trim()) && own.trim().length < 40) return el;
  }
  return null;
}

/** document.activeElement as isBusyElsewhere sees it; null when nothing (or only the page) has focus. */
function describeFocus(): FocusedElementInfo | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return null;
  const S = JIRA_COMMENT_SELECTORS;
  const ph = findCommentPlaceholder();
  const inNewComment = S.newCommentContainer.some((sel) => !!el.closest(sel)) || (!!ph && (ph === el || ph.contains(el)));
  return {
    tagName: el.tagName,
    inputType: el instanceof HTMLInputElement ? el.type : undefined,
    isContentEditable: el.isContentEditable,
    inNewComment,
  };
}

/** Opens the new-comment editor if it is collapsed and waits for it (up to ~5 s). */
async function openCommentEditor(): Promise<HTMLElement | null> {
  let lastClick = 0;
  return pollFor(() => {
    const editor = findCommentEditor();
    if (editor) return editor;
    const ph = findCommentPlaceholder();
    if (ph && Date.now() - lastClick > 1_000) {
      lastClick = Date.now();
      ph.click();
    }
    return null;
  }, PREFILL_EDITOR_WAIT_MS, 150);
}

/** The user's content in a fragment/element as text, decorations removed. Non-text content
 *  (images, media, emoji, mentions, node views) counts as one "@" each so it isn't mistaken for empty. */
function contentText(root: ParentNode & Node): string {
  const S = JIRA_COMMENT_SELECTORS;
  root.querySelectorAll(S.decorations).forEach((n) => n.remove());
  const nodes = root.querySelectorAll(S.contentNodes).length;
  return (root.textContent || '') + '@'.repeat(nodes);
}

function editorText(editor: HTMLElement): string {
  return contentText(editor.cloneNode(true) as HTMLElement);
}

/** Text after the caret inside the editor (decorations removed). */
function textAfterCaret(editor: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const caret = sel.getRangeAt(0);
  const r = document.createRange();
  r.selectNodeContents(editor);
  try { r.setStart(caret.endContainer, caret.endOffset); } catch { return '\u0000'; }
  return contentText(r.cloneContents());
}

class PrefillInterrupted extends Error {
  constructor(public why: InsertionBlock) { super(`prefill interrupted: ${why}`); }
}
class PrefillPartial extends Error {}

/** Throws PrefillInterrupted unless it is safe to insert right now. */
function guard(editor: HTMLElement, key: string): void {
  const state = readInsertionState({
    editor,
    activeElement: document.activeElement,
    selection: window.getSelection(),
    currentKey: currentTicketKey(),
    textAfterCaret: () => textAfterCaret(editor),
  });
  const block = insertionBlocker(state, key);
  if (block) throw new PrefillInterrupted(block);
}

function placeCaretAtEnd(editor: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const last = editor.lastElementChild ?? editor;
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Single-line execCommand insert, guarded. Never called with a newline. */
function execInsert(editor: HTMLElement, key: string, text: string): void {
  if (!text) return;
  if (/[\r\n]/.test(text)) throw new Error('execInsert called with a newline');
  guard(editor, key);
  document.execCommand('insertText', false, text);
}

/** Inserts a run of text ops at the caret. Leading/trailing spaces go in via execCommand because
 *  an HTML paste collapses whitespace at the edges of a paragraph. */
async function insertTextOps(editor: HTMLElement, key: string, ops: EditorOp[]): Promise<void> {
  const plain = opsToPlainText(ops);
  if (!plain) return;
  const [, lead, core, trail] = plain.match(/^([ \t]*)([\s\S]*?)([ \t]*)$/)!;
  execInsert(editor, key, lead);
  if (core) {
    const coreOps = trimOpsEdges(ops, lead.length, trail.length);
    const before = editorText(editor).length;
    guard(editor, key);
    const dt = new DataTransfer();
    dt.setData('text/plain', core);
    dt.setData('text/html', opsToPasteHtml(coreOps));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    editor.dispatchEvent(ev);
    // An editor that handled the paste calls preventDefault; give it time to render before
    // concluding it didn't take (falling back too early would insert the text twice).
    const grew = () => (editorText(editor).length > before ? true : null);
    const took = await pollFor(grew, ev.defaultPrevented ? 1_000 : 150, 50);
    if (!took) {
      console.debug('[wocoo-prefill] paste not taken; falling back to execCommand (first line only)');
      const { line, truncated } = fallbackLine(core);
      execInsert(editor, key, line);
      if (truncated) throw new PrefillPartial();
    }
  }
  execInsert(editor, key, trail);
}

function trimOpsEdges(ops: EditorOp[], lead: number, trail: number): EditorOp[] {
  const out = ops.map((o) => ({ ...o })) as EditorOp[];
  let n = lead;
  while (n > 0 && out.length) {
    const o = out[0];
    if (o.kind !== 'text') break;
    const cut = Math.min(n, o.text.length);
    o.text = o.text.slice(cut);
    n -= cut;
    if (!o.text) out.shift();
  }
  n = trail;
  while (n > 0 && out.length) {
    const o = out[out.length - 1];
    if (o.kind !== 'text') break;
    const cut = Math.min(n, o.text.length);
    o.text = o.text.slice(0, o.text.length - cut);
    n -= cut;
    if (!o.text) out.pop();
  }
  return out;
}

async function runEditorOps(editor: HTMLElement, key: string, ops: EditorOp[]): Promise<void> {
  // One paste for everything, mentions included (see the strategy note above).
  await insertTextOps(editor, key, ops.filter((o) => o.kind !== 'text' || o.text));
}

let prefillBusy = false;

async function handlePrefill(msg: PrefillCommentMessage): Promise<PrefillCommentReply> {
  if (currentTicketKey() !== msg.key) return { ok: true, inserted: false, reason: 'wrong-ticket' };
  // Automatic prefill never takes focus from a field the user is editing (opening the editor
  // clicks its placeholder, and inserting focuses it). An Insert draft click skips this check.
  if (msg.auto && isBusyElsewhere(describeFocus())) return { ok: true, inserted: false, reason: 'busy-elsewhere' };
  const editor = await openCommentEditor();
  if (!editor) return { ok: true, inserted: false, reason: 'no-editor' };
  // The page may have navigated while we waited.
  if (currentTicketKey() !== msg.key) return { ok: true, inserted: false, reason: 'wrong-ticket' };
  const existing = editorText(editor);
  if (!shouldPrefill(existing, msg.force)) return { ok: true, inserted: false, reason: 'not-empty' };
  const ops = segmentsToEditorOps(msg.segments);
  if (ops.length === 0) return { ok: true, inserted: false };
  // The editor wait can take seconds; the user may have started editing something meanwhile.
  if (msg.auto && isBusyElsewhere(describeFocus())) return { ok: true, inserted: false, reason: 'busy-elsewhere' };
  // The one place focus is set; from here on a focus change means the user moved and we stop.
  editor.focus();
  await sleep(50);
  if (!shouldPrefill(existing, false)) {
    // Forced over existing text: append after it, in a new paragraph.
    placeCaretAtEnd(editor);
    await sleep(50);
    ops.unshift({ kind: 'text', text: '\n\n' });
  } else {
    // Empty box: make sure there is a caret inside it (focus() alone may not set one).
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editor.contains(sel.anchorNode)) {
      placeCaretAtEnd(editor);
      await sleep(50);
    }
  }
  try {
    await runEditorOps(editor, msg.key, ops);
  } catch (e) {
    if (e instanceof PrefillInterrupted) {
      console.debug('[wocoo-prefill]', e.message);
      return { ok: true, inserted: false, reason: 'interrupted' };
    }
    if (e instanceof PrefillPartial) return { ok: true, inserted: true, reason: 'partial' };
    throw e;
  }
  return { ok: true, inserted: true };
}

// The signed-in user's Jira accountId, from the page's own meta tag. Sidekick's OAuth scopes
// don't cover /myself, so the side panel asks the page instead.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== JIRA_WHOAMI_MESSAGE || sender.id !== chrome.runtime.id) return;
  const id = document.querySelector<HTMLMetaElement>('meta[name="ajs-atlassian-account-id"]')?.content?.trim();
  sendResponse({ accountId: id || null });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== PREFILL_COMMENT_MESSAGE) return;
  if (sender.id !== chrome.runtime.id) return;
  if (prefillBusy) {
    sendResponse({ ok: false, inserted: false, error: 'A prefill is already running' } satisfies PrefillCommentReply);
    return;
  }
  prefillBusy = true;
  handlePrefill(msg as PrefillCommentMessage)
    .then(sendResponse, (e: unknown) => {
      sendResponse({ ok: false, inserted: false, error: e instanceof Error ? e.message : String(e) } satisfies PrefillCommentReply);
    })
    .finally(() => { prefillBusy = false; });
  return true; // reply asynchronously
});
