// Transcript Parser card. Paste a Zendesk-sourced transcript, click Parse,
// get back a Summary + Key Facts via the Apps Script bridge → MagicAI route.

import { useState } from 'react';
import { parseTranscriptViaBridge } from '../api/bridge';

type CardState = 'idle' | 'parsing' | 'parsed' | 'error';

const LONG_TRANSCRIPT_THRESHOLD = 12_000;

export function TranscriptCard() {
  const [state, setState] = useState<CardState>('idle');
  const [text, setText] = useState<string>('');
  const [summary, setSummary] = useState<string>('');
  const [keyFacts, setKeyFacts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onParse() {
    if (!text.trim()) return;
    setState('parsing');
    setError(null);
    try {
      const result = await parseTranscriptViaBridge(text);
      if (!result.summary && result.keyFacts.length === 0) {
        throw new Error('Couldn\'t parse the response. Try splitting the transcript in half.');
      }
      setSummary(result.summary);
      setKeyFacts(result.keyFacts);
      setState('parsed');
    } catch (e: any) {
      setError(e?.message || String(e));
      setState('error');
    }
  }

  function onReParse() {
    setState('idle');
    setSummary('');
    setKeyFacts([]);
    setError(null);
  }

  function onTryAgain() {
    setState('idle');
    setError(null);
  }

  const charCount = text.length;
  const tooLong = charCount > LONG_TRANSCRIPT_THRESHOLD;
  const parseDisabled = !text.trim() || state === 'parsing';

  return (
    <section style={cardBaseStyle}>
      <header style={cardHeaderStyle}>
        <span style={cardTitleStyle}>🗒️ Parse Zendesk Transcript</span>
        {state === 'parsed' ? (
          <button onClick={onReParse} style={textLinkStyle}>↻ Re-Parse</button>
        ) : null}
      </header>

      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        <textarea
          placeholder="Paste the Zendesk transcript here..."
          value={text}
          disabled={state === 'parsing'}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          style={textareaStyle}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          <span>{charCount.toLocaleString()} chars</span>
          {tooLong ? <span style={{ color: 'var(--mint-warning-fg-strong)' }}>Long transcript — consider splitting in half if MagicAI rejects.</span> : null}
        </div>

        {state === 'error' && error ? (
          <div style={errorBannerStyle}>
            <span>⚠ {error}</span>
            <button onClick={onTryAgain} style={textLinkStyle}>Try again</button>
          </div>
        ) : null}

        <button onClick={onParse} disabled={parseDisabled} style={{ ...primaryButtonStyle, opacity: parseDisabled ? 0.55 : 1, cursor: parseDisabled ? 'not-allowed' : 'pointer' }}>
          {state === 'parsing' ? 'Parsing…' : 'Parse'}
        </button>

        {state === 'parsed' ? (
          <>
            <OutputSection title="📞 Summary" content={summary} />
            <OutputSection title="🔑 Key Facts" content={keyFacts.length ? keyFacts.map((f) => '- ' + f).join('\n') : '(no key facts extracted)'} />
          </>
        ) : null}
      </div>
    </section>
  );
}

function OutputSection({ title, content }: { title: string; content: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!content || !navigator.clipboard) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div style={outputSectionStyle}>
      <div style={outputHeaderStyle}>
        <span style={{ fontWeight: 700, fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)' }}>{title}</span>
        <button onClick={copy} disabled={copied} style={copyPillStyle(copied)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre style={outputContentStyle}>{content}</pre>
    </div>
  );
}

// ===== styles =====

const cardBaseStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  overflow: 'hidden',
  boxShadow: 'var(--mint-card-shadow)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  borderBottom: 'var(--mint-card-stroke)',
};

const cardTitleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 'var(--mint-text-meta)',
  color: 'var(--mint-fg-strong)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--mint-sp-2)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
  lineHeight: 1.5,
  resize: 'vertical',
  minHeight: 120,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  border: 'none',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  alignSelf: 'flex-start',
};

const errorBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-meta)',
};

const outputSectionStyle: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
};

const outputHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
};

const outputContentStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  color: 'var(--mint-fg-strong)',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.5,
};

const copyPillStyle = (copied: boolean): React.CSSProperties => ({
  padding: '3px 10px',
  background: copied ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-bg-card)',
  color: copied ? '#fff' : 'var(--mint-positive-fg-strong)',
  border: '1px solid var(--mint-positive-fg-graphic)',
  borderRadius: 'var(--mint-radius-pill)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 700,
  cursor: copied ? 'default' : 'pointer',
});

const textLinkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--mint-highlight-fg-strong)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  cursor: 'pointer',
  padding: 0,
};
