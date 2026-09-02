// Copy-paste i2c ticket templates + Koho one-click email send.
// Templates started as v3's (wocoo-triage-v3 app-core.js) and have since dropped v3's
// internal-metadata header block — see buildI2cDraft. Koho send routes through the
// Apps Script bridge (Gmail MCP only drafts).

import { useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { sendKohoEmailViaBridge, logKohoSendViaBridge, logI2cSubmitViaBridge } from '../api/bridge';

const I2C_FORM_URL = 'https://tracking.i2cinc.com/servicedesk/customer/portal/2/create/17';
const KOHO_RECIPIENT = 'wealthsimplesupport@koho.ca';

// i2c reads these as a plain request from a colleague, so the draft is the ticket's own
// wording and nothing else — no work-type prefix on the summary, and no WOCOO link /
// Work Type / Priority header on the description. The internal metadata was noise to the
// vendor (and the Atlassian link isn't theirs to follow); it all stays in WOCOO.
function buildI2cDraft(t: WocooTicket): { summary: string; description: string } {
  return {
    summary: t.summary || '',
    description: t.description || '',
  };
}

// Same de-boilerplating as buildI2cDraft — the WOCOO link / Work Type / Priority block and
// the subject's [WOCOO-xxxxx] prefix are internal metadata Koho can't act on. The greeting
// and sign-off stay: unlike the i2c portal form, this one actually goes out as an email.
function buildKohoDraft(t: WocooTicket): { subject: string; body: string } {
  return {
    subject: t.summary || 'Prepaid Card Inquiry',
    body:
      'Hi Koho Support team,\n\n' +
      'We have a client inquiry regarding the following:\n\n' +
      (t.description || '') + '\n\n' +
      'Could you please investigate and let us know your findings?\n\n' +
      'Thank you,\nAlbert Cai',
  };
}

// ============================================================
// i2c card — copy-paste only
// ============================================================

export function I2cCard({ ticket }: { ticket: WocooTicket }) {
  const initial = buildI2cDraft(ticket);
  const [summary, setSummary] = useState(initial.summary);
  const [description, setDescription] = useState(initial.description);

  async function openAndFill() {
    try {
      await chrome.storage.local.set({
        pending_i2c_servicedesk_form: { summary, description },
      });
    } catch (e) {
      // Storage write rarely fails, but if it does the agent can still paste via Copy.
      console.warn('[wocoo-i2c-card] storage write failed:', e);
    }
    // Register the submission for reply-tracking. Fire-and-forget — form-open UX
    // shouldn't hinge on the tracking sheet write. Skip when the ticket has no
    // client email (nothing to search inbound emails by).
    if (ticket.clientEmail) {
      void logI2cSubmitViaBridge(ticket.id, ticket.clientEmail).catch((err) => {
        console.warn('[wocoo-i2c-card] logI2cSubmit failed:', err);
      });
    }
    window.open(I2C_FORM_URL, '_blank', 'noopener,noreferrer');
  }

  return (
    <section style={cardStyle}>
      <header style={cardHeader}>
        <span style={cardTitle}>🎫 i2c Ticket</span>
        <button type="button" onClick={openAndFill} style={openButtonStyle}>↗ Open &amp; Fill Form</button>
      </header>

      <FieldBlock label="Suggested Summary" value={summary} onChange={setSummary} rows={2} />
      <FieldBlock label="Suggested Description" value={description} onChange={setDescription} rows={8} />
    </section>
  );
}

// ============================================================
// Koho card — composer + Review → Confirm → Send → Sent
// ============================================================

type KohoState = 'idle' | 'confirming' | 'sending' | 'sent' | 'error';

export function KohoCard({ ticket }: { ticket: WocooTicket }) {
  const initial = buildKohoDraft(ticket);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [state, setState] = useState<KohoState>('idle');
  const [result, setResult] = useState<{ recipient: string; from: string; sentAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locked = state === 'sending' || state === 'sent';

  async function doSend() {
    setState('sending');
    setError(null);
    try {
      const r = await sendKohoEmailViaBridge({ ticketId: ticket.id, subject, body });
      setResult(r);
      setState('sent');
      // Register the send for reply-tracking. Fire-and-forget — a tracking-sheet
      // failure shouldn't roll back the successful send.
      void logKohoSendViaBridge(ticket.id, ticket.clientEmail).catch((err) => {
        console.warn('[wocoo-koho-card] logKohoSend failed:', err);
      });
    } catch (e: any) {
      setError(e?.message || String(e));
      setState('error');
    }
  }

  return (
    <section style={cardStyle}>
      <header style={cardHeader}>
        <span style={cardTitle}>✉️ Koho Email</span>
        <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>To: {KOHO_RECIPIENT}</span>
      </header>

      <FieldBlock label="Subject" value={subject} onChange={setSubject} rows={2} disabled={locked} />
      <FieldBlock label="Body" value={body} onChange={setBody} rows={10} disabled={locked} />

      {state === 'idle' || state === 'error' ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => setState('confirming')} disabled={!subject.trim() || !body.trim()} style={{ ...primaryBtn, flex: 1, opacity: !subject.trim() || !body.trim() ? 0.55 : 1, cursor: !subject.trim() || !body.trim() ? 'not-allowed' : 'pointer' }}>
            Review & Send Email
          </button>
        </div>
      ) : null}

      {state === 'confirming' ? (
        <div style={confirmBox}>
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-warning-fg-strong)', fontWeight: 600, marginBottom: 8 }}>
            Send this email to <strong>{KOHO_RECIPIENT}</strong>?
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={doSend} style={{ ...primaryBtn, flex: 1 }}>✓ Confirm Send</button>
            <button onClick={() => setState('idle')} style={secondaryBtn}>Back to Edit</button>
          </div>
        </div>
      ) : null}

      {state === 'sending' ? (
        <div style={{ marginTop: 8, fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>Sending…</div>
      ) : null}

      {state === 'sent' && result ? (
        <div style={sentBox}>
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-positive-fg-strong)', fontWeight: 700, marginBottom: 4 }}>✓ Email sent to Koho</div>
          <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)' }}>
            <div>To: {result.recipient}</div>
            <div>From: {result.from}</div>
            <div>At: {result.sentAt}</div>
          </div>
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            A copy is in the sender's Gmail Sent folder.
          </div>
        </div>
      ) : null}

      {state === 'error' && error ? (
        <div style={errorBox}>Send failed: {error}</div>
      ) : null}
    </section>
  );
}

// ============================================================
// shared primitives
// ============================================================

function FieldBlock({ label, value, onChange, rows, disabled }: { label: string; value: string; onChange: (v: string) => void; rows: number; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div style={{ marginTop: 'var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={fieldLabel}>{label}</span>
        <button onClick={copy} disabled={copied} style={copyPill(copied)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        style={{
          width: '100%',
          padding: 'var(--mint-sp-2)',
          fontFamily: 'var(--mint-font-family)',
          fontSize: 'var(--mint-text-micro)',
          border: 'var(--mint-card-stroke)',
          borderRadius: 'var(--mint-radius-button)',
          background: disabled ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
          boxSizing: 'border-box',
          lineHeight: 1.5,
          color: 'var(--mint-fg-strong)',
          resize: 'vertical',
        }}
      />
    </div>
  );
}

// ============================================================
// styles
// ============================================================

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
};

const cardHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  marginBottom: 'var(--mint-sp-2)',
};

const cardTitle: React.CSSProperties = {
  fontSize: 'var(--mint-text-body)',
  fontWeight: 700,
  color: 'var(--mint-fg-strong)',
};

const openLinkStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'var(--mint-warning-bg-soft)',
  color: 'var(--mint-warning-fg-strong)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-pill)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 700,
  textDecoration: 'none',
};

const openButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'var(--mint-warning-bg-soft)',
  color: 'var(--mint-warning-fg-strong)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-pill)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 700,
  cursor: 'pointer',
};

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--mint-fg-soft)',
  fontWeight: 700,
};

function copyPill(copied: boolean): React.CSSProperties {
  return {
    padding: '3px 10px',
    background: copied ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-bg-card)',
    color: copied ? '#fff' : 'var(--mint-positive-fg-strong)',
    border: '1px solid var(--mint-positive-fg-graphic)',
    borderRadius: 'var(--mint-radius-pill)',
    fontSize: 'var(--mint-text-nano)',
    fontWeight: 700,
    cursor: copied ? 'default' : 'pointer',
  };
}

const primaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  border: 'none',
  fontSize: 'var(--mint-text-meta)',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  border: 'var(--mint-card-stroke)',
  fontSize: 'var(--mint-text-meta)',
  fontWeight: 600,
  cursor: 'pointer',
};

const confirmBox: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-warning-bg-soft)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
};

const sentBox: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-positive-bg-soft)',
  border: '1px solid var(--mint-positive-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
};

const errorBox: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: '6px 10px',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  fontSize: 'var(--mint-text-micro)',
  borderRadius: 'var(--mint-radius-button)',
};
