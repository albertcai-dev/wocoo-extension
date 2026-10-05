// Insurance Eligibility Confirmation Triage — Home → Tools.
// Spec: docs/superpowers/specs/2026-10-05-insurance-eligibility-triage-design.md

import { useEffect, useState } from 'react';
import {
  createAndLogEligibilityViaBridge,
  listEligibilityRequestsViaBridge,
  logEligibilityResultViaBridge,
  sendEligibilityDraftsViaBridge,
} from '../api/bridge';
import { fetchAtlasClientEmailHeadless } from '../data/atlasAccountLookup';
import { ATLAS_PHONE_SEARCH_ENABLED, searchAtlasByPhone } from '../data/atlasPhoneSearch';
import { renderEligibilityDraft } from '../data/eligibilityDraft';
import { toLogRow } from '../data/eligibilityLog';
import { isEligibilityRequest, parseEligibilityEmail } from '../data/eligibilityParse';
import { isDraftable } from '../data/eligibilityResolve';
import { resolveBatch, type ResolveDeps } from '../data/eligibilityRun';
import {
  buildCreateAndLogItems, chunkByEncodedSize, type CreateAndLogItem,
  earlierDraftRow, earlierRunResolution, EMPTY_RUN, formatSkippedLine, mergeResolutions, nextAction, rowsToResolve, RUN_STATE_KEY,
  shouldShowClientEmail, sortSkippedNewestFirst, summarizeRows, type RowSummary, type SkippedEmail,
  unsentDraftCount, unsentLoggedCount, type RunRow, type RunState,
} from '../data/eligibilityRunState';
import { buildEligibilitySql } from '../data/eligibilitySql';
import { fetchI2cCardDetailsHeadless } from '../data/i2cCardLookup';
import { parsePastedResults, PRESET_DIRECT_ENABLED, PresetAuthError, runPresetSql } from '../data/presetSql';
import { errorBanner, infoCard, listItemStyle, Pill, primaryButton, secondaryButton, ToolHeader } from './toolUi';

const FLAG_TEXT: Record<string, string> = {
  multiple_candidates: 'More than one client matches — pick manually',
  delinquent: 'Card is not in good standing',
  vi_1pct: 'Unexpected product — add coverages by hand',
  no_last4: 'No card last 4 in the email',
  parse_warning: 'Email parsing warning',
  already_replied: 'Thread already has a reply',
  unknown_product: 'i2c program not recognised',
  i2c_details_incomplete: 'i2c details incomplete',
  lookup_error: 'A lookup failed',
  name_variant: 'First name spelled differently — confirm before drafting',
};

/** Max URL-encoded size of one createAndLogEligibility chunk (the items travel in a GET query string). */
const CREATE_CHUNK_MAX_CHARS = 6000;

function liveDeps(onProgress: (id: string, stage: string) => void): Omit<ResolveDeps, 'runSql'> {
  return {
    i2cCards: (email, id) => fetchI2cCardDetailsHeadless({ clientEmail: email, sourceTicketId: 'elig-' + id }),
    atlasByPhone: ATLAS_PHONE_SEARCH_ENABLED ? searchAtlasByPhone : null,
    atlasEmail: (identityId, id) => fetchAtlasClientEmailHeadless({ identityId, sourceTicketId: 'elig-' + id }),
    onProgress,
  };
}

export function EligibilityTriage({ onClose }: { onClose: () => void }) {
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Restore an in-flight run (Review Focus 4: reopening the panel must not lose state).
  useEffect(() => {
    chrome.storage.session.get(RUN_STATE_KEY).then((r) => {
      const saved = r[RUN_STATE_KEY] as RunState | undefined;
      if (saved) setRun(saved);
    });
  }, []);
  const save = (next: RunState) => {
    setRun(next);
    void chrome.storage.session.set({ [RUN_STATE_KEY]: next });
  };

  /** I1: losing the in-panel view of unsent drafts needs an explicit OK. */
  function confirmDiscardUnsent(): boolean {
    const n = unsentDraftCount(run.rows);
    return n === 0 || window.confirm(`${n} draft${n === 1 ? '' : 's'} in this run haven't been sent. Continue?`);
  }

  async function onFetch() {
    if (!confirmDiscardUnsent()) return;
    setBusy('Reading creditcardoperations@ inbox…'); setError('');
    try {
      const { requests, drafted, excludedDomains, skippedUnknownSender, skippedUnknownSenderCapped } = await listEligibilityRequestsViaBridge();
      // Insurer emails that aren't eligibility requests are left out (counted for the banner).
      const eligible = requests.filter(isEligibilityRequest);
      const eligibleDrafted = drafted.filter(isEligibilityRequest);
      const skippedNotEligibility = (requests.length - eligible.length) + (drafted.length - eligibleDrafted.length);
      // Subject/sender/date only (no body) so the user can spot real requests the filter dropped.
      const skippedNotEligibilityList: SkippedEmail[] = [
        ...requests.filter((r) => !isEligibilityRequest(r)),
        ...drafted.filter((r) => !isEligibilityRequest(r)),
      ].map((r) => ({ subject: r.subject || '', from: r.fromEmail, date: r.date || '' }));
      const fresh: RunRow[] = eligible.map((raw) => ({
        req: parseEligibilityEmail(raw, excludedDomains),
        res: null, selected: false, draftId: '', draftBody: '', sent: 'no' as const, sendError: '', logged: false, sentLogged: false,
      }));
      // I1: drafts from an earlier run (panel state lost) come back so they can still be sent.
      const seen = new Set(fresh.map((r) => r.req.messageId));
      const earlier = eligibleDrafted
        .filter((d) => !seen.has(d.messageId))
        .map(({ draftId, ...raw }) => earlierDraftRow(parseEligibilityEmail(raw, excludedDomains), draftId));
      const rows = [...fresh, ...earlier];
      save({
        stage: 'fetched', rows, skippedUnknownSender, skippedUnknownSenderCapped, skippedNotEligibility, skippedNotEligibilityList,
        sql: buildEligibilitySql(fresh.map((r) => r.req)) ?? '',
      });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  }

  async function onResolve(pastedText?: string) {
    setBusy('Matching clients…'); setError('');
    try {
      // M1: parse inside the try so a bad paste surfaces as an error.
      const pastedRows = pastedText !== undefined ? parsePastedResults(pastedText) : undefined;
      const runSql = pastedRows
        ? async () => pastedRows
        : PRESET_DIRECT_ENABLED
          ? (sql: string) => runPresetSql(sql)
          : async () => { throw new Error('Direct Preset is off — use Copy SQL and paste the results.'); };
      // I5: drafted/sent rows (incl. earlier-run rows) are never re-resolved.
      const results = await resolveBatch(rowsToResolve(run.rows).map((r) => r.req), {
        runSql,
        ...liveDeps((id, stage) => setProgress((p) => ({ ...p, [id]: stage }))),
      });
      const rows = mergeResolutions(run.rows, results, (r, res) =>
        isDraftable(res)
          ? renderEligibilityDraft({
              clientEmail: res.clientEmail,
              emailWasProvided: shouldShowClientEmail(res),
              cards: res.cards,
              requestedLast4: r.req.last4 ?? '',
            })
          : '');
      setPasteMode(false);
      save({ ...run, stage: 'resolved', rows });
    } catch (e) {
      const msg = e instanceof PresetAuthError ? 'Sign in to Preset, then press Resolve again — or use Copy SQL.' : (e as Error).message;
      setError(msg);
      setPasteMode(true);
    } finally { setBusy(''); setProgress({}); }
  }

  async function onCreateDrafts() {
    setError('');
    let rows = [...run.rows];
    // One bridge call per chunk creates the drafts and logs the rows (each call cold-starts the web app).
    const items = buildCreateAndLogItems(rows);
    const chunks = chunkByEncodedSize(items, CREATE_CHUNK_MAX_CHARS, (it) => encodeURIComponent(JSON.stringify(it)).length);
    const total = items.length;
    const indexById = new Map(rows.map((r, i) => [r.req.messageId, i]));
    const errors: string[] = [];
    let done = 0;
    setBusy(`Creating drafts… 0/${total}`);

    const applyChunk = (chunk: CreateAndLogItem[], results: Awaited<ReturnType<typeof createAndLogEligibilityViaBridge>>) => {
      const byId = new Map(results.map((x) => [x.messageId, x]));
      rows = [...rows];
      for (const item of chunk) {
        const i = indexById.get(item.messageId);
        if (i === undefined) continue;
        const x = byId.get(item.messageId);
        if (x?.ok) {
          rows[i] = { ...rows[i], draftId: x.draftId || rows[i].draftId, logged: true };
        } else {
          // Left for retry. A draft created before the log failed is kept, so the retry only logs it.
          if (x?.draftId) rows[i] = { ...rows[i], draftId: x.draftId, logged: false };
          errors.push(x?.error || 'The bridge returned no result for this row.');
        }
      }
    };

    // Two workers over the chunk list — A from the front, B from the back — each claiming the next
    // unclaimed chunk until none remain (the WiresPendingPostingV2 two-queue pattern).
    let front = 0;
    let back = chunks.length - 1;
    async function worker(fromFront: boolean) {
      while (front <= back) {
        const chunk = fromFront ? chunks[front++] : chunks[back--];
        try {
          applyChunk(chunk, await createAndLogEligibilityViaBridge(chunk));
        } catch (e) {
          errors.push((e as Error).message);
        }
        done += chunk.length;
        setBusy(`Creating drafts… ${done}/${total}`);
        save({ ...run, rows });
      }
    }

    try {
      await Promise.all([worker(true), worker(false)]);
      if (errors.length) {
        setError(errors[0] + ' — press Create drafts again to continue; finished rows are skipped.');
        save({ ...run, rows });
      } else {
        save({ ...run, stage: 'drafted', rows });
      }
    } finally { setBusy(''); }
  }

  async function onSendAll() {
    setConfirmSend(false);
    const ids = run.rows.filter((r) => r.draftId && r.sent !== 'ok').map((r) => r.draftId);
    if (!ids.length && !unsentLoggedCount(run.rows)) return;
    setBusy(ids.length ? `Sending ${ids.length} drafts…` : 'Logging sent emails…'); setError('');
    let rows = run.rows;
    try {
      if (ids.length) {
        const results = await sendEligibilityDraftsViaBridge(ids);
        const byId = new Map(results.map((x) => [x.draftId, x]));
        rows = run.rows.map((r) => {
          const x = byId.get(r.draftId);
          if (!x) return r;
          const sendNote = !x.ok ? '' : x.alreadySent ? 'Already sent earlier — not sent again.' : x.warning ?? '';
          return { ...r, sent: x.ok ? ('ok' as const) : ('failed' as const), sendError: x.ok ? '' : x.error ?? '', sendNote };
        });
        // Persist sent status BEFORE any logging so a log failure can't lose it.
        save({ ...run, stage: 'sent', rows });
      }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.sent === 'ok' && !r.sentLogged) {
          await logEligibilityResultViaBridge(toLogRow(r.req, r.res ?? earlierRunResolution(r.req.messageId), 'READ_EMAIL', r.draftId));
          rows = [...rows];
          rows[i] = { ...r, sentLogged: true };
          save({ ...run, stage: 'sent', rows });
        }
      }
    } catch (e) {
      setError((e as Error).message + (rows.some((r) => r.sent === 'ok' && !r.sentLogged) ? ' — sent status is saved; press Send again to retry logging.' : ''));
    } finally { setBusy(''); }
  }

  const act = nextAction(run, !!busy, confirmSend);
  // The step highlight ignores `busy` so the intro keeps pointing at the step being run.
  const stepKind = nextAction(run, false, confirmSend).kind;
  const currentStep = stepKind === 'fetch' ? 1 : stepKind === 'resolve' ? 2 : stepKind === 'draft' ? 3
    : stepKind === 'send' || stepKind === 'confirm' || stepKind === 'retryLog' ? 4 : 0;
  const summary = summarizeRows(run.rows);
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <ToolHeader title="Insurance Eligibility Triage" onClose={onClose} disabled={!!busy} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
        <IntroCard currentStep={currentStep} />

        {error ? <div role="alert" style={errorBanner}>⚠ {error}</div> : null}

        {act.kind === 'fetch' ? (
          <button onClick={onFetch} style={{ ...primaryButton, width: '100%' }}>⚡ 1. Fetch requests</button>
        ) : act.kind === 'resolve' ? (
          <button onClick={() => onResolve()} style={{ ...primaryButton, width: '100%' }}>
            ⚡ 2. Resolve {act.count} request{act.count === 1 ? '' : 's'}
          </button>
        ) : act.kind === 'draft' ? (
          <button onClick={onCreateDrafts} style={{ ...primaryButton, width: '100%' }}>
            {act.count > 0 ? `⚡ 3. Create drafts & log (${act.count})` : '⚡ 3. Log results'}
          </button>
        ) : act.kind === 'send' ? (
          <button onClick={() => setConfirmSend(true)} style={{ ...primaryButton, width: '100%' }}>⚡ 4. Send all drafts ({act.count})</button>
        ) : act.kind === 'confirm' ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onSendAll} style={{ ...primaryButton, flex: 1 }}>Confirm send {act.count}</button>
            <button onClick={() => setConfirmSend(false)} style={secondaryButton}>Cancel</button>
          </div>
        ) : act.kind === 'retryLog' ? (
          <button onClick={onSendAll} style={{ ...primaryButton, width: '100%' }}>↻ Retry logging ({act.count})</button>
        ) : act.kind === 'done' ? (
          <div style={infoCard}>All done for this batch.</div>
        ) : (
          <div style={infoCard}>{busy}</div>
        )}

        {run.stage !== 'idle' && !busy ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onFetch} style={secondaryButton}>↻ Fetch again</button>
            <button onClick={() => { if (confirmDiscardUnsent()) save(EMPTY_RUN); }} style={secondaryButton}>Clear</button>
          </div>
        ) : null}

        {run.skippedUnknownSender > 0 ? (
          <div style={skipBox}>
            {run.skippedUnknownSender}{run.skippedUnknownSenderCapped ? '+' : ''} unread email(s) from senders not on the Insurers tab were skipped. Check the inbox.
          </div>
        ) : null}
        {(run.skippedNotEligibility ?? 0) > 0 ? (
          <details style={skipBox}>
            <summary>{run.skippedNotEligibility} insurer email(s) weren't eligibility requests and were skipped.</summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16, wordBreak: 'break-word' }}>
              {sortSkippedNewestFirst(run.skippedNotEligibilityList ?? []).map((s, i) => (
                <li key={i}>{formatSkippedLine(s)}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {pasteMode ? (
          <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={() => navigator.clipboard.writeText(run.sql)} style={{ ...secondaryButton, alignSelf: 'flex-start' }}>Copy SQL</button>
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
              Run it in Preset SQL Lab (Pantheon), copy the result table, paste below.
            </div>
            <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button disabled={!!busy || !pasted.trim()} onClick={() => onResolve(pasted)} style={{ ...primaryButton, width: '100%' }}>Use pasted results</button>
          </div>
        ) : null}

        {run.rows.length > 0 ? (
          <section>
            <SummaryRow summary={summary} />
            <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--mint-sp-2) 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {run.rows.map((r, i) => (
                <RowItem
                  key={r.req.messageId}
                  row={r}
                  progressText={progress[r.req.messageId]}
                  busy={!!busy}
                  expanded={expanded.has(r.req.messageId)}
                  onToggle={() => toggleExpanded(r.req.messageId)}
                  onSelect={(checked) => {
                    const rows = [...run.rows];
                    rows[i] = { ...r, selected: checked };
                    save({ ...run, rows });
                  }}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ============================================================
// presentational pieces
// ============================================================

const cardStyle: React.CSSProperties = {
  padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5,
};

const skipBox: React.CSSProperties = {
  ...infoCard, textAlign: 'left', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)',
};

const INTRO_STEPS: Array<{ title: string; text: string }> = [
  { title: 'Fetch requests', text: 'reads unread insurer emails and pulls out name, emails, phone and card last 4.' },
  { title: 'Resolve', text: 'finds each client (warehouse → i2c → Atlas phone) and previews the reply.' },
  { title: 'Create drafts & log', text: 'drafts the ticked replies in creditcardoperations@ and logs every request to the POC sheet.' },
  { title: 'Send all drafts', text: 'sends this run’s drafts after you confirm.' },
];

function IntroCard({ currentStep }: { currentStep: number }) {
  return (
    <div style={cardStyle}>
      For every unread insurer request in creditcardoperations@, this tool:
      <ol style={{ paddingLeft: '1.2em', margin: '8px 0 0' }}>
        {INTRO_STEPS.map((s, i) => (
          <li key={s.title} style={currentStep === i + 1 ? { fontWeight: 700 } : undefined}>
            <strong>{s.title}</strong> — {s.text}{currentStep === i + 1 ? ' ← next' : ''}
          </li>
        ))}
      </ol>
      <div style={{ marginTop: 8, color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-nano)' }}>
        Steps 1–2 write nothing. Preset, i2c and Atlas tabs open briefly in the background while resolving — leave them.
      </div>
    </div>
  );
}

function SummaryRow({ summary }: { summary: RowSummary }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 'var(--mint-text-nano)' }}>
      <Pill label={`${summary.total} requests`} tone="neutral" />
      {summary.ready > 0 ? <Pill label={`✓ ${summary.ready} ready`} tone="positive" /> : null}
      {summary.review > 0 ? <Pill label={`⚠ ${summary.review} review`} tone="warning" /> : null}
      {summary.noMatch > 0 ? <Pill label={`✗ ${summary.noMatch} no match`} tone="neutral" /> : null}
      {summary.drafted > 0 ? <Pill label={`📝 ${summary.drafted} drafted`} tone="highlight" /> : null}
      {summary.sent > 0 ? <Pill label={`📤 ${summary.sent} sent`} tone="positive" /> : null}
      {summary.pending > 0 ? <Pill label={`… ${summary.pending} pending`} tone="neutral" /> : null}
    </div>
  );
}

function StatusBadge({ row, progressText }: { row: RunRow; progressText?: string }) {
  const res = row.res;
  if (row.sent === 'ok') return <Pill label="📤 Sent" tone="positive" />;
  if (row.draftId && row.sent === 'failed') return <Pill label="⚠ Send failed" tone="warning" />;
  if (row.draftId) return <Pill label={row.earlier ? '📝 Drafted earlier' : '📝 Drafted'} tone="highlight" />;
  if (res?.status === 'matched') return <Pill label="✓ Ready" tone="positive" />;
  if (res?.status === 'needs_review') {
    const flag = res.flags[0];
    return <Pill label={`⚠ ${flag ? FLAG_TEXT[flag] ?? flag : 'Needs review'}`} tone="warning" wrap />;
  }
  if (res?.status === 'no_match') return <Pill label="✗ No match" tone="neutral" />;
  if (progressText) return <Pill label={`… ${progressText}`} tone="highlight" />;
  return <Pill label="pending" tone="neutral" />;
}

function RowItem({ row: r, progressText, busy, expanded, onToggle, onSelect }: {
  row: RunRow; progressText?: string; busy: boolean; expanded: boolean; onToggle: () => void; onSelect: (checked: boolean) => void;
}) {
  const res = r.res;
  const soft: React.CSSProperties = { fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' };
  return (
    <li onClick={onToggle} style={{ ...listItemStyle, flexWrap: 'wrap', cursor: 'pointer' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto', minWidth: 110, maxWidth: 150, gap: 2 }}>
        <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>
          {r.req.cardholderName?.raw ?? '(no name)'}
        </span>
        <span style={{ fontSize: 'var(--mint-text-micro)', fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', lineHeight: 1.3 }}>
          ****{r.req.last4 ?? '????'}
        </span>
        <span style={{ ...soft, wordBreak: 'break-all' }}>{r.req.insurerEmail}</span>
      </div>
      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <StatusBadge row={r} progressText={progressText} />
        {r.draftBody && !r.draftId ? (
          <label onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 6, alignItems: 'center', ...soft }}>
            <input type="checkbox" checked={r.selected} disabled={busy} onChange={(e) => onSelect(e.target.checked)} />
            Include in drafts
          </label>
        ) : null}
      </div>
      <span aria-hidden style={{ ...soft, alignSelf: 'center' }}>{expanded ? '▾' : '▸'}</span>
      {expanded ? (
        <div onClick={(e) => e.stopPropagation()} style={{ flex: '1 0 100%', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'default' }}>
          <div style={soft}>
            Emails: {r.req.emails.join(', ') || '—'} · Phone: {r.req.phone ?? '—'}
          </div>
          {res ? (
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)' }}>
              {res.method ? `Matched: ${res.method}` : 'Not matched'} — {res.note}
            </div>
          ) : null}
          {res && res.flags.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 'var(--mint-text-nano)' }}>
              {res.flags.map((f) => <Pill key={f} label={`⚠ ${FLAG_TEXT[f] ?? f}`} tone="warning" wrap />)}
            </div>
          ) : null}
          {res && res.candidates.length > 0 ? (
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)' }}>
              {res.candidates.map((c) => <div key={c.identityId}>• {c.name} — {c.clientEmail} ({c.identityId})</div>)}
            </div>
          ) : null}
          {r.draftBody ? (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 'var(--mint-text-nano)', background: 'var(--mint-bg-subtle)', padding: 6, borderRadius: 'var(--mint-radius-button)' }}>{r.draftBody}</pre>
          ) : null}
          {r.sent === 'failed' ? (
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>Send failed: {r.sendError}</div>
          ) : null}
          {r.sent === 'ok' && r.sendNote ? <div style={soft}>{r.sendNote}</div> : null}
        </div>
      ) : null}
    </li>
  );
}
