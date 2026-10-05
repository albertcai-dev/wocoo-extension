// Insurance Eligibility Confirmation Triage — Home → Tools.
// Spec: docs/superpowers/specs/2026-10-05-insurance-eligibility-triage-design.md

import { useEffect, useState } from 'react';
import {
  createEligibilityDraftViaBridge,
  listEligibilityRequestsViaBridge,
  logEligibilityResultViaBridge,
  sendEligibilityDraftsViaBridge,
} from '../api/bridge';
import { fetchAtlasClientEmailHeadless } from '../data/atlasAccountLookup';
import { ATLAS_PHONE_SEARCH_ENABLED, searchAtlasByPhone } from '../data/atlasPhoneSearch';
import { renderEligibilityDraft } from '../data/eligibilityDraft';
import { toLogRow } from '../data/eligibilityLog';
import { parseEligibilityEmail } from '../data/eligibilityParse';
import { isDraftable } from '../data/eligibilityResolve';
import { resolveBatch, type ResolveDeps } from '../data/eligibilityRun';
import { defaultSelected, EMPTY_RUN, nextLogStatus, RUN_STATE_KEY, type RunState } from '../data/eligibilityRunState';
import { buildEligibilitySql } from '../data/eligibilitySql';
import { fetchI2cCardDetailsHeadless } from '../data/i2cCardLookup';
import { parsePastedResults, PRESET_DIRECT_ENABLED, PresetAuthError, runPresetSql } from '../data/presetSql';

const FLAG_TEXT: Record<string, string> = {
  multiple_candidates: 'More than one client matches — pick manually',
  delinquent: 'Card is not in good standing',
  vi_1pct: 'Not Privilege/Plus — add 1% coverages by hand',
  no_last4: 'No card last 4 in the email',
  parse_warning: 'Email parsing warning',
  already_replied: 'Thread already has a reply',
  unknown_product: 'i2c program not recognised',
  i2c_details_incomplete: 'i2c details incomplete',
  lookup_error: 'A lookup failed',
};

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

  async function onFetch() {
    setBusy('Reading creditcardoperations@ inbox…'); setError('');
    try {
      const { requests, excludedDomains, skippedUnknownSender } = await listEligibilityRequestsViaBridge();
      const rows = requests.map((raw) => ({
        req: parseEligibilityEmail(raw, excludedDomains),
        res: null, selected: false, draftId: '', draftBody: '', sent: 'no' as const, sendError: '',
      }));
      save({ stage: 'fetched', rows, skippedUnknownSender, sql: buildEligibilitySql(rows.map((r) => r.req)) ?? '' });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  }

  async function onResolve(pastedRows?: Record<string, unknown>[]) {
    setBusy('Matching clients…'); setError('');
    const runSql = pastedRows
      ? async () => pastedRows
      : PRESET_DIRECT_ENABLED
        ? (sql: string) => runPresetSql(sql)
        : async () => { throw new Error('Direct Preset is off — use Copy SQL and paste the results.'); };
    try {
      const results = await resolveBatch(run.rows.map((r) => r.req), {
        runSql,
        ...liveDeps((id, stage) => setProgress((p) => ({ ...p, [id]: stage }))),
      });
      const rows = run.rows.map((r, i) => {
        const res = results[i];
        const draftBody = isDraftable(res)
          ? renderEligibilityDraft({
              clientEmail: res.clientEmail,
              emailWasProvided: !!res.clientEmail && r.req.emails.includes(res.clientEmail),
              cards: res.cards,
              requestedLast4: r.req.last4 ?? '',
            })
          : '';
        return { ...r, res, draftBody, selected: defaultSelected(res) && !!draftBody };
      });
      setPasteMode(false);
      save({ ...run, stage: 'resolved', rows });
    } catch (e) {
      const msg = e instanceof PresetAuthError ? 'Sign in to Preset, then press Resolve again — or use Copy SQL.' : (e as Error).message;
      setError(msg);
      setPasteMode(true);
    } finally { setBusy(''); setProgress({}); }
  }

  async function onCreateDrafts() {
    setBusy('Creating drafts…'); setError('');
    const rows = [...run.rows];
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.res) continue;
        let draftId = r.draftId;
        if (r.selected && r.draftBody && !draftId) {
          draftId = await createEligibilityDraftViaBridge(r.req.messageId, r.draftBody);
          rows[i] = { ...r, draftId };
        }
        await logEligibilityResultViaBridge(toLogRow(r.req, r.res, nextLogStatus(r.res, !!draftId), draftId));
        save({ ...run, rows });
      }
      save({ ...run, stage: 'drafted', rows });
    } catch (e) {
      setError((e as Error).message + ' — press Create drafts again to continue; finished rows are skipped.');
      save({ ...run, rows });
    } finally { setBusy(''); }
  }

  async function onSendAll() {
    setConfirmSend(false);
    const ids = run.rows.filter((r) => r.draftId && r.sent !== 'ok').map((r) => r.draftId);
    if (!ids.length) return;
    setBusy(`Sending ${ids.length} drafts…`); setError('');
    try {
      const results = await sendEligibilityDraftsViaBridge(ids);
      const byId = new Map(results.map((x) => [x.draftId, x]));
      const rows = run.rows.map((r) => {
        const x = byId.get(r.draftId);
        return x ? { ...r, sent: x.ok ? ('ok' as const) : ('failed' as const), sendError: x.error ?? '' } : r;
      });
      for (const r of rows) {
        if (r.sent === 'ok' && r.res) await logEligibilityResultViaBridge(toLogRow(r.req, r.res, 'READ_EMAIL', r.draftId));
      }
      save({ ...run, stage: 'sent', rows });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  }

  const draftCount = run.rows.filter((r) => r.selected && r.draftBody && !r.draftId).length;
  const sendable = run.rows.filter((r) => r.draftId && r.sent !== 'ok').length;

  return (
    <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onClose}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)' }}>Insurance Eligibility Confirmation Triage</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={!!busy} onClick={onFetch}>1. Fetch requests</button>
        <button disabled={!!busy || run.stage === 'idle' || !run.rows.length} onClick={() => onResolve()}>2. Resolve</button>
        <button disabled={!!busy || !draftCount} onClick={onCreateDrafts}>3. Create drafts ({draftCount})</button>
        {confirmSend ? (
          <button disabled={!!busy} onClick={onSendAll} style={{ fontWeight: 700 }}>Confirm send {sendable}</button>
        ) : (
          <button disabled={!!busy || !sendable} onClick={() => setConfirmSend(true)}>4. Send all drafts ({sendable})</button>
        )}
        {run.stage !== 'idle' ? <button disabled={!!busy} onClick={() => save(EMPTY_RUN)}>Clear</button> : null}
      </div>

      {busy ? <div style={{ color: 'var(--mint-fg-soft)' }}>{busy}</div> : null}
      {error ? <div style={{ color: 'var(--mint-fg-danger, #b00020)' }}>{error}</div> : null}
      {run.skippedUnknownSender > 0 ? (
        <div style={{ color: 'var(--mint-fg-soft)' }}>
          {run.skippedUnknownSender} unread email(s) from senders not on the Insurers tab were skipped. Check the inbox.
        </div>
      ) : null}

      {pasteMode ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button onClick={() => navigator.clipboard.writeText(run.sql)}>Copy SQL</button>
          <div style={{ fontSize: 'var(--mint-text-nano)' }}>
            Run it in Preset SQL Lab (Pantheon), copy the result table, paste below.
          </div>
          <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button disabled={!pasted.trim()} onClick={() => onResolve(parsePastedResults(pasted))}>Use pasted results</button>
        </div>
      ) : null}

      {run.rows.map((r, i) => {
        const res = r.res;
        const icon = !res ? '•' : r.sent === 'ok' ? '📤' : res.status === 'matched' ? '✅' : res.status === 'needs_review' ? '⚠️' : '❌';
        return (
          <div key={r.req.messageId} style={{ border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-2)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{icon}</span>
              <strong>{r.req.cardholderName?.raw ?? '(no name)'}</strong>
              <span>· ****{r.req.last4 ?? '????'}</span>
              <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)' }}>{r.req.insurerEmail}</span>
            </div>
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
              Emails: {r.req.emails.join(', ') || '—'} · Phone: {r.req.phone ?? '—'}
              {progress[r.req.messageId] ? ` · ${progress[r.req.messageId]}` : ''}
            </div>
            {res ? (
              <div style={{ fontSize: 'var(--mint-text-nano)' }}>
                {res.method ? `Matched: ${res.method}` : 'Not matched'} — {res.note}
                {res.flags.map((f) => <div key={f}>⚠️ {FLAG_TEXT[f] ?? f}</div>)}
                {res.candidates.map((c) => <div key={c.identityId}>• {c.name} — {c.clientEmail} ({c.identityId})</div>)}
              </div>
            ) : null}
            {r.draftBody ? (
              <>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--mint-text-nano)' }}>
                  <input
                    type="checkbox"
                    checked={r.selected}
                    disabled={!!r.draftId}
                    onChange={(e) => {
                      const rows = [...run.rows];
                      rows[i] = { ...r, selected: e.target.checked };
                      save({ ...run, rows });
                    }}
                  />
                  {r.draftId ? 'Drafted' : 'Create a draft for this request'}
                </label>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--mint-text-nano)', background: 'var(--mint-bg-subtle)', padding: 6 }}>{r.draftBody}</pre>
              </>
            ) : null}
            {r.sent === 'failed' ? <div style={{ color: 'var(--mint-fg-danger, #b00020)' }}>Send failed: {r.sendError}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
