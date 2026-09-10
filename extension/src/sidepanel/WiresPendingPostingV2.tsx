// Wires Pending Posting v2 — same daily task as v1, pointed at the new Ledge SPA.
//
// What changed from v1: Ledge verification is now a GraphQL query rather than a DOM
// drive, so there is no search modal to open, no Transactions tab to click and no
// virtualized grid to scroll. That removes the reason v1 ran two Ledge tabs in
// parallel (each tab was a slow DOM worker) — v2 opens one tab, which exists only to
// hold the page's Okta session for `content/ledgeSpa.ts` to read.
//
// v1 stays in place and untouched while this is proven against production.

import { useState } from 'react';
import type { WireRow, WireRowResult, WireRowStatus } from '../data/wiresConfig';
import { WIRES_SHEET_ID, WIRES_SHEET_TAB, WIRES_SHEET_URL } from '../data/wiresConfig';
import { LEDGE_SPA_URL } from '../data/ledgeGraphql';
import { readPendingWiresViaBridge, markWirePostedViaBridge } from '../api/bridge';
import { getIssueStatusAndComments, extractJiraKeyFromUrl } from '../api/jira';

type RunState = 'idle' | 'loading' | 'running' | 'done' | 'error';

/** A paginated GraphQL sweep is quick, but a wire from months back can walk many
 *  pages. 90s leaves room without letting a wedged tab hang the whole run. */
const LEDGE_TIMEOUT_MS = 90_000;

export function WiresPendingPostingV2({ onClose }: { onClose: () => void }) {
  const [runState, setRunState] = useState<RunState>('idle');
  const [rows, setRows] = useState<WireRowResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function startRun() {
    setRunState('loading');
    setError(null);
    setRows([]);
    try {
      const pending = await readPendingWiresViaBridge(WIRES_SHEET_ID, WIRES_SHEET_TAB);

      if (pending.length === 0) {
        setRunState('done');
        setRows([]);
        setError('No rows match wire_status = "Pending posting". Nothing to do.');
        return;
      }

      const wireRows: WireRow[] = pending.map((p) => ({
        rowNumber: p.rowNumber,
        amountText: p.amountText,
        amount: p.amount,
        currency: p.currency,
        custodianRaw: p.custodianRaw,
        custodianHyperlink: p.custodianHyperlink,
        wireTimestamp: p.wireTimestamp,
      }));

      const initial: WireRowResult[] = wireRows.map((row) => ({ row, status: { kind: 'pending' } }));
      setRows(initial);
      setRunState('running');

      const updated = [...initial];
      const setStatusFor = (i: number, status: WireRowStatus) => {
        updated[i] = { row: updated[i].row, status };
        setRows([...updated]);
      };

      // Rows needing a Ledge lookup: plain-text custodian, not N/A.
      const ledgeIndices: number[] = [];
      updated.forEach((r, idx) => {
        if (!r.row.custodianHyperlink && !isNotApplicable(r.row.custodianRaw)) {
          ledgeIndices.push(idx);
        }
      });

      if (ledgeIndices.length > 0) {
        window.open(LEDGE_SPA_URL, '_blank', 'noopener,noreferrer');
        // Let the content script attach and the SPA finish its Okta handshake before
        // the first job lands — a job queued too early answers "no access token".
        await new Promise((r) => setTimeout(r, 2500));
      }

      // Hyperlinked rows go to Atlassian; N/A rows are skipped. Neither needs the tab,
      // so they run alongside the Ledge queue.
      async function runJiraAndSkipped() {
        for (let i = 0; i < updated.length; i++) {
          const row = updated[i].row;
          if (isNotApplicable(row.custodianRaw)) {
            setStatusFor(i, { kind: 'skipped', reason: 'custodian_account_id is N/A — sheet stays Pending posting' });
            continue;
          }
          if (!row.custodianHyperlink) continue; // the Ledge queue handles these
          try {
            setStatusFor(i, { kind: 'checking', via: 'jira' });
            const status = await verifyViaJira(row.custodianHyperlink);
            if (status.kind === 'posted') {
              await markWirePostedViaBridge(WIRES_SHEET_ID, WIRES_SHEET_TAB, row.rowNumber);
              setStatusFor(i, { kind: 'posted' });
            } else {
              setStatusFor(i, status);
            }
          } catch (e: any) {
            setStatusFor(i, { kind: 'anomaly', reason: e?.message || String(e) });
          }
        }
      }

      // One queue: the content script processes a single job at a time, and a GraphQL
      // sweep is fast enough that splitting the work buys nothing.
      async function runLedgeQueue() {
        for (const i of ledgeIndices) {
          const row = updated[i].row;
          try {
            setStatusFor(i, { kind: 'checking', via: 'ledge' });
            const status = await verifyViaLedgeSpa(row);
            if (status.kind === 'posted') {
              await markWirePostedViaBridge(WIRES_SHEET_ID, WIRES_SHEET_TAB, row.rowNumber);
              setStatusFor(i, { kind: 'posted' });
            } else {
              setStatusFor(i, status);
            }
          } catch (e: any) {
            setStatusFor(i, { kind: 'anomaly', reason: e?.message || String(e) });
          }
        }
      }

      await Promise.all([runJiraAndSkipped(), runLedgeQueue()]);
      setRunState('done');
    } catch (e: any) {
      setError(e?.message || String(e));
      setRunState('error');
    }
  }

  // ----- per-row verifiers -----

  /** Atlassian path — unchanged from v1. Passes on status Done, or a legacy comment
   *  containing "complete". */
  async function verifyViaJira(url: string): Promise<WireRowStatus> {
    const key = extractJiraKeyFromUrl(url);
    if (!key) return { kind: 'anomaly', reason: 'Hyperlink not a wealthsimple.atlassian.net /browse URL' };
    const { status, comments } = await getIssueStatusAndComments(key);
    if (status === 'Done') return { kind: 'posted' };
    const hit = comments.find((c) => c.toLowerCase().includes('complete'));
    if (hit) return { kind: 'posted' };
    return { kind: 'anomaly', reason: `${key}: not Done and no "complete" comment yet (status: ${status || 'unknown'})` };
  }

  /** Ledge SPA path. Queue a job for `content/ledgeSpa.ts`, wait for the result whose
   *  jobId matches, translate to a WireRowStatus. */
  async function verifyViaLedgeSpa(row: WireRow): Promise<WireRowStatus> {
    if (!row.custodianRaw) {
      return { kind: 'anomaly', reason: 'Empty custodian_account_id' };
    }
    const jobId = `j_${row.rowNumber}_${Date.now()}`;
    const job = {
      jobId,
      accountNumber: row.custodianRaw.trim(),
      amount: row.amount,
      currency: row.currency,
      wireTimestamp: row.wireTimestamp || '',
    };

    return new Promise<WireRowStatus>((resolve) => {
      const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== 'local' || !('ledgespa_verify_result' in changes)) return;
        const v = changes['ledgespa_verify_result'].newValue as
          | { jobId: string; matched: boolean; reason?: string }
          | undefined;
        if (!v || v.jobId !== jobId) return;
        cleanup();
        if (v.matched) resolve({ kind: 'posted' });
        else resolve({ kind: 'anomaly', reason: v.reason || 'Ledge: no match' });
      };
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve({ kind: 'anomaly', reason: `Ledge verification timed out after ${LEDGE_TIMEOUT_MS / 1000}s` });
      }, LEDGE_TIMEOUT_MS);
      function cleanup() {
        chrome.storage.onChanged.removeListener(onChange);
        window.clearTimeout(timeoutId);
      }
      chrome.storage.onChanged.addListener(onChange);
      void chrome.storage.local
        .remove(['ledgespa_verify_result'])
        .then(() => chrome.storage.local.set({ pending_ledgespa_verify: job }));
    });
  }

  const summary = summarize(rows);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
        <IntroCard />

        {error ? <div role="alert" style={errorBanner}>⚠ {error}</div> : null}

        {runState === 'idle' ? (
          <button onClick={startRun} style={{ ...primaryButton, width: '100%' }}>
            ⚡ Run Wires Pending Posting check (v2)
          </button>
        ) : runState === 'loading' ? (
          <div style={infoCard}>Loading Pending Posting rows from the sheet…</div>
        ) : runState === 'running' ? (
          <div style={infoCard}>
            Checking {rows.length} row{rows.length === 1 ? '' : 's'}…
          </div>
        ) : runState === 'error' ? (
          <button onClick={startRun} style={{ ...primaryButton, width: '100%' }}>↻ Try again</button>
        ) : null}

        {rows.length > 0 ? (
          <section>
            <SummaryRow summary={summary} />
            <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--mint-sp-2) 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((r) => <RowItem key={r.row.rowNumber} result={r} />)}
            </ul>
          </section>
        ) : null}

        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', textAlign: 'center', marginTop: 'var(--mint-sp-2)' }}>
          <a href={WIRES_SHEET_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>Open the tracker sheet ↗</a>
        </div>
      </div>
    </div>
  );
}

function isNotApplicable(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === 'n/a' || s === 'na' || s === 'not applicable';
}

function summarize(rows: WireRowResult[]) {
  let posted = 0, anomalies = 0, checking = 0, pending = 0, skipped = 0;
  for (const r of rows) {
    if (r.status.kind === 'posted') posted++;
    else if (r.status.kind === 'anomaly') anomalies++;
    else if (r.status.kind === 'checking') checking++;
    else if (r.status.kind === 'skipped') skipped++;
    else pending++;
  }
  return { posted, anomalies, checking, pending, skipped, total: rows.length };
}

function IntroCard() {
  return (
    <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5 }}>
      Same check as v1, run against the new Ledge SPA. For every row with{' '}
      <code>wire_status = Pending posting</code>, this tool:
      <ol style={{ paddingLeft: '1.2em', margin: '8px 0 0' }}>
        <li>Queries Ledge's GraphQL API for the custodian account's transactions → looks for a <code>WIREIN</code> matching column C.</li>
        <li>Or, if column H is a hyperlinked Atlassian ticket → checks status Done or a comment containing "complete".</li>
        <li>Flips column L to <code>Posted</code> on verification.</li>
        <li>Surfaces anything unclear as an anomaly for manual review (does not write to the sheet).</li>
      </ol>
      <div style={{ marginTop: 8, color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-nano)' }}>
        A Ledge tab opens on the first run — it holds the Okta session the query needs. Leave it open.
      </div>
    </div>
  );
}

function SummaryRow({ summary }: { summary: { posted: number; anomalies: number; checking: number; pending: number; skipped: number; total: number } }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 'var(--mint-text-nano)' }}>
      <Pill label={`${summary.total} rows`} tone="neutral" />
      {summary.posted > 0 ? <Pill label={`✓ ${summary.posted} posted`} tone="positive" /> : null}
      {summary.anomalies > 0 ? <Pill label={`⚠ ${summary.anomalies} anomalies`} tone="warning" /> : null}
      {summary.skipped > 0 ? <Pill label={`– ${summary.skipped} skipped`} tone="neutral" /> : null}
      {summary.checking > 0 ? <Pill label={`… ${summary.checking} checking`} tone="highlight" /> : null}
    </div>
  );
}

function Pill({ label, tone, wrap }: { label: string; tone: 'positive' | 'warning' | 'highlight' | 'neutral'; wrap?: boolean }) {
  const map: Record<typeof tone, React.CSSProperties> = {
    positive:  { background: 'var(--mint-positive-bg-soft)', color: 'var(--mint-positive-fg-strong)',  border: '1px solid var(--mint-positive-fg-graphic)' },
    warning:   { background: 'var(--mint-warning-bg-soft)',  color: 'var(--mint-warning-fg-strong)',   border: '1px solid var(--mint-warning-fg-graphic)'  },
    highlight: { background: 'var(--mint-highlight-bg-soft)',color: 'var(--mint-highlight-fg-strong)', border: '1px solid var(--mint-highlight-fg-graphic)'},
    neutral:   { background: 'var(--mint-bg-subtle)',        color: 'var(--mint-fg-strong)',           border: 'var(--mint-card-stroke)'                    },
  };
  const wrapStyle: React.CSSProperties = wrap
    ? { display: 'inline-block', whiteSpace: 'normal', wordBreak: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3, textAlign: 'left' }
    : {};
  return <span style={{ ...map[tone], padding: '2px 8px', borderRadius: wrap ? 12 : 9999, fontWeight: 700, ...wrapStyle }}>{label}</span>;
}

function RowItem({ result }: { result: WireRowResult }) {
  const { row, status } = result;
  return (
    <li style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px', background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto', minWidth: 110, maxWidth: 120, gap: 2 }}>
        <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Row {row.rowNumber}</span>
        <span style={{ fontSize: 'var(--mint-text-micro)', fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', lineHeight: 1.3 }}>
          {row.amountText}
        </span>
        <span style={{ fontSize: 'var(--mint-text-micro)', fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', wordBreak: 'break-all', lineHeight: 1.3 }}>
          {row.custodianHyperlink ? '🔗 ' : ''}{row.custodianRaw || '—'}
        </span>
      </div>
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
        <StatusBadge status={status} />
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: WireRowStatus }) {
  if (status.kind === 'posted') return <Pill label="✓ Posted" tone="positive" />;
  if (status.kind === 'anomaly') return <Pill label={`⚠ ${status.reason}`} tone="warning" wrap />;
  if (status.kind === 'skipped') return <Pill label={`– ${status.reason}`} tone="neutral" wrap />;
  if (status.kind === 'checking') return <Pill label={`… via ${status.via}`} tone="highlight" />;
  return <Pill label="pending" tone="neutral" />;
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onClose} title="Back to home" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Wires Pending Posting v2</h2>
      </div>
    </header>
  );
}

// ============================================================
// styles
// ============================================================

const primaryButton: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 700,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
};

const infoCard: React.CSSProperties = {
  padding: 'var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  fontSize: 'var(--mint-text-meta)',
  color: 'var(--mint-fg-strong)',
  textAlign: 'center',
};

const errorBanner: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  fontSize: 'var(--mint-text-meta)',
  borderRadius: 'var(--mint-radius-button)',
};
