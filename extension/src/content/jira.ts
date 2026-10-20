// Runs on every wealthsimple.atlassian.net page. Watches the URL for a WOCOO ticket key
// (Jira is an SPA, so we listen for history.pushState as well as the initial load) and
// pushes the detected key to the service worker.
//
// Atlassian uses several URL shapes for a WOCOO ticket depending on board/queue/backlog
// view + new vs legacy product. Rather than enumerate, prefer the canonical patterns and
// fall back to "first WOCOO-N anywhere in the URL." Sticky behaviour in the service worker
// guarantees we never *clear* on a missed detection — only overwrite on a positive match.

import {
  PREFILL_COMMENT_MESSAGE, opsToPasteHtml, opsToPlainText, segmentsToEditorOps, shouldPrefill,
  type EditorOp, type PrefillCommentMessage, type PrefillCommentReply,
} from '../data/commentPrefill';

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
// Jira's comment editor UNSAVED, for the user to edit and Save himself.
//
// SAFETY: nothing here ever clicks Save, presses Enter / Cmd+Enter / Ctrl+Enter, or dispatches
// a submit. The only keystroke synthesised is Escape, and only to dismiss the "@" typeahead when
// the mentioned user's option never shows up.
//
// Insertion strategy (layered, no trusted typing available to a content script):
//   1. Open the editor by clicking the collapsed "Add a comment…" placeholder.
//   2. Text: a synthetic `paste` ClipboardEvent carrying text/plain + text/html. ProseMirror
//      reads event.clipboardData, so this inserts links and paragraphs in one step. If the editor
//      did not take it, fall back to document.execCommand('insertText') line by line.
//   3. Mentions: type "@" + the name with execCommand (ProseMirror sees it as typing, so the
//      mention typeahead opens), wait up to 3 s for the option whose accountId matches, click it.
//      No match -> the "@Name" stays as plain text.
// ------------------------------------------------------------

/** Every DOM hook the prefill relies on, in one place so they can be adjusted against the live
 *  Jira page. Lists are tried in order; the first visible match wins. */
export const JIRA_COMMENT_SELECTORS = {
  /** The collapsed "Add a comment…" box shown before the editor is mounted. */
  placeholder: [
    '[data-testid="canned-comments.common.ui.comment-text-area-placeholder.textarea"]',
    '[data-testid*="comment-text-area-placeholder" i]',
    '[data-testid*="comment" i][data-testid*="placeholder" i]',
    'textarea[placeholder^="Add a comment" i]',
    '[role="button"][aria-label^="Add a comment" i]',
  ],
  /** Text-content fallback for the placeholder when no selector above matches. */
  placeholderText: /^add a comment/i,
  /** Elements whose own text is checked against placeholderText. */
  placeholderTextCandidates: 'button, [role="button"], textarea, input, p, span, div[tabindex]',
  /** The ProseMirror contenteditable of an Atlassian editor. */
  editor: [
    '.ProseMirror[contenteditable="true"]',
    '#ak-editor-textarea[contenteditable="true"]',
    '[contenteditable="true"][aria-label*="comment" i]',
  ],
  /** An editor inside one of these is the comment editor. */
  commentAncestor: '[data-testid*="comment" i], [aria-label*="comment" i]',
  /** Never write into an editor inside one of these (the description editor, when open). */
  excludedAncestor: '[data-testid*="description" i]',
  /** Editor decorations whose text is not the user's (placeholder hints, widgets). */
  decorations: '.placeholder-decoration, .ProseMirror-widget, [data-testid="placeholder-test-id"]',
  /** The "@" typeahead popup. */
  mentionPopup: [
    '[data-testid="typeahead-popup"]',
    '[data-testid*="typeahead" i]',
    '[aria-label*="typeahead" i]',
    '[role="listbox"]',
  ],
  /** Attributes on a typeahead option (or its descendant) that carry the user's accountId. */
  mentionIdAttributes: ['data-mention-id', 'data-id'],
  /** Click target around a matched element. */
  mentionOption: '[role="option"], [data-testid*="typeahead-item" i]',
  /** A mention pill inside the editor (used to confirm a pick landed). */
  insertedMention: '[data-mention-id]',
} as const;

const PREFILL_EDITOR_WAIT_MS = 5_000;
const PREFILL_MENTION_WAIT_MS = 3_000;

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

function findCommentEditor(): HTMLElement | null {
  const S = JIRA_COMMENT_SELECTORS;
  const seen = new Set<HTMLElement>();
  const editors: HTMLElement[] = [];
  for (const sel of S.editor) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (seen.has(el) || !isShown(el) || !el.isContentEditable) continue;
      if (el.closest(S.excludedAncestor)) continue;
      seen.add(el);
      editors.push(el);
    }
  }
  const commentish = editors.find((el) => el.closest(S.commentAncestor));
  if (commentish) return commentish;
  return editors.length === 1 ? editors[0] : null;
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

/** Opens the comment editor if it is collapsed and waits for it (up to ~5 s). */
async function openCommentEditor(): Promise<HTMLElement | null> {
  let lastClick = 0;
  return pollFor(() => {
    const editor = findCommentEditor();
    if (editor) return editor;
    const ph = findCommentPlaceholder();
    if (ph && Date.now() - lastClick > 1_000) {
      lastClick = Date.now();
      ph.click();
      ph.focus?.();
    }
    return null;
  }, PREFILL_EDITOR_WAIT_MS, 150);
}

/** The user's text in the editor, without placeholder decorations. */
function editorText(editor: HTMLElement): string {
  const clone = editor.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(JIRA_COMMENT_SELECTORS.decorations).forEach((n) => n.remove());
  // Mention pills count as content even if they render their name in a pseudo-element.
  const pills = clone.querySelectorAll(JIRA_COMMENT_SELECTORS.insertedMention).length;
  return (clone.textContent || '') + (pills ? '@'.repeat(pills) : '');
}

function placeCaretAtEnd(editor: HTMLElement): void {
  editor.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const last = editor.lastElementChild ?? editor;
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Whether the character just before the caret is a space (Jira adds one after a mention). */
function spaceBeforeCaret(editor: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const caret = sel.getRangeAt(0);
  if (!editor.contains(caret.startContainer)) return false;
  const r = document.createRange();
  r.setStart(editor, 0);
  r.setEnd(caret.startContainer, caret.startOffset);
  return /[  ]$/.test(r.toString());
}

function execInsertLines(editor: HTMLElement, text: string): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    editor.focus();
    if (line) document.execCommand('insertText', false, line);
    if (i < lines.length - 1) document.execCommand('insertParagraph');
  });
}

/** Inserts a run of text ops at the caret. Leading/trailing spaces go in via execCommand because
 *  an HTML paste collapses whitespace at the edges of a paragraph. */
async function insertTextOps(editor: HTMLElement, ops: EditorOp[]): Promise<void> {
  const plain = opsToPlainText(ops);
  if (!plain) return;
  const m = plain.match(/^([ \t]*)([\s\S]*?)([ \t]*)$/)!;
  const [, lead, core, trail] = m;
  if (lead) execInsertLines(editor, lead);
  if (core) {
    // Trim the same edges off the ops before building the HTML side.
    const coreOps = trimOpsEdges(ops, lead.length, trail.length);
    const before = editorText(editor).length;
    editor.focus();
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
      console.debug('[wocoo-prefill] paste not taken; falling back to execCommand');
      execInsertLines(editor, core);
    }
  }
  if (trail) execInsertLines(editor, trail);
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

function findMentionOption(accountId: string): HTMLElement | null {
  const S = JIRA_COMMENT_SELECTORS;
  const id = CSS.escape(accountId);
  for (const sel of S.mentionPopup) {
    for (const popup of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!isShown(popup) || popup.isContentEditable || popup.closest('[contenteditable="true"]')) continue;
      for (const attr of S.mentionIdAttributes) {
        const hit = popup.querySelector<HTMLElement>(`[${attr}="${id}"]`);
        if (hit && isShown(hit)) return hit.closest<HTMLElement>(S.mentionOption) ?? hit;
      }
    }
  }
  return null;
}

/** Types "@query" through Jira's typeahead and picks the option for accountId.
 *  Returns false (leaving "@query" as plain text) if the option never appears. */
async function insertMention(editor: HTMLElement, query: string, accountId: string | undefined): Promise<boolean> {
  const S = JIRA_COMMENT_SELECTORS;
  if (!accountId) { execInsertLines(editor, '@' + query); return false; }
  const pillsBefore = editor.querySelectorAll(S.insertedMention).length;
  for (const ch of '@' + query) {
    editor.focus();
    document.execCommand('insertText', false, ch);
    await sleep(35);
  }
  const option = await pollFor(() => findMentionOption(accountId), PREFILL_MENTION_WAIT_MS, 100);
  if (!option) {
    console.debug('[wocoo-prefill] no typeahead option for', query, '- leaving plain text');
    if (firstShown(S.mentionPopup)) {
      // Dismiss the typeahead; it keeps the typed "@query" as text.
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      await sleep(80);
    }
    editor.focus();
    return false;
  }
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  if (option.isConnected) option.click();
  await pollFor(() => (editor.querySelectorAll(S.insertedMention).length > pillsBefore ? true : null), 1_200, 80);
  editor.focus();
  await sleep(60);
  return editor.querySelectorAll(S.insertedMention).length > pillsBefore;
}

async function runEditorOps(editor: HTMLElement, ops: EditorOp[]): Promise<void> {
  let i = 0;
  let afterMention = false;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'mention') {
      afterMention = await insertMention(editor, op.query, op.accountId);
      i++;
      continue;
    }
    const run: EditorOp[] = [];
    while (i < ops.length && ops[i].kind === 'text') run.push({ ...ops[i++] } as EditorOp);
    // Jira puts a space after a picked mention; don't double it.
    const first = run[0];
    if (afterMention && first.kind === 'text' && first.text.startsWith(' ') && spaceBeforeCaret(editor)) {
      first.text = first.text.slice(1);
    }
    afterMention = false;
    await insertTextOps(editor, run.filter((o) => o.kind !== 'text' || o.text));
  }
}

let prefillBusy = false;

async function handlePrefill(msg: PrefillCommentMessage): Promise<PrefillCommentReply> {
  if (currentTicketKey() !== msg.key) return { ok: true, inserted: false, reason: 'wrong-ticket' };
  const editor = await openCommentEditor();
  if (!editor) return { ok: true, inserted: false, reason: 'no-editor' };
  // The page may have navigated while we waited.
  if (currentTicketKey() !== msg.key) return { ok: true, inserted: false, reason: 'wrong-ticket' };
  const existing = editorText(editor);
  if (!shouldPrefill(existing, msg.force)) return { ok: true, inserted: false, reason: 'not-empty' };
  const ops = segmentsToEditorOps(msg.segments);
  if (ops.length === 0) return { ok: true, inserted: false };
  editor.focus();
  await sleep(50);
  if (!shouldPrefill(existing, false)) {
    // Forced over existing text: append after it, in a new paragraph.
    placeCaretAtEnd(editor);
    await sleep(50);
    ops.unshift({ kind: 'text', text: '\n\n' });
  }
  await runEditorOps(editor, ops);
  return { ok: true, inserted: true };
}

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
