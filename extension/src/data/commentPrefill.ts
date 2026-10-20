// Pure helpers for pre-filling Jira's comment box with an agent draft. The side panel sends the
// (mention-resolved) draft segments to the Jira content script, which turns them into editor
// operations and inserts them into the comment editor WITHOUT saving it.

import type { DraftSegment } from './agentDraftTypes';
import { isHttpUrl } from './agentDraftView';

/** One insertion step in the comment editor. A text op with `href` is pasted as a link.
 *  A mention op is typed through Jira's own "@" typeahead and picked by accountId. */
export type EditorOp =
  | { kind: 'text'; text: string; href?: string }
  | { kind: 'mention'; query: string; accountId?: string };

/** Side panel -> Jira content script. */
export interface PrefillCommentMessage {
  type: 'wocoo:prefill-comment';
  key: string;
  segments: DraftSegment[];
  force: boolean;
}

/** Why nothing was inserted. 'interrupted' = focus, caret, page or ticket changed mid-insert, so
 *  the box may hold part of the draft. */
export type PrefillSkipReason = 'not-empty' | 'no-editor' | 'wrong-ticket' | 'interrupted';

/** Content script -> side panel. `ok:false` only for a busy content script or an unexpected error.
 *  `inserted:true, reason:'partial'` = only the first paragraph went in (execCommand fallback). */
export type PrefillCommentReply =
  | { ok: true; inserted: false; reason?: PrefillSkipReason }
  | { ok: true; inserted: true; reason?: 'partial' }
  | { ok: false; inserted: false; error: string };

export const PREFILL_COMMENT_MESSAGE = 'wocoo:prefill-comment' as const;

/** Whether to insert: only into a box with no real text, unless forced. Zero-width characters
 *  editors leave behind count as empty. */
export function shouldPrefill(editorText: string, force: boolean): boolean {
  if (force) return true;
  return editorText.replace(/[​‌‍﻿]/g, '').trim() === '';
}

/** Draft segments -> editor ops. Only a mention that carries an accountId becomes a mention op;
 *  an unresolved one is plain "@Name" text. Smartcards are inserted as their URL. Adjacent plain
 *  text is merged and empty pieces dropped. */
export function segmentsToEditorOps(segments: DraftSegment[]): EditorOp[] {
  const ops: EditorOp[] = [];
  const pushText = (text: string, href?: string) => {
    if (!text) return;
    const last = ops[ops.length - 1];
    if (!href && last && last.kind === 'text' && !last.href) {
      last.text += text;
      return;
    }
    ops.push(href ? { kind: 'text', text, href } : { kind: 'text', text });
  };
  for (const s of segments) {
    if (s.type === 'mention' && s.accountId) {
      const query = (s.text ?? '').replace(/^@/, '').trim();
      if (query) {
        ops.push({ kind: 'mention', query, accountId: s.accountId });
        continue;
      }
    }
    if (s.type === 'smartcard') {
      const url = s.href || s.text || '';
      pushText(url, s.href || undefined);
      continue;
    }
    if (s.type === 'link' && s.href) {
      pushText(s.text || s.href, s.href);
      continue;
    }
    pushText(s.text ?? '');
  }
  return ops;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escaped HTML for a run of text that sits inside a <p>: blank lines close the paragraph and
 *  open a new one, single newlines become <br>. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((para) => para.split('\n').map(escapeHtml).join('<br>'))
    .join('</p><p>');
}

/** HTML for the text/html side of a synthetic paste: the ops' text in paragraphs, links as anchors.
 *  Mention ops (which the content script types separately) render as plain "@query". */
export function opsToPasteHtml(ops: EditorOp[]): string {
  const body = ops.map((op) => {
    if (op.kind === 'mention') return escapeHtml('@' + op.query);
    const inner = textToHtml(op.text);
    return op.href && isHttpUrl(op.href) ? `<a href="${escapeHtml(op.href)}">${inner}</a>` : inner;
  }).join('');
  return `<p>${body}</p>`;
}

/** The text/plain side of a synthetic paste. */
export function opsToPlainText(ops: EditorOp[]): string {
  return ops.map((op) => (op.kind === 'mention' ? '@' + op.query : op.text)).join('');
}

/** For the execCommand fallback, which must not create paragraphs (that would need an
 *  insertParagraph, i.e. a synthetic Enter): the first non-empty line, and whether more followed. */
export function fallbackLine(text: string): { line: string; truncated: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.trim() !== '');
  if (at < 0) return { line: '', truncated: false };
  const truncated = lines.slice(at + 1).some((l) => l.trim() !== '');
  return { line: lines[at], truncated };
}

// --- insertion guard ---------------------------------------------------------------------
// Checked before every paste, execCommand and typed character, so text never lands somewhere
// the user moved to while the insert was running.

/** Snapshot of where an insertion would land. */
export interface InsertionState {
  editorConnected: boolean;
  focusInEditor: boolean;
  currentKey: string | null;
  /** null when there is no selection inside the editor. */
  caret: { collapsed: boolean; textAfter: string } | null;
}

export type InsertionBlock = 'editor-gone' | 'focus-lost' | 'ticket-changed' | 'no-caret' | 'selection-range' | 'caret-moved';

/** The minimal DOM surface readInsertionState needs (real DOM in the content script, fakes in tests). */
export interface InsertionDom {
  editor: { isConnected: boolean; contains(node: unknown): boolean };
  activeElement: unknown;
  selection: { rangeCount: number; isCollapsed: boolean; anchorNode: unknown; focusNode: unknown } | null;
  currentKey: string | null;
  /** The user's text after the caret inside the editor, decorations removed. */
  textAfterCaret: () => string;
}

export function readInsertionState(dom: InsertionDom): InsertionState {
  const sel = dom.selection;
  const inEditor = !!sel && sel.rangeCount > 0 && dom.editor.contains(sel.anchorNode) && dom.editor.contains(sel.focusNode);
  return {
    editorConnected: dom.editor.isConnected,
    focusInEditor: dom.activeElement != null && dom.editor.contains(dom.activeElement),
    currentKey: dom.currentKey,
    caret: inEditor ? { collapsed: sel!.isCollapsed, textAfter: dom.textAfterCaret() } : null,
  };
}

/** null when it is safe to insert; otherwise why not. We only ever append, so the caret must be a
 *  collapsed caret with nothing but whitespace after it. A selected range is never replaced. */
export function insertionBlocker(s: InsertionState, expectedKey: string): InsertionBlock | null {
  if (!s.editorConnected) return 'editor-gone';
  if (s.currentKey !== expectedKey) return 'ticket-changed';
  if (!s.focusInEditor) return 'focus-lost';
  if (!s.caret) return 'no-caret';
  if (!s.caret.collapsed) return 'selection-range';
  if (s.caret.textAfter.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim() !== '') return 'caret-moved';
  return null;
}
