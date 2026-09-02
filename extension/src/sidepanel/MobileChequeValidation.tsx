// Mobile Cheque Validation tile + modal — Home view tool.
//
// Hybrid architecture: Apps Script bridge does Gmail + Sheet + totals work; this UI
// shows the assembled Slack message so you can review/edit and send it as a DM to
// yourself via a Workflow Builder webhook. You then copy from your Slack DMs into
// the correct channel manually (which lets you re-form mention pills naturally).
//
// The tile is idle by default — no bridge call happens until you click it. This keeps
// the Apps Script tab from opening every time you open the side panel.

import { useEffect, useMemo, useState } from 'react';
import {
  runMobileChequeValidationViaBridge,
  getMobileChequeValidationStatusViaBridge,
  markMobileChequeValidationSentViaBridge,
  type MCVRecord,
} from '../api/bridge';
import {
  MCV_ANOMALY_WEBHOOK_URL,
  MCV_ANOMALY_WEBHOOK_VAR,
  MCV_READY_WEBHOOK_URL,
  MCV_READY_WEBHOOK_VARS,
  buildMCVMessage,
  buildMCVAnomalyDM,
  formatMCVDate,
} from '../data/chequeValidationConfig';

export function MobileChequeValidationTile() {
  const [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<MCVRecord | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleClick() {
    if (loading) return;
    setLoading(true); setErr(null);
    try {
      const status = await getMobileChequeValidationStatusViaBridge();
      let rec = status.record;
      if (!rec) {
        // No record yet for today (browser closed at 9 AM, alarm skipped, first run
        // of the day). Trigger the bridge synchronously — user just asked for it.
        rec = await runMobileChequeValidationViaBridge();
      }
      setRecord(rec);
      setModalOpen(true);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const subtitle = loading
    ? 'Checking today\'s status…'
    : err
    ? `⚠ ${err}`
    : 'Click to check today\'s validation and send yourself the Slack DM.';

  return (
    <>
      <button
        onClick={handleClick}
        disabled={loading}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: 'var(--mint-sp-3)',
          background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)',
          borderRadius: 'var(--mint-radius-card)',
          textAlign: 'left', cursor: loading ? 'wait' : 'pointer', width: '100%', boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: 22, lineHeight: 1 }}>📋</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Mobile Cheque Validation</span>
          <span style={{
            fontSize: 'var(--mint-text-nano)',
            color: err ? 'var(--mint-negative-fg-strong)' : 'var(--mint-fg-soft)',
            lineHeight: 1.45,
          }}>{subtitle}</span>
        </span>
      </button>

      {modalOpen && record ? (
        <MCVModal
          record={record}
          onClose={() => setModalOpen(false)}
          onSent={() => {
            setModalOpen(false);
            setRecord((prev) => (prev ? { ...prev, sentAt: new Date().toISOString() } : prev));
          }}
        />
      ) : null}
    </>
  );
}

// ============================================================
// Modal — shows the assembled message and sends it to your Slack DMs via WB webhook.
// ============================================================

function MCVModal({ record, onClose, onSent }: { record: MCVRecord; onClose: () => void; onSent: () => void }) {
  const isAnomaly = record.status === 'anomaly';
  // Slack post header shows today's local date (not the validated batch's date).
  const todayLocal = new Date();
  const messageDateKey = todayLocal.getFullYear() + '-' +
    String(todayLocal.getMonth() + 1).padStart(2, '0') + '-' +
    String(todayLocal.getDate()).padStart(2, '0');

  // Anomaly override: when Albert has manually confirmed the P/Q formula errors reflect
  // sheet formulas breaking (not actual cheque-processing failures), let him send the
  // clean Ready-style DM instead — bumping processedCount by the pq_errors row count so
  // the message reads "75/75" instead of "75/74". Other anomaly kinds (day1_unreversed,
  // count_mismatch) are unaffected by this toggle — their totals aren't shifted.
  const pqErrorCount = useMemo(() => {
    const a = record.anomalies.find((x) => x.kind === 'pq_errors');
    if (!a) return 0;
    const m = String(a.detail || '').match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }, [record.anomalies]);
  const [overrideAsReady, setOverrideAsReady] = useState(false);
  const effectiveIsAnomaly = isAnomaly && !overrideAsReady;
  const effectiveTotals = useMemo(
    () => ({
      ...record.totals,
      processedCount: record.totals.processedCount + (overrideAsReady ? pqErrorCount : 0),
    }),
    [record.totals, overrideAsReady, pqErrorCount],
  );
  const initialText = useMemo(
    () => effectiveIsAnomaly
      ? buildMCVAnomalyDM(messageDateKey, record.anomalies)
      : buildMCVMessage(messageDateKey, effectiveTotals),
    [effectiveIsAnomaly, messageDateKey, record.anomalies, effectiveTotals],
  );
  const [text, setText] = useState<string>(initialText);
  // Reset the textarea contents when the underlying template flips (override toggle,
  // or record change). Any manual edits made against the previous template are dropped.
  useEffect(() => { setText(initialText); }, [initialText]);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doSend() {
    setConfirming(false);
    setSending(true); setErr(null);
    try {
      // Two webhook paths — different message shapes.
      //   Anomaly path: single text variable, the full assembled anomaly body.
      //   Ready path: structured 6-variable payload. Bold header + 15 mention pills are
      //     baked into the workflow itself, so we only ship the dynamic bits.
      const url = effectiveIsAnomaly ? MCV_ANOMALY_WEBHOOK_URL : MCV_READY_WEBHOOK_URL;
      const payload = effectiveIsAnomaly
        ? { [MCV_ANOMALY_WEBHOOK_VAR]: text }
        : {
            [MCV_READY_WEBHOOK_VARS.date]: formatMCVDate(messageDateKey),
            [MCV_READY_WEBHOOK_VARS.received]: String(effectiveTotals.receivedCount),
            [MCV_READY_WEBHOOK_VARS.processed]: String(effectiveTotals.processedCount),
            [MCV_READY_WEBHOOK_VARS.day1]: String(effectiveTotals.day1Reversed),
            [MCV_READY_WEBHOOK_VARS.opsBreach]: String(effectiveTotals.opsSlaBreach),
            [MCV_READY_WEBHOOK_VARS.riskBreach]: String(effectiveTotals.riskSlaBreach),
          };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // WB returns 200 on success; anything else means either the URL is wrong or the
        // variable names in the payload don't match what the workflow declared.
        throw new Error(`Webhook returned HTTP ${res.status}. Check the ${effectiveIsAnomaly ? 'anomaly' : 'ready'} webhook URL + workflow variable names.`);
      }
      await markMobileChequeValidationSentViaBridge(record.date);
      onSent();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--mint-sp-3)' }}>
      <div style={{ background: 'var(--mint-bg-card)', borderRadius: 'var(--mint-radius-card)', maxWidth: 520, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)' }}>
            {effectiveIsAnomaly
              ? '⚠ Anomaly — Review & send DM'
              : isAnomaly
              ? '📋 Validation (override) — Review & send DM'
              : '📋 Validation — Review & send DM'}
          </h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--mint-fg-soft)' }}>×</button>
        </div>

        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.45 }}>
          {effectiveIsAnomaly
            ? `Sends the anomaly text below as a Slack DM to you. Edit if needed. Copy-paste from your DMs into the correct channel afterward.`
            : `Sends a Slack DM to you with the values below. The actual DM renders with a bold first line and real @-mention pills for the 15 cc'd folks (baked into the workflow, not shown in preview). Copy-paste from your DMs into the channel — pills carry over automatically.`}
        </div>

        {record.sentAt ? (
          <div style={{ padding: '6px 10px', background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)' }}>
            ✓ Already sent {new Date(record.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} today. Sending again will DM you a fresh copy.
          </div>
        ) : null}

        {(record.notes || []).length > 0 ? (
          <ul style={{ margin: 0, padding: '8px 12px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', listStyle: 'disc', paddingLeft: 24, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
            {(record.notes || []).map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        ) : null}

        {isAnomaly ? (
          <>
            <ul style={{ margin: 0, padding: '8px 12px', background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', listStyle: 'disc', paddingLeft: 24, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)' }}>
              {record.anomalies.map((a, i) => <li key={i}><strong>{a.kind}:</strong> {a.detail}</li>)}
            </ul>
            {pqErrorCount > 0 ? (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', cursor: 'pointer', lineHeight: 1.45 }}>
                <input
                  type="checkbox"
                  checked={overrideAsReady}
                  onChange={(e) => setOverrideAsReady(e.target.checked)}
                  disabled={sending || confirming}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <span>
                  <strong>Force send Ready-style DM</strong> — count the {pqErrorCount} pq_errors row{pqErrorCount === 1 ? '' : 's'} as processed (bumps <code>processedCount</code> from {record.totals.processedCount} to {record.totals.processedCount + pqErrorCount}). Use only after you've manually verified those cheques were actually reversed and the P/Q errors are just broken sheet formulas.
                </span>
              </label>
            ) : null}
          </>
        ) : null}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          readOnly={!effectiveIsAnomaly}
          style={{
            width: '100%', padding: '10px 12px',
            fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)',
            border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)',
            background: effectiveIsAnomaly ? 'var(--mint-bg-card)' : 'var(--mint-bg-subtle)',
            color: 'var(--mint-fg-strong)', boxSizing: 'border-box', lineHeight: 1.45, resize: 'vertical',
            cursor: !effectiveIsAnomaly ? 'default' : 'text',
          }}
          disabled={sending || confirming}
          aria-label={effectiveIsAnomaly ? 'Anomaly message body (editable)' : 'Ready message preview (read-only — actual DM has bold + mention pills)'}
        />

        {err ? (
          <div role="alert" style={{ padding: 8, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>{err}</div>
        ) : null}

        {confirming ? (
          <div style={{ padding: '10px 12px', background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', lineHeight: 1.45 }}>
            <strong>Confirm:</strong> DM this message to yourself via Slack?
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {confirming ? (
            <>
              <button
                onClick={() => setConfirming(false)}
                disabled={sending}
                style={{ flex: 1, padding: '10px 14px', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', cursor: 'pointer' }}
              >← Back to edit</button>
              <button
                onClick={doSend}
                disabled={sending || !text.trim()}
                style={{ flex: 2, padding: '10px 14px', background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', border: 'none', borderRadius: 'var(--mint-radius-button)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', cursor: sending ? 'wait' : 'pointer', opacity: sending ? 0.7 : 1 }}
              >
                {sending ? 'Sending DM…' : '✓ Confirm — send DM'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={sending}
                style={{ flex: 1, padding: '10px 14px', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', cursor: 'pointer' }}
              >Cancel</button>
              <button
                onClick={() => setConfirming(true)}
                disabled={sending || !text.trim()}
                style={{ flex: 2, padding: '10px 14px', background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', border: 'none', borderRadius: 'var(--mint-radius-button)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', cursor: 'pointer' }}
              >
                Review & send DM
              </button>
            </>
          )}
        </div>

        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', textAlign: 'right' }}>
          Batch validated: {formatMCVDate(record.date)}
        </div>
      </div>
    </div>
  );
}
