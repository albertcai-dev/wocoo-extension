import { describe, expect, it } from 'vitest';
import { JIRA_COMMENT_SELECTORS } from './jiraCommentSelectors';
import {
  fallbackLine, insertionBlocker, opsToPasteHtml, readInsertionState, segmentsToEditorOps, shouldPrefill, textToHtml,
  isBusyElsewhere, type FocusedElementInfo,
  INITIAL_PREFILL_RETRY, afterPrefillReply, afterTicketShown,
} from './commentPrefill';
import type { DraftSegment } from './agentDraftTypes';

describe('shouldPrefill', () => {
  it('is false when the box already has text', () => {
    expect(shouldPrefill('I was typing this', false)).toBe(false);
  });

  it('is true when force is set, even over existing text', () => {
    expect(shouldPrefill('I was typing this', true)).toBe(true);
  });

  it('is true for an empty box', () => {
    expect(shouldPrefill('', false)).toBe(true);
  });

  it('treats a whitespace-only box as empty', () => {
    expect(shouldPrefill('  \n\t   ', false)).toBe(true);
  });
});

describe('segmentsToEditorOps', () => {
  it('splits mentions out of the text', () => {
    const segs: DraftSegment[] = [
      { type: 'text', text: 'Hi ' },
      { type: 'mention', text: '@Test Person', accountId: 'acct-1' },
      { type: 'text', text: ', thanks for checking.' },
    ];
    expect(segmentsToEditorOps(segs)).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', query: 'Test Person', accountId: 'acct-1' },
      { kind: 'text', text: ', thanks for checking.' },
    ]);
  });

  it('never turns a mention without an accountId into a mention op', () => {
    const segs: DraftSegment[] = [
      { type: 'text', text: 'Looping in ' },
      { type: 'mention', text: '@Someone Else' },
      { type: 'text', text: ' here.' },
    ];
    const ops = segmentsToEditorOps(segs);
    expect(ops.some((o) => o.kind === 'mention')).toBe(false);
    expect(ops).toEqual([{ kind: 'text', text: 'Looping in @Someone Else here.' }]);
  });

  it('keeps link targets and renders smartcards as their href', () => {
    const segs: DraftSegment[] = [
      { type: 'text', text: 'See ' },
      { type: 'link', text: 'the guide', href: 'https://example.com/guide' },
      { type: 'text', text: '\n\n' },
      { type: 'smartcard', text: '', href: 'https://example.com/card' },
    ];
    expect(segmentsToEditorOps(segs)).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'text', text: 'the guide', href: 'https://example.com/guide' },
      { kind: 'text', text: '\n\n' },
      { kind: 'text', text: 'https://example.com/card', href: 'https://example.com/card' },
    ]);
  });

  it('drops empty segments and merges adjacent plain text', () => {
    const segs: DraftSegment[] = [
      { type: 'text', text: '' },
      { type: 'text', text: 'One ' },
      { type: 'text', text: 'two' },
      { type: 'link', text: 'no href' },
    ];
    expect(segmentsToEditorOps(segs)).toEqual([{ kind: 'text', text: 'One twono href' }]);
  });
});

describe('textToHtml', () => {
  it('escapes markup', () => {
    expect(textToHtml('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;');
  });

  it('turns blank lines into paragraph breaks and single newlines into <br>', () => {
    expect(textToHtml('one\ntwo\n\nthree')).toBe('one<br>two</p><p>three');
  });
});

describe('opsToPasteHtml', () => {
  it('wraps text runs in a paragraph and links in anchors', () => {
    expect(opsToPasteHtml([
      { kind: 'text', text: 'See ' },
      { kind: 'text', text: 'here', href: 'https://example.com/?a=1&b=2' },
    ])).toBe('<p>See <a href="https://example.com/?a=1&amp;b=2">here</a></p>');
  });
});

describe('opsToPasteHtml mentions', () => {
  it('pastes a resolved mention as an Atlassian mention span', () => {
    expect(opsToPasteHtml([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', query: 'Pat Doe', accountId: 'acc-1' },
      { kind: 'text', text: ', thanks' },
    ])).toBe('<p>Hi <span data-mention-id="acc-1" data-access-level="" data-text="@Pat Doe" contenteditable="false">@Pat Doe</span>, thanks</p>');
  });

  it('escapes the id and the name', () => {
    expect(opsToPasteHtml([{ kind: 'mention', query: 'A<b>', accountId: 'x"y' }]))
      .toBe('<p><span data-mention-id="x&quot;y" data-access-level="" data-text="@A&lt;b&gt;" contenteditable="false">@A&lt;b&gt;</span></p>');
  });

  it('pastes an unresolved mention as plain text', () => {
    expect(opsToPasteHtml([{ kind: 'mention', query: 'Pat Doe' }])).toBe('<p>@Pat Doe</p>');
  });
});

describe('opsToPasteHtml href safety', () => {
  it('pastes a non-http(s) href as plain text, not an anchor', () => {
    expect(opsToPasteHtml([{ kind: 'text', text: 'click', href: 'javascript:alert(1)' }])).toBe('<p>click</p>');
  });
});

// --- insertion guard (fake DOM) ----------------------------------------------------------

function fakeDom(opts: {
  connected?: boolean;
  focusInside?: boolean;
  selection?: 'caret' | 'range' | 'none' | 'outside';
  textAfter?: string;
} = {}) {
  const inside = { id: 'inside' };
  const outside = { id: 'outside' };
  const editor = {
    isConnected: opts.connected ?? true,
    contains: (n: unknown) => n === inside,
  };
  const sel = opts.selection ?? 'caret';
  const selection = sel === 'none' ? null : {
    rangeCount: 1,
    isCollapsed: sel !== 'range',
    anchorNode: sel === 'outside' ? outside : inside,
    focusNode: sel === 'outside' ? outside : inside,
  };
  return {
    editor,
    activeElement: (opts.focusInside ?? true) ? inside : outside,
    selection,
    textAfterCaret: () => opts.textAfter ?? '',
  };
}

describe('insertionBlocker(readInsertionState(...))', () => {
  const check = (dom: ReturnType<typeof fakeDom>, key = 'WOCOO-1', expected = 'WOCOO-1') =>
    insertionBlocker(readInsertionState({ ...dom, currentKey: key }), expected);

  it('allows a collapsed caret at the end of a focused, connected editor on the right ticket', () => {
    expect(check(fakeDom())).toBeNull();
  });

  it('ignores decoration-free whitespace after the caret', () => {
    expect(check(fakeDom({ textAfter: ' ​\n' }))).toBeNull();
  });

  it('blocks when the editor was removed from the page', () => {
    expect(check(fakeDom({ connected: false }))).toBe('editor-gone');
  });

  it('blocks when focus moved out of the editor', () => {
    expect(check(fakeDom({ focusInside: false }))).toBe('focus-lost');
  });

  it('blocks when the page moved to another ticket', () => {
    expect(check(fakeDom(), 'WOCOO-2')).toBe('ticket-changed');
    expect(check(fakeDom(), null as unknown as string)).toBe('ticket-changed');
  });

  it('blocks when there is no selection, or it sits outside the editor', () => {
    expect(check(fakeDom({ selection: 'none' }))).toBe('no-caret');
    expect(check(fakeDom({ selection: 'outside' }))).toBe('no-caret');
  });

  it('never replaces a selected range', () => {
    expect(check(fakeDom({ selection: 'range' }))).toBe('selection-range');
  });

  it('blocks when the caret is no longer at the end of the insertion point', () => {
    expect(check(fakeDom({ textAfter: 'text the user clicked before' }))).toBe('caret-moved');
  });
});

describe('fallbackLine', () => {
  it('passes single-line text through untruncated', () => {
    expect(fallbackLine('just one line')).toEqual({ line: 'just one line', truncated: false });
  });

  it('keeps only the first non-empty line of multi-line text', () => {
    expect(fallbackLine('\n\nfirst para\nsecond line\n\nthird')).toEqual({ line: 'first para', truncated: true });
  });

  it('marks trailing newlines alone as truncation-free', () => {
    expect(fallbackLine('only this\n')).toEqual({ line: 'only this', truncated: false });
  });
});

describe('isBusyElsewhere (M3: never steal focus from an inline edit)', () => {
  const el = (over: Partial<FocusedElementInfo>): FocusedElementInfo =>
    ({ tagName: 'DIV', isContentEditable: false, inNewComment: false, ...over });

  it('is false with nothing focused', () => {
    expect(isBusyElsewhere(null)).toBe(false);
    expect(isBusyElsewhere(el({ tagName: 'BODY' }))).toBe(false);
  });

  it('is true for a text input, textarea or contenteditable outside the new-comment editor', () => {
    expect(isBusyElsewhere(el({ tagName: 'INPUT', inputType: 'text' }))).toBe(true);
    expect(isBusyElsewhere(el({ tagName: 'INPUT' }))).toBe(true);
    expect(isBusyElsewhere(el({ tagName: 'INPUT', inputType: 'search' }))).toBe(true);
    expect(isBusyElsewhere(el({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isBusyElsewhere(el({ isContentEditable: true }))).toBe(true);
  });

  it('is false inside the new-comment editor or its placeholder', () => {
    expect(isBusyElsewhere(el({ isContentEditable: true, inNewComment: true }))).toBe(false);
    expect(isBusyElsewhere(el({ tagName: 'TEXTAREA', inNewComment: true }))).toBe(false);
  });

  it('is false for non-text controls (buttons, checkboxes, links)', () => {
    expect(isBusyElsewhere(el({ tagName: 'BUTTON' }))).toBe(false);
    expect(isBusyElsewhere(el({ tagName: 'A' }))).toBe(false);
    expect(isBusyElsewhere(el({ tagName: 'INPUT', inputType: 'checkbox' }))).toBe(false);
    expect(isBusyElsewhere(el({ tagName: 'INPUT', inputType: 'button' }))).toBe(false);
  });
});

describe('JIRA_COMMENT_SELECTORS.mentionOptionScopes (M2)', () => {
  it('is scoped to typeahead popups only, never a bare listbox', () => {
    expect(JIRA_COMMENT_SELECTORS.mentionOptionScopes).not.toContain('[role="listbox"]');
    expect([...JIRA_COMMENT_SELECTORS.mentionOptionScopes]).toEqual([...JIRA_COMMENT_SELECTORS.typeaheadPopup]);
  });
});

describe('prefill retry after the Jira tab catches up (I6)', () => {
  const missed = { ok: true, inserted: false, reason: 'wrong-ticket' } as const;

  it('a missed automatic prefill waits for this ticket to show, then retries once', () => {
    let r = afterPrefillReply(INITIAL_PREFILL_RETRY, missed, true);
    expect(r.retryNow).toBe(false);
    const t = afterTicketShown(r.state);
    expect(t.retryNow).toBe(true);
    // The retry misses again: no further retries.
    r = afterPrefillReply(t.state, missed, true);
    expect(r.retryNow).toBe(false);
    expect(afterTicketShown(r.state).retryNow).toBe(false);
  });

  it('retries straight away when the ticket was already reported before the reply came back', () => {
    const shown = afterTicketShown(INITIAL_PREFILL_RETRY);
    expect(shown.retryNow).toBe(false);
    expect(afterPrefillReply(shown.state, missed, true).retryNow).toBe(true);
  });

  it('an unreachable tab (null reply, e.g. mid-navigation) counts as a miss', () => {
    const r = afterPrefillReply(INITIAL_PREFILL_RETRY, null, true);
    expect(afterTicketShown(r.state).retryNow).toBe(true);
  });

  it('never retries an Insert draft click or a prefill that did not miss', () => {
    expect(afterTicketShown(afterPrefillReply(INITIAL_PREFILL_RETRY, missed, false).state).retryNow).toBe(false);
    for (const reply of [
      { ok: true, inserted: true } as const,
      { ok: true, inserted: false, reason: 'not-empty' } as const,
      { ok: true, inserted: false, reason: 'busy-elsewhere' } as const,
      { ok: false, inserted: false, error: 'busy' } as const,
    ]) {
      expect(afterTicketShown(afterPrefillReply(INITIAL_PREFILL_RETRY, reply, true).state).retryNow).toBe(false);
    }
  });
});
