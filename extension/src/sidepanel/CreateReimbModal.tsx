// "Create REIMB Ticket" modal — opens from the side-panel button row.
// Mirrors MoveModal's shell pattern (overlay + modal + portal-friendly).
// Submit flow is wired in the next task; this file renders the UI only.

import { useState, useEffect, useRef } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import {
  CURRENCY_LABELS,
  type Currency,
  INCIDENT_RELATED_LABELS,
  type IncidentRelated,
  REQUESTOR_TEAM_LABELS,
  REIMBURSEMENT_REASON_LABELS,
  MODAL_DEFAULTS,
  defaultApproverKey,
  buildDescriptionTemplate,
  tierToUserTierLabel,
  type UserTier,
  REIMB_PROJECT_KEY,
  REIMB_REIMBURSEMENT_ISSUETYPE_ID,
  REIMB_FIELDS,
} from '../data/reimbConfig';
import {
  REIMB_APPROVERS,
  REIMB_APPROVER_KEYS,
  type ReimbApproverKey,
  searchJiraUsers,
  type JiraUserSearchResult,
  createReimbTicketFromForm,
  resolveOptionId,
  postComment,
  transitionTicket,
} from '../api/jira';
import { fetchAtlasAccountIdHeadless } from '../data/atlasAccountLookup';

type Status = 'configuring' | 'confirming' | 'executing' | 'success' | 'error';

export function CreateReimbModal({ ticket, onClose, onCreated }: {
  ticket: WocooTicket;
  onClose: () => void;
  onCreated?: (reimbKey: string, reimbUrl: string) => void;
}) {
  // ===== Field state =====
  const [summary, setSummary] = useState<string>(ticket.summary || '');
  const [accountIdInput, setAccountIdInput] = useState<string>(ticket.accountId || '');
  const [userTier, setUserTier] = useState<UserTier>(tierToUserTierLabel(ticket.tier));
  const [amountInput, setAmountInput] = useState<string>(
    ticket.totalReimbursementAmount != null ? String(ticket.totalReimbursementAmount) : '',
  );
  const [currency, setCurrency] = useState<Currency>(MODAL_DEFAULTS.currency);
  const [reimbursementReason, setReimbursementReason] = useState<string>('');
  const [requestorTeam, setRequestorTeam] = useState<string>(MODAL_DEFAULTS.requestorTeam);
  const [incidentRelated, setIncidentRelated] = useState<IncidentRelated>(MODAL_DEFAULTS.incidentRelated);

  // Approver — Luke / Amanda / Vivian quick-pick OR free Jira user search
  type ApproverChoice = { accountId: string; displayName: string };
  const initialAmount = ticket.totalReimbursementAmount ?? null;
  const initialApproverKey = defaultApproverKey(initialAmount);
  const [approver, setApprover] = useState<ApproverChoice>({
    accountId: REIMB_APPROVERS[initialApproverKey].accountId,
    displayName: REIMB_APPROVERS[initialApproverKey].name,
  });

  // Description (live re-templates until first manual edit)
  const [descriptionDirty, setDescriptionDirty] = useState<boolean>(false);
  const [description, setDescription] = useState<string>('');

  // ===== Derived =====
  const accountId = accountIdInput.trim().toUpperCase();
  const accountIdValid = /^[CHWN][0-9A-Z]{7,}$/i.test(accountId);
  const amount = parseFloat(amountInput);
  const amountValid = !isNaN(amount) && isFinite(amount);
  const identityId = ticket.identityId || '';
  const sourceUrl = `https://wealthsimple.atlassian.net/browse/${ticket.id}`;

  // Re-template description whenever amount or identity changes — unless dirty
  useEffect(() => {
    if (descriptionDirty) return;
    if (!identityId || !amountValid) {
      setDescription('');
      return;
    }
    setDescription(buildDescriptionTemplate(identityId, amount, sourceUrl));
  }, [identityId, amount, amountValid, sourceUrl, descriptionDirty]);

  // Clearing the textarea entirely resets the dirty flag so the template re-fills
  function onDescriptionChange(v: string) {
    setDescription(v);
    if (v === '') setDescriptionDirty(false);
    else setDescriptionDirty(true);
  }

  // ===== Status / submit (Task 4 wires this) =====
  const [status, setStatus] = useState<Status>('configuring');
  const [error, setError] = useState<string | null>(null);
  const [softWarnings, setSoftWarnings] = useState<string[]>([]);
  const [reimbKey, setReimbKey] = useState<string | null>(null);
  const [reimbUrl, setReimbUrl] = useState<string | null>(null);

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && status !== 'executing') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, status]);

  // ===== Validation gate =====
  const reimbReady =
    !!identityId &&
    accountIdValid &&
    amountValid &&
    summary.trim().length > 0 &&
    !!reimbursementReason &&
    !!approver.accountId;

  async function execute() {
    setStatus('executing');
    setError(null);
    setSoftWarnings([]);

    try {
      if (!identityId) throw new Error('Source ticket has no Identity ID.');
      if (!accountIdValid) throw new Error('Account ID format is invalid (need C/H/W/N + 7+ chars).');
      if (!amountValid) throw new Error('Amount is not a valid number.');
      if (!reimbursementReason) throw new Error('Pick a Reimbursement Reason first.');
      if (!summary.trim()) throw new Error('Summary is required.');
      if (!approver.accountId) throw new Error('Pick an approver.');

      // Resolve the 4 option IDs in parallel. Cached via jira_option_lookup_cache.
      const [currencyId, requestorTeamId, reimbursementReasonId, incidentRelatedId] = await Promise.all([
        resolveOptionId(REIMB_PROJECT_KEY, REIMB_REIMBURSEMENT_ISSUETYPE_ID, REIMB_FIELDS.CURRENCY, currency),
        resolveOptionId(REIMB_PROJECT_KEY, REIMB_REIMBURSEMENT_ISSUETYPE_ID, REIMB_FIELDS.REQUESTOR_TEAM, requestorTeam),
        resolveOptionId(REIMB_PROJECT_KEY, REIMB_REIMBURSEMENT_ISSUETYPE_ID, REIMB_FIELDS.REIMBURSEMENT_REASON, reimbursementReason),
        resolveOptionId(REIMB_PROJECT_KEY, REIMB_REIMBURSEMENT_ISSUETYPE_ID, REIMB_FIELDS.INCIDENT_RELATED, incidentRelated),
      ]);

      // Create the REIMB ticket.
      const created = await createReimbTicketFromForm({
        identityId,
        amount,
        accountId,
        tier: userTier,
        approverAccountId: approver.accountId,
        summary: summary.trim(),
        description: description.trim() ? description : buildDescriptionTemplate(identityId, amount, sourceUrl),
        currencyId,
        requestorTeamId,
        reimbursementReasonId,
        incidentRelatedId,
      });

      setReimbKey(created.key);
      setReimbUrl(created.url);

      const warnings: string[] = [];

      // Post comment on the source WOCOO ticket (soft failure → warning).
      try {
        const reporterAccountId = (ticket as any).reporterAccountId as string | undefined;
        await postComment(ticket.id, [
          { type: 'text', text: 'Hi ' },
          reporterAccountId
            ? { type: 'mention', text: '@' + (ticket.reporter || 'team'), accountId: reporterAccountId }
            : { type: 'text', text: '@' + (ticket.reporter || 'team') },
          { type: 'text', text: ' reimbursement ticket has been created! ' },
          { type: 'link', text: created.url, href: created.url },
        ]);
      } catch (e: any) {
        warnings.push(`REIMB created, but comment on ${ticket.id} failed: ${e?.message || String(e)}. Link it manually in Jira.`);
      }

      // Transition the source WOCOO to Done (soft failure → warning).
      try {
        await transitionTicket(ticket.id, '251');
      } catch (e: any) {
        warnings.push(`REIMB created and comment posted, but Move-to-Done on ${ticket.id} failed: ${e?.message || String(e)}. Close it manually in Jira.`);
      }

      setSoftWarnings(warnings);
      setStatus('success');
      if (onCreated) onCreated(created.key, created.url);
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus('error');
    }
  }

  // ===== Render =====
  return (
    <Overlay onClick={onClose}>
      <Modal onClick={(e) => e.stopPropagation()}>
        <header style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)' }}>
            Create REIMB ticket from <span style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticket.id}</span>
          </h2>
          <button onClick={onClose} aria-label="Close" style={iconButtonStyle}>×</button>
        </header>

        <div style={bodyStyle}>
          {status === 'success' && reimbKey ? (
            <SuccessPanel
              ticketId={ticket.id}
              reimbKey={reimbKey}
              reimbUrl={reimbUrl!}
              warnings={softWarnings}
              onClose={onClose}
            />
          ) : (
            <>
              {/* Summary */}
              <Section label="Summary">
                <input
                  type="text"
                  value={summary}
                  disabled={status === 'confirming' || status === 'executing'}
                  onChange={(e) => setSummary(e.target.value)}
                  style={textInputStyle}
                />
              </Section>

              {/* Description */}
              <Section label="Description">
                <textarea
                  value={description}
                  disabled={status === 'confirming' || status === 'executing'}
                  onChange={(e) => onDescriptionChange(e.target.value)}
                  rows={5}
                  style={{ ...textInputStyle, fontFamily: 'var(--mint-font-family)', lineHeight: 1.5, resize: 'vertical' }}
                />
                <Hint>
                  {descriptionDirty
                    ? 'Edited manually. Clear the field to restore the template.'
                    : 'Auto-fills from the source ticket. Edit to override.'}
                </Hint>
              </Section>

              {/* Account ID + Atlas Fetch */}
              <Section label={<>Account ID (W#) <Required /></>}>
                <AccountIdInputWithFetch
                  ticket={ticket}
                  value={accountIdInput}
                  valid={accountIdValid}
                  locked={status === 'confirming' || status === 'executing'}
                  onChange={(v) => setAccountIdInput(v.toUpperCase())}
                />
              </Section>

              {/* User Tier */}
              <Section label="User Tier">
                <ToggleRow
                  options={['Core', 'Premium', 'Generation'] as const}
                  value={userTier}
                  onChange={(v) => setUserTier(v as UserTier)}
                  locked={status === 'confirming' || status === 'executing'}
                  variant="warning"
                />
              </Section>

              {/* User Identity ID (read-only) */}
              <Section label="User Identity ID">
                <div style={{ ...textInputStyle, background: 'var(--mint-bg-subtle)', color: 'var(--mint-fg-subdued-title)', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)' }}>
                  {identityId || <span style={{ fontStyle: 'italic', color: 'var(--mint-negative-fg-strong)' }}>missing</span>}
                </div>
              </Section>

              {/* Amount */}
              <Section label={<>Total reimbursement amount <Required /></>}>
                <input
                  type="number"
                  step="0.01"
                  value={amountInput}
                  disabled={status === 'confirming' || status === 'executing'}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="e.g. 211.68"
                  style={{ ...textInputStyle, fontFamily: 'var(--mint-font-mono)' }}
                />
                {amountInput && !amountValid && (
                  <Hint negative>Not a number.</Hint>
                )}
              </Section>

              {/* Currency */}
              <Section label="Currency">
                <ToggleRow
                  options={CURRENCY_LABELS}
                  value={currency}
                  onChange={(v) => setCurrency(v as Currency)}
                  locked={status === 'confirming' || status === 'executing'}
                />
              </Section>

              {/* Reimbursement Reason */}
              <Section label={<>Reimbursement Reason <Required /></>}>
                <select
                  value={reimbursementReason}
                  disabled={status === 'confirming' || status === 'executing'}
                  onChange={(e) => setReimbursementReason(e.target.value)}
                  style={textInputStyle}
                >
                  <option value="">Select a reason…</option>
                  {REIMBURSEMENT_REASON_LABELS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </Section>

              {/* Requestor team */}
              <Section label="Requestor team">
                <select
                  value={requestorTeam}
                  disabled={status === 'confirming' || status === 'executing'}
                  onChange={(e) => setRequestorTeam(e.target.value)}
                  style={textInputStyle}
                >
                  {REQUESTOR_TEAM_LABELS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Section>

              {/* Approver — quick-pick + free search */}
              <Section label={<>Next Level Approval <Required /></>}>
                <ApproverPicker
                  value={approver}
                  onChange={setApprover}
                  locked={status === 'confirming' || status === 'executing'}
                />
              </Section>

              {/* Incident Related */}
              <Section label="Incident Related?">
                <ToggleRow
                  options={INCIDENT_RELATED_LABELS}
                  value={incidentRelated}
                  onChange={(v) => setIncidentRelated(v as IncidentRelated)}
                  locked={status === 'confirming' || status === 'executing'}
                />
              </Section>

              {error && (
                <div style={{ background: 'var(--mint-negative-bg-soft)', color: 'var(--mint-negative-fg-strong)', padding: 'var(--mint-sp-2) var(--mint-sp-3)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-meta)' }}>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {status !== 'success' && (
          <footer style={footerStyle}>
            {status === 'confirming' ? (
              <ConfirmRow ticketId={ticket.id} onConfirm={execute} onBack={() => setStatus('configuring')} />
            ) : (
              <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', justifyContent: 'flex-end' }}>
                <button onClick={onClose} style={secondaryButton}>Cancel</button>
                <button
                  onClick={() => setStatus('confirming')}
                  disabled={!reimbReady || status === 'executing'}
                  style={{ ...primaryButton, opacity: reimbReady && status !== 'executing' ? 1 : 0.55, cursor: reimbReady && status !== 'executing' ? 'pointer' : 'not-allowed' }}
                >
                  {status === 'executing' ? 'Creating REIMB…' : status === 'error' ? 'Try Again' : 'Review & Create REIMB'}
                </button>
              </div>
            )}
          </footer>
        )}
      </Modal>
    </Overlay>
  );
}

// ===== Sub-components =====

function AccountIdInputWithFetch({ ticket, value, valid, locked, onChange }: {
  ticket: WocooTicket;
  value: string;
  valid: boolean;
  locked: boolean;
  onChange: (v: string) => void;
}) {
  const [fetchPending, setFetchPending] = useState(false);

  async function fetchAccountId() {
    if (!ticket.identityId || fetchPending) return;
    setFetchPending(true);
    try {
      const { accountNumber } = await fetchAtlasAccountIdHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id });
      onChange(accountNumber);
    } catch {
      // user can retry
    } finally {
      setFetchPending(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={value}
          disabled={locked}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. WK5TPMJ32CAD"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '6px 10px',
            fontFamily: 'var(--mint-font-mono)',
            fontSize: 'var(--mint-text-micro)',
            border: '1px solid ' + (valid || !value ? 'var(--mint-outline-strong)' : 'var(--mint-negative-fg-graphic)'),
            borderRadius: 'var(--mint-radius-button)',
            background: 'var(--mint-bg-card)',
            color: 'var(--mint-fg-strong)',
            boxSizing: 'border-box',
          }}
        />
        <button
          onClick={fetchAccountId}
          disabled={!ticket.identityId || locked || fetchPending}
          title="Open Atlas → CHEQUING (SPEND) → read Account Number"
          style={{
            padding: '4px 10px',
            background: 'var(--mint-highlight-fg-graphic)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--mint-radius-button)',
            fontSize: 'var(--mint-text-nano)',
            fontWeight: 700,
            cursor: !ticket.identityId || locked || fetchPending ? 'not-allowed' : 'pointer',
            opacity: !ticket.identityId || locked || fetchPending ? 0.6 : 1,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {fetchPending ? 'Fetching…' : '↗ Fetch'}
        </button>
      </div>
      {value && !valid && (
        <Hint negative>Invalid format. Need C/H/W/N + 7+ alphanumeric chars.</Hint>
      )}
      {fetchPending && (
        <Hint>Waiting for Atlas Portfolio Details… (CHEQUING (SPEND) will be clicked automatically)</Hint>
      )}
    </>
  );
}

function ApproverPicker({ value, onChange, locked }: {
  value: { accountId: string; displayName: string };
  onChange: (v: { accountId: string; displayName: string }) => void;
  locked: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<JiraUserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Quick-pick handler
  function pickQuick(key: ReimbApproverKey) {
    const info = REIMB_APPROVERS[key];
    onChange({ accountId: info.accountId, displayName: info.name });
    setQuery('');
    setResults([]);
  }

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearchError(null);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await searchJiraUsers(query);
        setResults(r);
      } catch (e: any) {
        setSearchError(e?.message || String(e));
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [query]);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--mint-sp-2)', marginBottom: 6 }}>
        {REIMB_APPROVER_KEYS.map((k) => {
          const info = REIMB_APPROVERS[k];
          const active = value.accountId === info.accountId;
          return (
            <button
              key={k}
              disabled={locked}
              onClick={() => pickQuick(k)}
              style={quickPickStyle(active, locked)}
            >
              {active ? '✓ ' : ''}{info.name}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginBottom: 4 }}>
        Or search for someone else:
      </div>
      <input
        type="text"
        value={query}
        disabled={locked}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type a name…"
        style={textInputStyle}
      />
      {searching && <Hint>Searching…</Hint>}
      {searchError && <Hint negative>Search failed: {searchError}</Hint>}
      {results.length > 0 && (
        <div style={{ marginTop: 4, border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', maxHeight: 180, overflowY: 'auto', background: 'var(--mint-bg-card)' }}>
          {results.map((u) => (
            <div
              key={u.accountId}
              onClick={() => { onChange({ accountId: u.accountId, displayName: u.displayName }); setQuery(''); setResults([]); }}
              style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 'var(--mint-text-meta)', borderBottom: '1px solid var(--mint-outline)', color: 'var(--mint-fg-strong)' }}
            >
              {u.displayName}
              {u.emailAddress ? <span style={{ color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-nano)', marginLeft: 8 }}>{u.emailAddress}</span> : null}
            </div>
          ))}
        </div>
      )}
      {query && !searching && !searchError && results.length === 0 && (
        <Hint>No users match. Use a quick-pick above ({REIMB_APPROVER_KEYS.map((k) => REIMB_APPROVERS[k].name).join(', ')}).</Hint>
      )}
      <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)' }}>
        Selected: <strong style={{ color: 'var(--mint-fg-strong)' }}>{value.displayName}</strong>
      </div>
    </>
  );
}

function ToggleRow<T extends string>({ options, value, onChange, locked, variant = 'default' }: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  locked: boolean;
  variant?: 'default' | 'warning';
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
      {options.map((o) => {
        const active = value === o;
        const activeBg = variant === 'warning' ? 'var(--mint-warning-fg-graphic)' : 'var(--mint-fg-strong)';
        const activeFg = variant === 'warning' ? '#fff' : 'var(--mint-fg-inverted)';
        return (
          <button
            key={o}
            disabled={locked}
            onClick={() => onChange(o)}
            style={{
              flex: 1,
              padding: '6px 12px',
              background: active ? activeBg : 'var(--mint-bg-card)',
              color: active ? activeFg : 'var(--mint-fg-strong)',
              border: 'var(--mint-card-stroke)',
              borderRadius: 'var(--mint-radius-button)',
              fontWeight: 600,
              fontSize: 'var(--mint-text-meta)',
              cursor: locked ? 'not-allowed' : 'pointer',
              opacity: locked ? 0.6 : 1,
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function ConfirmRow({ ticketId, onConfirm, onBack }: { ticketId: string; onConfirm: () => void; onBack: () => void }) {
  return (
    <div style={{ background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-3)', width: '100%' }}>
      <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 600, color: 'var(--mint-warning-fg-strong)', marginBottom: 'var(--mint-sp-2)' }}>
        Create REIMB from {ticketId}, post a link comment to it, then transition {ticketId} to Done?
      </div>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <button onClick={onConfirm} style={{ ...primaryButton, background: 'var(--mint-positive-fg-graphic)' }}>✓ Confirm Create</button>
        <button onClick={onBack} style={secondaryButton}>← Back to Edit</button>
      </div>
    </div>
  );
}

function SuccessPanel({ ticketId, reimbKey, reimbUrl, warnings, onClose }: {
  ticketId: string;
  reimbKey: string;
  reimbUrl: string;
  warnings: string[];
  onClose: () => void;
}) {
  return (
    <div style={{ padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ fontSize: 24, marginBottom: 'var(--mint-sp-2)' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-positive-fg-strong)' }}>REIMB ticket created</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)' }}>
        <a href={reimbUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 600 }}>{reimbKey}</a>
      </p>
      <p style={{ margin: 0, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        Source ticket {ticketId} has been commented on and transitioned to Done. Open Jira to verify.
      </p>
      {warnings.length > 0 && (
        <ul style={{ textAlign: 'left', margin: 'var(--mint-sp-3) 0 0', padding: '8px 12px', background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', listStyle: 'disc', paddingLeft: 24 }}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <button onClick={onClose} style={{ ...primaryButton, marginTop: 'var(--mint-sp-3)' }}>Close</button>
    </div>
  );
}

// ===== Layout helpers =====

function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', marginBottom: 'var(--mint-sp-3)' }}>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </section>
  );
}

function Hint({ children, negative }: { children: React.ReactNode; negative?: boolean }) {
  return (
    <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: negative ? 'var(--mint-negative-fg-strong)' : 'var(--mint-fg-soft)' }}>
      {children}
    </div>
  );
}

function Required() {
  return <span style={{ color: 'var(--mint-negative-fg-strong)' }}>*</span>;
}

function quickPickStyle(active: boolean, locked: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '6px 12px',
    background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)',
    color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)',
    border: 'var(--mint-card-stroke)',
    borderRadius: 'var(--mint-radius-button)',
    fontWeight: 600,
    fontSize: 'var(--mint-text-meta)',
    cursor: locked ? 'not-allowed' : 'pointer',
    opacity: locked ? 0.6 : 1,
  };
}

// ===== Shells (copied from MoveModal pattern) =====

function Overlay({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,17,12,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--mint-sp-3)', zIndex: 1000 }}
    >
      {children}
    </div>
  );
}

function Modal({ onClick, children }: { onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{ background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', maxWidth: 480, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(20,17,12,0.25)' }}
    >
      {children}
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: 'var(--mint-sp-3) var(--mint-sp-4)',
  borderBottom: 'var(--mint-card-stroke)',
};
const bodyStyle: React.CSSProperties = {
  padding: 'var(--mint-sp-3) var(--mint-sp-4)',
  overflowY: 'auto',
  flex: 1,
  display: 'flex', flexDirection: 'column',
};
const footerStyle: React.CSSProperties = {
  padding: 'var(--mint-sp-3) var(--mint-sp-4)',
  borderTop: 'var(--mint-card-stroke)',
  display: 'flex', justifyContent: 'flex-end',
};
const iconButtonStyle: React.CSSProperties = {
  width: 28, height: 28, padding: 0, background: 'transparent', border: 'none', borderRadius: 6,
  color: 'var(--mint-fg-soft)', fontSize: 20, cursor: 'pointer',
};
const primaryButton: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 'var(--mint-radius-button)', fontWeight: 600,
  fontSize: 'var(--mint-text-meta)', border: 'none',
  background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', cursor: 'pointer',
};
const secondaryButton: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 'var(--mint-radius-button)', fontWeight: 600,
  fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', cursor: 'pointer',
};
const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-meta)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};
