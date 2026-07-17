// Inline non-modal prompt that appears in the sidepanel immediately after a Jira
// transition is detected (either from a sidepanel button click or the Jira DOM
// observer). The row has already been written by the transition handler; this
// component's job is to (optionally) fill in the note / tools / flags on that row.
//
// Non-modal means the user can dismiss this without losing anything — the bare-
// metadata row stays in the sheet. Dismissal creates an "unsaved chip" the user
// can click to bring the prompt back within 5 minutes (managed by the parent,
// SidePanel.tsx).

import { useState } from 'react';
import type { TicketTransitionKind } from '../data/ticketLogTypes';
import { updateTicketLogViaBridge } from '../api/bridge';

interface NotePromptProps {
  ticketId: string;
  kind: TicketTransitionKind;
  rowNumber: number;
  seedResolutionNote?: string;
  seedToolsUsed?: string;
  seedNovelPattern?: boolean;
  onSaved: () => void;
  onSkipped: () => void;
  onDismissed: () => void;
}

export function NotePrompt({
  ticketId,
  kind,
  rowNumber,
  seedResolutionNote = '',
  seedToolsUsed = '',
  seedNovelPattern = false,
  onSaved,
  onSkipped,
  onDismissed,
}: NotePromptProps) {
  const [note, setNote] = useState(seedResolutionNote);
  const [tools, setTools] = useState(seedToolsUsed);
  const [mistriaged, setMistriaged] = useState(false);
  const [novel, setNovel] = useState(seedNovelPattern);
  const [novelNote, setNovelNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateTicketLogViaBridge({
        rowNumber,
        resolutionNote: note,
        toolsUsed: tools,
        mistriaged,
        novelPattern: novel,
        novelNote: novel ? novelNote : '',
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <section
      style={{
        border: '1px solid var(--mint-border, #d0d5dd)',
        borderRadius: 8,
        padding: 12,
        margin: '12px 0',
        background: 'var(--mint-highlight-bg-soft, #f4f7fb)',
      }}
      aria-live="polite"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          Logged: {ticketId} → {kind}
        </div>
        <button
          onClick={onDismissed}
          style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', padding: 4 }}
          aria-label="Dismiss note prompt"
          title="Dismiss (metadata row is kept)"
        >
          ✕
        </button>
      </div>

      <label style={{ display: 'block', fontSize: 11, marginTop: 8, marginBottom: 2, color: 'var(--mint-fg-soft, #667085)' }}>
        Resolution note (optional)
      </label>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="One line about what you did"
        style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box' }}
      />

      <label style={{ display: 'block', fontSize: 11, marginTop: 8, marginBottom: 2, color: 'var(--mint-fg-soft, #667085)' }}>
        Tools used (optional — free text; paste SQL, URLs, Guru card titles)
      </label>
      <textarea
        value={tools}
        onChange={(e) => setTools(e.target.value)}
        rows={2}
        style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
      />

      <label style={{ display: 'flex', alignItems: 'center', marginTop: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={mistriaged}
          onChange={(e) => setMistriaged(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        Mistriaged (agent picked wrong work type)
      </label>

      <label style={{ display: 'flex', alignItems: 'center', marginTop: 4, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={novel}
          onChange={(e) => setNovel(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        Novel pattern — flag for source-of-truth update
      </label>

      {novel ? (
        <textarea
          value={novelNote}
          onChange={(e) => setNovelNote(e.target.value)}
          rows={2}
          placeholder="1-2 sentences on what was new"
          style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box', resize: 'vertical', marginTop: 4 }}
        />
      ) : null}

      {error ? (
        <div style={{ color: '#b42318', fontSize: 12, marginTop: 8 }}>
          Save failed: {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: 'var(--mint-highlight-fg-strong, #175cd3)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save & close'}
        </button>
        <button
          onClick={onSkipped}
          disabled={saving}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: 'transparent',
            color: 'var(--mint-fg-soft, #667085)',
            border: '1px solid var(--mint-border, #d0d5dd)',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Skip — log metadata only
        </button>
      </div>
    </section>
  );
}
