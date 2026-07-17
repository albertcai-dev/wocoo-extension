// Wires Pending Posting assistant — full-panel workflow opened from the Home view's
// Tools section. Drives the daily "verify each Pending Posting wire on Ledge or Atlassian,
// then flip the row to Posted" task as a 1-click autonomous batch.
//
// v1 is UI-only scaffolding: shows the panel layout + idle/running/done states with
// mock data. Google OAuth + Sheets/Ledge wiring follow in subsequent layers.

import { useState } from 'react';
import type { WireRow, WireRowResult, WireRowStatus } from '../data/wiresConfig';
import {
  WIRES_SHEET_ID,
  WIRES_SHEET_TAB,
  WIRES_SHEET_URL,
  LEDGE_URL,
} from '../data/wiresConfig';
import { readPendingWiresViaBridge, markWirePostedViaBridge } from '../api/bridge';
import { getIssueStatusAndComments, extractJiraKeyFromUrl } from '../api/jira';

type RunState = 'idle' | 'loading' | 'running' | 'done' | 'error';

export function WiresPendingPosting({ onClose }: { onClose: () => void }) {
  const [runState, setRunState] = useState<RunState>('idle');
  const [rows, setRows] = useState<WireRowResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function startRun() {
    setRunState('loading');
    setError(null);
    setRows([]);
    try {
      // Apps Script bridge does the filter + hyperlink detection server-side and returns
      // only the matching rows. No client-side OAuth required.
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

      // Initial render — all rows in pending state. Verify each below.
      const initial: WireRowResult[] = wireRows.map((row) => ({ row, status: { kind: 'pending' } }));
      setRows(initial);
      setRunState('running');

      // Verify rows sequentially. Sequential keeps things simple (no rate-limit thrash)
      // and the UI updates per row land cleanly. Parallelism is easy to add later.
      const updated = [...initial];
      const setStatusFor = (i: number, status: WireRowStatus) => {
        updated[i] = { row: updated[i].row, status };
        setRows([...updated]);
      };

      // Index of all rows that need Ledge verification (plain-text custodian, not N/A).
      const ledgeIndices: number[] = [];
      updated.forEach((r, idx) => {
        if (!r.row.custodianHyperlink && !isNotApplicable(r.row.custodianRaw)) {
          ledgeIndices.push(idx);
        }
      });

      // Two-tab strategy: split Ledge work in half — "top" tab walks the front half
      // ascending, "bottom" tab walks the back half descending. They meet in the
      // middle. Halves typical run time.
      const ledgeNeeded = ledgeIndices.length > 0;
      if (ledgeNeeded) {
        window.open(LEDGE_URL + '#wocoo-top', '_blank', 'noopener,noreferrer');
        window.open(LEDGE_URL + '#wocoo-bottom', '_blank', 'noopener,noreferrer');
        // Give both content scripts time to attach + bootstrap before queueing work.
        await new Promise((r) => setTimeout(r, 1800));
      }
      const mid = Math.ceil(ledgeIndices.length / 2);
      const topQueue = ledgeIndices.slice(0, mid);                     // ascending
      const bottomQueue = ledgeIndices.slice(mid).reverse();           // descending

      // JIRA-path rows (hyperlinked) + skipped pre-checks run on the side panel's own
      // thread; they don't need a Ledge tab.
      async function runJiraAndSkipped() {
        for (let i = 0; i < updated.length; i++) {
          const row = updated[i].row;
          if (isNotApplicable(row.custodianRaw)) {
            setStatusFor(i, { kind: 'skipped', reason: 'custodian_account_id is N/A — sheet stays Pending posting' });
            continue;
          }
          if (!row.custodianHyperlink) continue; // ledge tabs handle these
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

      async function runLedgeQueue(role: 'top' | 'bottom', indices: number[]) {
        for (const i of indices) {
          const row = updated[i].row;
          try {
            setStatusFor(i, { kind: 'checking', via: 'ledge' });
            const status = await verifyViaLedge(row, role);
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

      await Promise.all([
        runJiraAndSkipped(),
        runLedgeQueue('top', topQueue),
        runLedgeQueue('bottom', bottomQueue),
      ]);
      setRunState('done');
    } catch (e: any) {
      setError(e?.message || String(e));
      setRunState('error');
    }
  }

  // ----- per-row verifiers -----

  /**
   * Atlassian path. Extract the issue key from the cell's hyperlink, fetch the ticket's
   * status + comments. Pass if either signal indicates the wire has been processed:
   *   - status === "Done" (new BOSM format — no more "complete" comments)
   *   - OR any comment contains "complete" (legacy fallback for older tickets)
   */
  async function verifyViaJira(url: string): Promise<WireRowStatus> {
    const key = extractJiraKeyFromUrl(url);
    if (!key) return { kind: 'anomaly', reason: 'Hyperlink not a wealthsimple.atlassian.net /browse URL' };
    const { status, comments } = await getIssueStatusAndComments(key);
    if (status === 'Done') return { kind: 'posted' };
    const hit = comments.find((c) => c.toLowerCase().includes('complete'));
    if (hit) return { kind: 'posted' };
    return { kind: 'anomaly', reason: `${key}: not Done and no "complete" comment yet (status: ${status || 'unknown'})` };
  }

  /**
   * Ledge path. Queue a job to the role-specific Ledge content script via
   * chrome.storage.local, wait for the matching result, translate to a WireRowStatus.
   */
  async function verifyViaLedge(row: WireRow, role: 'top' | 'bottom'): Promise<WireRowStatus> {
    if (!row.custodianRaw) {
      return { kind: 'anomaly', reason: 'Empty custodian_account_id' };
    }
    const pendingKey = `pending_ledge_verify_${role}`;
    const resultKey  = `ledge_verify_result_${role}`;
    const jobId = `j_${row.rowNumber}_${Date.now()}`;
    const job = {
      jobId,
      accountNumber: row.custodianRaw.trim(),
      amount: row.amount,
      currency: row.currency,
      expectedSource: String(row.rowNumber),
      wireTimestamp: row.wireTimestamp || '',
    };

    return new Promise<WireRowStatus>((resolve) => {
      const timeoutMs = 150_000;
      const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== 'local' || !(resultKey in changes)) return;
        const v = changes[resultKey].newValue as { jobId: string; matched: boolean; reason?: string } | undefined;
        if (!v || v.jobId !== jobId) return; // not ours (could be a sibling tab's result)
        cleanup();
        if (v.matched) resolve({ kind: 'posted' });
        else resolve({ kind: 'anomaly', reason: v.reason || 'Ledge: no match' });
      };
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve({ kind: 'anomaly', reason: `Ledge verification timed out after 150s (${role} tab)` });
      }, timeoutMs);
      function cleanup() {
        chrome.storage.onChanged.removeListener(onChange);
        window.clearTimeout(timeoutId);
      }
      chrome.storage.onChanged.addListener(onChange);
      void chrome.storage.local.remove([resultKey]).then(() =>
        chrome.storage.local.set({ [pendingKey]: job }),
      );
    });
  }

  const summary = summarize(rows);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
        <IntroCard />

        {error ? (
          <div role="alert" style={errorBanner}>⚠ {error}</div>
        ) : null}

        {runState === 'idle' ? (
          <button onClick={startRun} style={{ ...primaryButton, width: '100%' }}>
            ⚡ Run Wires Pending Posting check
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
      For every row with <code>wire_status = Pending posting</code>, this tool:
      <ol style={{ paddingLeft: '1.2em', margin: '8px 0 0' }}>
        <li>Looks up the custodian account on Ledge → verifies a Wire-In matching column C is posted.</li>
        <li>Or, if column H is a hyperlinked Atlassian ticket → checks for a comment containing "complete".</li>
        <li>Flips column L to <code>Posted</code> on verification.</li>
        <li>Surfaces anything unclear as an anomaly for manual review (does not write to the sheet).</li>
      </ol>
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
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Wires Pending Posting</h2>
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
