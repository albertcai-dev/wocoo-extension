import { describe, expect, it } from 'vitest';
import { opsToPasteHtml, segmentsToEditorOps, shouldPrefill, textToHtml } from './commentPrefill';
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
