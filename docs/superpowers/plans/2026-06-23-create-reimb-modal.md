# Create REIMB Ticket Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Create REIMB Ticket" half-width button next to Verify Eligible DD in the side panel. Clicking opens a modal that lets the agent fill 11 REIMB fields with extensive autofill, then creates the REIMB ticket, posts a link comment on the source WOCOO, and transitions the source to Done.

**Architecture:** New file `src/data/reimbConfig.ts` for REIMB constants and types. New file `src/sidepanel/CreateReimbModal.tsx` for the full modal, mirroring `MoveModal`'s shell pattern. Two additions to `src/api/jira.ts`: `createReimbTicketFromForm` (separate from existing `createReimbTicket`, intentional payload-builder duplication to keep OverpaymentTriage off the change list) and `searchJiraUsers` (wraps Jira's `/rest/api/3/user/picker`). Small `src/sidepanel/SidePanel.tsx` edit to split the Verify Eligible DD row and mount the modal.

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through real WOCOO tickets.

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step. Do not introduce a test framework.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **OverpaymentTriage and `createReimbTicket` are untouched.** Do not modify `src/sidepanel/OverpaymentTriage.tsx` or the existing `createReimbTicket` function in `src/api/jira.ts`. The new modal calls a separate `createReimbTicketFromForm`.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports.
- **REIMB project ID `'REIMB'`, Reimbursement issuetype ID `'11471'`.** Hardcode these — do not look up by name.
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification.

---

## File Structure

| Path | New? | Responsibility |
|---|---|---|
| `src/data/reimbConfig.ts` | new | REIMB constants (project key, issuetype ID, field IDs), option label arrays, `MODAL_DEFAULTS`, helpers (`defaultApproverKey`, `buildDescriptionTemplate`). |
| `src/api/jira.ts` | modify | Add `createReimbTicketFromForm(args)` and `searchJiraUsers(query)`. Add types. No edits to existing functions. |
| `src/sidepanel/CreateReimbModal.tsx` | new | Self-contained modal: shell + 11 form fields + Approver picker (Luke/Amanda + free search) + validation + submit flow + success panel. |
| `src/sidepanel/SidePanel.tsx` | modify | Split Verify Eligible DD row into 2 half-width buttons; add Create REIMB Ticket button; mount `<CreateReimbModal>` on click. |

---

## Task 1: Create reimbConfig.ts

**Files:**
- Create: `src/data/reimbConfig.ts`

**Interfaces:**
- Consumes: `UserTier`, `tierToUserTierLabel` from `../data/moveConfig` (already exported; same Core/Premium/Generation labels apply).
- Produces:
  - `REIMB_PROJECT_KEY: 'REIMB'`
  - `REIMB_REIMBURSEMENT_ISSUETYPE_ID: '11471'`
  - `REIMB_FIELDS` — record of customfield IDs
  - `CURRENCY_LABELS`, `Currency` type
  - `INCIDENT_RELATED_LABELS`, `IncidentRelated` type
  - `REQUESTOR_TEAM_LABELS`, `REIMBURSEMENT_REASON_LABELS`
  - `MODAL_DEFAULTS` — record of UI default labels
  - `defaultApproverKey(amount: number | null): 'luke' | 'amanda'`
  - `buildDescriptionTemplate(identityId: string, amount: number, sourceUrl: string): string`

- [ ] **Step 1: Create the file** at `src/data/reimbConfig.ts` with the following content verbatim:

```ts
// REIMB ticket creation constants — used by the "Create REIMB Ticket" side-panel
// modal. OverpaymentTriage's existing hardcoded path in jira.ts is independent.

import { tierToUserTierLabel, type UserTier } from './moveConfig';

export { tierToUserTierLabel };
export type { UserTier };

export const REIMB_PROJECT_KEY = 'REIMB';
export const REIMB_REIMBURSEMENT_ISSUETYPE_ID = '11471';

// Field IDs for the Reimbursement issuetype (11471). Discovered via
// jira_get_project_metadata on 2026-06-23.
export const REIMB_FIELDS = {
  ACCOUNT_ID:           'customfield_10082',
  CURRENCY:             'customfield_10213',
  AMOUNT:               'customfield_10285',
  REQUESTOR_TEAM:       'customfield_10287',
  REIMBURSEMENT_REASON: 'customfield_10288',
  APPROVER:             'customfield_10315',
  USER_TIER:            'customfield_11416',
  IDENTITY_ID:          'customfield_11458',
  INCIDENT_RELATED:     'customfield_12419',
} as const;

export const CURRENCY_LABELS = ['CAD', 'USD'] as const;
export type Currency = (typeof CURRENCY_LABELS)[number];

export const INCIDENT_RELATED_LABELS = ['No', 'Yes'] as const;
export type IncidentRelated = (typeof INCIDENT_RELATED_LABELS)[number];

// 5 of 7 observed in real REIMB tickets; remaining 2 will surface via createmeta on first use.
export const REQUESTOR_TEAM_LABELS = [
  'Operations Cash',
  'CX - Standard',
  'CX - Premium',
  'Operations FFR',
  'Other',
] as const;

// 6 observed across recent REIMB tickets; full list has 21. Discoverable on first use.
export const REIMBURSEMENT_REASON_LABELS = [
  'Reimburse to Close',
  'General Promotion',
  'Reimbursement Fees',
  'AP Write Offs',
  'Transfer Fee Reimbursement',
  'Missed Returns Reimbursement',
] as const;

// UI defaults — the new modal resolves these labels to option IDs at submit time.
export const MODAL_DEFAULTS = {
  currency:        'CAD' as Currency,
  requestorTeam:   'Operations Cash',
  incidentRelated: 'No' as IncidentRelated,
} as const;

/** Luke for amounts < $5K, Amanda for ≥ $5K — matches OverpaymentTriage's existing logic. */
export function defaultApproverKey(amount: number | null): 'luke' | 'amanda' {
  return amount != null && amount >= 5000 ? 'amanda' : 'luke';
}

/**
 * REIMB description template modeled on REIMB-42740's actual description:
 *
 *   Hi team, can we please reimburse this client (identity-XXX) for $211.68? Reference ticket:
 *
 *   https://wealthsimple.atlassian.net/browse/WOCOO-23296
 */
export function buildDescriptionTemplate(identityId: string, amount: number, sourceUrl: string): string {
  return `Hi team, can we please reimburse this client (${identityId}) for $${amount.toFixed(2)}? Reference ticket:\n\n${sourceUrl}`;
}
```

- [ ] **Step 2: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes with no TypeScript errors. The `dist/` folder rebuilds.

---

## Task 2: Add createReimbTicketFromForm + searchJiraUsers to jira.ts

**Files:**
- Modify: `src/api/jira.ts` — add new exports at the bottom of the existing REIMB section (around the end of the `createReimbTicket` block).

**Interfaces:**
- Consumes: existing `jiraFetch`, `REIMB_TIER_IDS` (already in `jira.ts`).
- Produces:
  - `interface CreateReimbFromFormArgs { ... }` — 11 fields, see step 1.
  - `createReimbTicketFromForm(args: CreateReimbFromFormArgs): Promise<{ key: string; url: string }>`
  - `interface JiraUserSearchResult { accountId, displayName, emailAddress?, avatarUrl? }`
  - `searchJiraUsers(query: string): Promise<JiraUserSearchResult[]>`

- [ ] **Step 1: Open `src/api/jira.ts`.** Locate the end of `createReimbTicket` (around line 225, just before the `// ============ Comment posting ...` section).

- [ ] **Step 2: Insert the new exports** immediately after the existing `createReimbTicket` function, before the `// ============ Comment posting` comment. Paste this block verbatim:

```ts
// ============ Generic REIMB creation (Create REIMB Ticket modal) ============
// Parallel to createReimbTicket above. Kept separate so OverpaymentTriage's
// hardcoded fast-path and the new agent-filled modal can evolve independently.

export interface CreateReimbFromFormArgs {
  identityId: string;
  amount: number;
  accountId: string;
  tier: 'Core' | 'Premium' | 'Generation';
  approverAccountId: string;
  summary: string;
  description: string;
  currencyId: string;
  requestorTeamId: string;
  reimbursementReasonId: string;
  incidentRelatedId: string;
}

/** Create a REIMB ticket from explicit form values. Returns the new key + url. */
export async function createReimbTicketFromForm(args: CreateReimbFromFormArgs): Promise<{ key: string; url: string }> {
  const tierId = REIMB_TIER_IDS[args.tier];
  if (!tierId) throw new Error(`Unknown tier: ${args.tier}`);

  const payload = {
    fields: {
      project: { key: 'REIMB' },
      issuetype: { name: 'Reimbursement' },
      summary: args.summary,
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description }] }],
      },
      priority: { name: 'Medium' },
      customfield_10082: args.accountId.toUpperCase(),
      customfield_10213: { id: args.currencyId },
      customfield_10285: args.amount,
      customfield_10287: { id: args.requestorTeamId },
      customfield_10288: { id: args.reimbursementReasonId },
      customfield_10315: { accountId: args.approverAccountId },
      customfield_11416: { id: tierId },
      customfield_11458: args.identityId,
      customfield_12419: { id: args.incidentRelatedId },
    },
  };

  const resp = await jiraFetch('/rest/api/3/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`REIMB creation failed (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  if (!data.key) throw new Error('Jira returned no ticket key from REIMB creation.');
  return { key: data.key, url: `https://wealthsimple.atlassian.net/browse/${data.key}` };
}

// ============ Jira user search (for the REIMB modal's Approver "Other" picker) ============

export interface JiraUserSearchResult {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
}

/**
 * Search for Jira users via /rest/api/3/user/picker. Returns up to 10 matches.
 * Empty/whitespace query returns []. Caller is expected to debounce.
 */
export async function searchJiraUsers(query: string): Promise<JiraUserSearchResult[]> {
  if (!query.trim()) return [];
  const url = `/rest/api/3/user/picker?query=${encodeURIComponent(query)}&maxResults=10`;
  const resp = await jiraFetch(url);
  if (!resp.ok) throw new Error(`User search failed (HTTP ${resp.status})`);
  const data = await resp.json();
  return (data.users || []).map((u: any) => ({
    accountId: u.accountId,
    displayName: u.displayName,
    emailAddress: u.emailAddress,
    avatarUrl: u.avatarUrls?.['24x24'] ?? u.avatarUrl,
  }));
}
```

- [ ] **Step 3: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 4: Sanity-grep that existing `createReimbTicket` is unchanged.**

Run:
```bash
grep -n 'createReimbTicket\|createReimbTicketFromForm' /Users/albert.cai/projects/wocoo-extension/extension/src/api/jira.ts
```
Expected: both function names present. `createReimbTicket` should still appear with the OverpaymentTriage signature (single function, hardcoded option IDs in its payload).

---

## Task 3: Create CreateReimbModal.tsx (UI only) + wire it into SidePanel.tsx

**Files:**
- Create: `src/sidepanel/CreateReimbModal.tsx`
- Modify: `src/sidepanel/SidePanel.tsx` — split Verify Eligible DD row, add Create REIMB Ticket button, mount modal.

**Interfaces:**
- Consumes:
  - From Task 1: `MODAL_DEFAULTS`, `CURRENCY_LABELS`, `Currency`, `INCIDENT_RELATED_LABELS`, `IncidentRelated`, `REQUESTOR_TEAM_LABELS`, `REIMBURSEMENT_REASON_LABELS`, `defaultApproverKey`, `buildDescriptionTemplate`, `tierToUserTierLabel`, `UserTier`.
  - From Task 2: `searchJiraUsers`, `JiraUserSearchResult` (used in this task for the Approver picker).
  - Existing: `WocooTicket`, `fetchAtlasAccountIdHeadless`, `REIMB_APPROVERS` (from `../api/jira` — used to display the Luke/Amanda quick-pick buttons), and `useState`/`useEffect`/`useMemo`/`useRef` from React.
- Produces:
  - `export function CreateReimbModal({ ticket, onClose, onCreated }: ...)` — the modal. No submit wiring yet (Task 4); the Review button is rendered but `disabled` always with placeholder click handler.

- [ ] **Step 1: Create the file** at `src/sidepanel/CreateReimbModal.tsx` with this full content. The file mirrors `MoveModal.tsx`'s shell style (Overlay + Modal + Header + sectioned body + Cancel/Review footer):

```tsx
// "Create REIMB Ticket" modal — opens from the side-panel button row.
// Mirrors MoveModal's shell pattern (overlay + modal + portal-friendly).
// Submit flow is wired in the next task; this file renders the UI only.

import { useState, useEffect, useMemo, useRef } from 'react';
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
} from '../data/reimbConfig';
import { REIMB_APPROVERS, searchJiraUsers, type JiraUserSearchResult } from '../api/jira';
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

  // Approver — Luke / Amanda quick-pick OR free Jira user search
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

  // Submit handler — stubbed in Task 3, wired in Task 4
  async function executeStub() {
    setError('Submit flow not wired yet (Task 4).');
    setStatus('error');
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
              <ConfirmRow ticketId={ticket.id} onConfirm={executeStub} onBack={() => setStatus('configuring')} />
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
  function pickQuick(key: 'luke' | 'amanda') {
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

  const isLuke = value.accountId === REIMB_APPROVERS.luke.accountId;
  const isAmanda = value.accountId === REIMB_APPROVERS.amanda.accountId;

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginBottom: 6 }}>
        <button
          disabled={locked}
          onClick={() => pickQuick('luke')}
          style={quickPickStyle(isLuke, locked)}
        >
          {isLuke ? '✓ ' : ''}{REIMB_APPROVERS.luke.name}
        </button>
        <button
          disabled={locked}
          onClick={() => pickQuick('amanda')}
          style={quickPickStyle(isAmanda, locked)}
        >
          {isAmanda ? '✓ ' : ''}{REIMB_APPROVERS.amanda.name}
        </button>
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
        <Hint>No users match. Use {REIMB_APPROVERS.luke.name} or {REIMB_APPROVERS.amanda.name} quick-pick.</Hint>
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
```

- [ ] **Step 2: Open `src/sidepanel/SidePanel.tsx`** and find the Verify Eligible DD row (around line 576).

- [ ] **Step 3: Add the import** at the top of `SidePanel.tsx`. Find the existing `import { MoveModal }` line and add this import immediately below it:

```ts
import { CreateReimbModal } from './CreateReimbModal';
```

- [ ] **Step 4: Add `createReimbActive` state** next to the other modal-open state vars in `SidePanel.tsx`. Locate `const [reverseFeeActive, setReverseFeeActive] = useState(false);` (around line 147) and add this line immediately after it:

```ts
const [createReimbActive, setCreateReimbActive] = useState(false);
```

- [ ] **Step 5: Replace the Verify Eligible DD row** (currently lines 576-589 — a single full-width button) with the new split row. Find:

```tsx
      <div style={{ display: 'flex' }}>
        <ActionButton
          variant="highlight"
          onClick={() => {
            if (!ticket.identityId) return;
            void chrome.storage.local.set({ pending_preset_identity_id: ticket.identityId });
            window.open(VERIFY_ELIGIBLE_DD_URL, '_blank', 'noopener,noreferrer');
          }}
          disabled={!ticket.identityId}
          title="Open the direct-deposit-benefit-tiers Preset dashboard filtered by this identity"
        >
          📊 Verify Eligible DD
        </ActionButton>
      </div>
```

Replace with:

```tsx
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton
          variant="highlight"
          onClick={() => {
            if (!ticket.identityId) return;
            void chrome.storage.local.set({ pending_preset_identity_id: ticket.identityId });
            window.open(VERIFY_ELIGIBLE_DD_URL, '_blank', 'noopener,noreferrer');
          }}
          disabled={!ticket.identityId}
          title="Open the direct-deposit-benefit-tiers Preset dashboard filtered by this identity"
        >
          📊 Verify Eligible DD
        </ActionButton>
        <ActionButton
          variant="highlight"
          onClick={() => setCreateReimbActive(true)}
          disabled={!ticket.identityId}
          title="Create a new REIMB ticket from this WOCOO ticket"
        >
          💸 Create REIMB Ticket
        </ActionButton>
      </div>
```

- [ ] **Step 6: Mount the modal.** Find where `<MoveModal>` is rendered (search the file for `<MoveModal`). Immediately after that render block, add:

```tsx
{createReimbActive && (
  <CreateReimbModal
    ticket={ticket}
    onClose={() => setCreateReimbActive(false)}
  />
)}
```

- [ ] **Step 7: Build to confirm both files compile.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 8: Manual UI verification.**

  1. `chrome://extensions` → reload "WOCOO Triager" (unpacked).
  2. Open any WOCOO ticket with `identityId` populated.
  3. Confirm the bottom button row is now **Verify Eligible DD · Create REIMB Ticket** (half-width each).
  4. Click **Create REIMB Ticket** → modal opens with header "Create REIMB ticket from WOCOO-XXXXX".
  5. Confirm autofill:
     - Summary = source ticket's summary
     - Description = template `Hi team, can we please reimburse this client ({identity}) for $XXX.XX? Reference ticket:\n\n{url}`
     - Account ID = source ticket's accountId (if populated) — confirm Atlas Fetch button works on a ticket missing accountId
     - User Tier toggle = ticket's tier
     - User Identity ID = read-only, matches source
     - Amount = ticket.totalReimbursementAmount (if populated)
     - Currency toggle = CAD (highlighted)
     - Reimbursement Reason = "Select a reason…" empty
     - Requestor team = Operations Cash
     - Approver = Luke (highlighted, since default amount < $5K)
     - Incident Related? toggle = No (highlighted)
  6. **Review & Create REIMB** button: should be **disabled** until Reimbursement Reason is picked.
  7. Pick a Reimbursement Reason → button enables.
  8. Click the **Other** search input under Approver, type a name (e.g. "Albert"), expect a list of matching Jira users to appear (after ~300ms debounce). Click one — selected approver updates.
  9. Edit the description manually — confirm hint changes to "Edited manually. Clear the field to restore the template." Clear it entirely — confirm hint reverts and the template re-fills.
  10. Click **Review & Create REIMB** → confirm row shows. Click **✓ Confirm Create** → expect error toast: `Submit flow not wired yet (Task 4).` This is expected — submit is wired in Task 4.
  11. Close the modal (X, Esc, or Cancel) — modal disappears.

Do NOT use this to create a real REIMB. Submit is intentionally stubbed.

---

## Task 4: Wire the submit flow into CreateReimbModal

**Files:**
- Modify: `src/sidepanel/CreateReimbModal.tsx` — replace `executeStub` with the real `execute()` function. Add imports for `resolveOptionId`, `createReimbTicketFromForm`, `postComment`, `transitionTicket`, `REIMB_FIELDS`, `REIMB_PROJECT_KEY`, `REIMB_REIMBURSEMENT_ISSUETYPE_ID`.

**Interfaces:**
- Consumes:
  - From Task 1: `REIMB_PROJECT_KEY`, `REIMB_REIMBURSEMENT_ISSUETYPE_ID`, `REIMB_FIELDS`.
  - From Task 2: `createReimbTicketFromForm` and the existing `resolveOptionId`, `postComment`, `transitionTicket` from `jira.ts`.
- Produces: working end-to-end create flow. No new exports.

- [ ] **Step 1: Update the `../data/reimbConfig` import** to add the three constants:

```ts
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
```

- [ ] **Step 2: Update the `../api/jira` import** to add the submit-flow functions:

```ts
import {
  REIMB_APPROVERS,
  searchJiraUsers,
  type JiraUserSearchResult,
  createReimbTicketFromForm,
  resolveOptionId,
  postComment,
  transitionTicket,
} from '../api/jira';
```

- [ ] **Step 3: Replace the `executeStub` function** (the one that throws the placeholder error) with the real `execute` flow. Find:

```ts
  // Submit handler — stubbed in Task 3, wired in Task 4
  async function executeStub() {
    setError('Submit flow not wired yet (Task 4).');
    setStatus('error');
  }
```

Replace with:

```ts
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
        description: description.trim() || buildDescriptionTemplate(identityId, amount, sourceUrl),
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
```

- [ ] **Step 4: Update the ConfirmRow's `onConfirm` prop** to point at `execute` instead of `executeStub`. Find the `<ConfirmRow ticketId={ticket.id} onConfirm={executeStub} ...` line in the footer and change it to `onConfirm={execute}`.

- [ ] **Step 5: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 6: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 7: End-to-end test — happy path.**

  1. Open a WOCOO ticket safe for testing (one you're prepared to close to Done).
  2. Side panel → **Create REIMB Ticket** → modal opens.
  3. Confirm all autofill values are correct.
  4. Pick a Reimbursement Reason (e.g. "Reimburse to Close" or whatever fits).
  5. Adjust amount/currency/etc if needed.
  6. Approver: stick with the default Luke (or pick Amanda or search for another user).
  7. **Review & Create REIMB** → **✓ Confirm Create**.
  8. Watch for any errors.

Expected:
  - Success panel: "REIMB ticket created" with a linked REIMB-XXXXX key.
  - Open the new REIMB in Jira (link in success panel). Verify all 11 fields populated correctly: Summary, Description, Account ID, User Tier, Identity ID, Amount, Currency, Reimbursement Reason, Requestor team, Approver, Incident Related?.
  - Open the source WOCOO ticket. Verify:
    - New comment: `Hi @{reporter}  reimbursement ticket has been created!  https://wealthsimple.atlassian.net/browse/REIMB-XXXXX`
    - Status = Done.

If you see `Option "X" not found …` for any of the 4 option fields: the createmeta blank-labels risk has materialized. Stop and report; we'll add the autocomplete-endpoint fallback as a follow-up. (Same risk PFO Express Shipping was watching.)

- [ ] **Step 8: End-to-end test — minimal autofill + Atlas Fetch.**

  1. Find a WOCOO ticket missing `accountId` or `totalReimbursementAmount`.
  2. Open the modal — confirm missing fields are empty.
  3. Click ↗ Fetch on Account ID — Atlas opens in a new tab, CHEQUING(SPEND) auto-clicked, account number lands back in the input.
  4. Type an amount manually.
  5. Pick Reimbursement Reason → submit.

Expected: same outcomes as Step 7.

- [ ] **Step 9: End-to-end test — non-default approver via search.**

  1. Open the modal.
  2. Click the Approver search input → type a name (e.g. a teammate).
  3. Wait ~300ms for results, click one.
  4. Confirm "Selected: {Name}" updates below the search.
  5. Submit and verify the resulting REIMB's Next Level Approval field shows the chosen user.

- [ ] **Step 10: Negative — validation gate.**

  1. New modal, don't pick Reimbursement Reason → Review button stays disabled.
  2. Clear the amount field → Review button stays disabled.
  3. Enter a malformed Account ID (e.g. "abc123") → red border, hint text appears, Review disabled.
  4. Fix everything → Review enables.

- [ ] **Step 11: Sanity check — Overpayment Triage untouched.**

  1. Open a Core-or-higher WOCOO overpayment ticket ($1000+).
  2. Click **⚡ Triage Overpayment**.
  3. Walk through Steps 1–4 of the existing workflow.
  4. At Step 5 ("Post comment & Move to Done") click submit.

Expected: existing OverpaymentTriage flow completes exactly as before this work. No regression. (This is a smoke check, not a regression test — no code in `OverpaymentTriage.tsx` or the original `createReimbTicket` was changed.)

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:** Layout change (Task 3 Steps 5–6), all 11 form fields with autofill (Task 3 Step 1 + Task 4 Step 3), description template w/ live re-templating + dirty-flag (Task 3 Step 1 — `onDescriptionChange`), validation gate (Task 3 Step 1 — `reimbReady`), Confirm + Execute gate (Task 3 + Task 4), Approver picker w/ Luke/Amanda + free search (Task 3 Step 1 — `ApproverPicker`), option ID resolution via existing resolveOptionId (Task 4 Step 3), `createReimbTicketFromForm` separate from `createReimbTicket` (Task 2), `searchJiraUsers` helper (Task 2), comment + transition w/ soft failures (Task 4 Step 3), success panel w/ REIMB key + warnings (Task 3 Step 1 — `SuccessPanel`). OverpaymentTriage sanity (Task 4 Step 11). Edge cases enumerated in spec all covered by existing code paths (amount null → empty, tier unknown → "Core" via `tierToUserTierLabel`, manual desc edit → dirty flag, negative amount → number input accepts, source already Done → soft warning).
- **Placeholder scan:** No "TBD"/"TODO" in implementation steps. `REIMBURSEMENT_REASON_LABELS` / `REQUESTOR_TEAM_LABELS` carry intentional acknowledged-gap comments about labels discoverable later — same pattern as PFO's `REISSUE_REASON_LABELS`.
- **Type consistency:** `Currency`, `IncidentRelated`, `UserTier`, `JiraUserSearchResult`, `CreateReimbFromFormArgs` all defined in earlier tasks and used in later tasks with matching property names. `REIMB_FIELDS.*` keys match the payload keys in `createReimbTicketFromForm`.
- **Scope:** Single feature, four files, four tasks. Single plan is the right shape.
