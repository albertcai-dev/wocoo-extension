// Move Workflow Modal — Phase B-5 (built in the F5 session).
//
// Layout:
//   - Header: "Move WOCOO-XXXXX" + close X
//   - Step 1: Destination picker (EOC / DBO / CRED / FRAUD / PRR / PFO)
//   - Step 2: Source ticket details (read-only confirm card)
//   - Step 3: Per-destination fields (EOC needs status + problem area + account id; etc.)
//   - Confirm + execute: shows the bulk-move call's success/error state inline
//
// FRAUD is UI-only — modal shows a "use Jira native Move" affordance with link out
// to the ticket. PFO handles Express Shipping Request card reissues against the
// rebuilt Physical Fulfillment Operations project (board 12356) using the same
// createmeta-driven dynamic form as DBO / PRR / FRAUD.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { WocooTicket } from '../data/mockTicket';
import {
  DESTINATIONS,
  type DestinationConfig,
  type MoveDestination,
  EOC_TARGET,
  EOC_CLIENT_STATUS_IDS,
  EOC_PROBLEM_AREAS,
  DBO_PROJECT_KEY,
  DBO_ISSUE_TYPES,
  recommendedProblemArea,
  PRR_PROJECT_KEY,
  PRR_ISSUE_TYPES,
  type PrrIssueTypeConfig,
  type PrrRequiredField,
  FRAUD_PROJECT_KEY,
  FRAUD_ISSUE_TYPES,
  PFO_PROJECT_KEY,
  PFO_ISSUE_TYPES,
  tierToUserTierLabel,
} from '../data/moveConfig';
import {
  moveTicket,
  rawField,
  adfField,
  MOVE_FIELDS,
  lookupProjectAndIssueType,
  resolveEocProblemAreaId,
  fetchCreateMetaFields,
  type CreateMetaField,
  type CreateMetaAllowedValue,
  getMyself,
  cloneTicket,
  findExistingClone,
  linkAsClone,
  postComment,
  transitionTicket,
} from '../api/jira';
import { logMoveViaBridge } from '../api/bridge';
import { emitMoveTransition } from './ticketLogEvents';
import {
  fetchAtlasAccountIdHeadless,
  fetchAtlasClientDetailsHeadless,
  type AtlasClientDetails,
} from '../data/atlasAccountLookup';

type Status = 'configuring' | 'confirming' | 'executing' | 'success' | 'error';

type FetchState = 'idle' | 'pending' | 'success' | 'failed';

/** Seed a dynamic form's field values from the source ticket. Text-typed prefills only —
 *  option-typed ones need createmeta to map a label onto an option ID, so they land in
 *  applyOptionPrefills once the metadata resolves. */
function textPrefills(fields: PrrRequiredField[], ticket: WocooTicket): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.prefillFrom === 'identityId' && ticket.identityId) out[f.fieldId] = ticket.identityId;
    else if (f.prefillFrom === 'ticketUrl') out[f.fieldId] = `https://wealthsimple.atlassian.net/browse/${ticket.id}`;
    else if (f.prefillFrom === 'atlasUrl' && ticket.identityId) {
      out[f.fieldId] = `https://atlas.wealthsimple.com/identity/${ticket.identityId}/overview?ticketId=${ticket.id}`;
    }
  }
  return out;
}

/** Second prefill pass, run after createmeta lands: resolve option-typed prefills (today just
 *  User Tier) from a label to the option ID the <select> and the move payload both expect.
 *  A tier with no matching option is left blank rather than guessed — the operator picks. */
function applyOptionPrefills(
  fields: PrrRequiredField[],
  meta: CreateMetaField[],
  ticket: WocooTicket,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.prefillFrom !== 'tier') continue;
    const target = tierToUserTierLabel(ticket.tier).toLowerCase();
    const opts = meta.find((m) => m.fieldId === f.fieldId)?.allowedValues || [];
    const hit = opts.find((o) => (o.value ?? o.name ?? '').toString().toLowerCase() === target);
    if (hit) out[f.fieldId] = hit.id;
  }
  return out;
}

/** Third prefill pass, for fields that live in Atlas rather than on the ticket (PFO's
 *  Cardholder Name + Shipping Address). Runs whenever the headless scrape resolves, which
 *  is well after the form first renders. Only fills blanks — anything the operator has
 *  already typed wins, since this can land mid-edit. */
function atlasPrefills(
  fields: PrrRequiredField[],
  details: AtlasClientDetails,
  current: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Shipping label shape: street on line 1, "City  Postal" on line 2.
  const address = [details.street, [details.cityProvince, details.postal].filter(Boolean).join('  ')]
    .filter(Boolean)
    .join('\n');
  for (const f of fields) {
    if ((current[f.fieldId] || '').trim()) continue;
    if (f.prefillFrom === 'atlasName' && details.name) out[f.fieldId] = details.name;
    else if (f.prefillFrom === 'atlasAddress' && address) out[f.fieldId] = address;
  }
  return out;
}

export function MoveModal({ ticket, onClose, initialDestKey = 'EOC' }: { ticket: WocooTicket; onClose: () => void; initialDestKey?: MoveDestination }) {
  const [destKey, setDestKey] = useState<MoveDestination>(initialDestKey);
  // EOC's Client Status is the same three-way tier the WOCOO ticket already carries in
  // User Tier (customfield_11416), so derive it instead of guessing — this used to be
  // hardcoded to 'Premium', which silently mislabelled every Core and Generation client
  // unless the agent noticed and corrected it. `EOC_CLIENT_STATUS_IDS`'s keys and
  // `UserTier` are the same union, so no mapping is needed; an unrecognised or missing
  // tier lands on 'Core' via tierToUserTierLabel, matching the REIMB and PFO paths.
  // Derived in the initialiser rather than an effect, so a manual override sticks.
  const [clientStatus, setClientStatus] = useState<keyof typeof EOC_CLIENT_STATUS_IDS>(
    tierToUserTierLabel(ticket.tier),
  );
  const [problemArea, setProblemArea] = useState<string>(recommendedProblemArea(ticket.category) || '');
  const [accountIdInput, setAccountIdInput] = useState<string>(ticket.accountId || '');
  // Shared Atlas fetch state — used by both the Source Card row and the EOC input, so we don't
  // spawn two concurrent Atlas tabs if the operator clicks Fetch in both places.
  const [fetchState, setFetchState] = useState<FetchState>('idle');
  const [fetchError, setFetchError] = useState<string | null>(null);
  const autoFetchAttempted = useRef(false);
  const [status, setStatus] = useState<Status>('configuring');
  const [error, setError] = useState<string | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);
  // v3 parity: every move requires a reason; the sheet log records it for audit.
  const [reason, setReason] = useState<string>('');
  const [logWarning, setLogWarning] = useState<string | null>(null);
  // Clone/Move flow: the clone we create before reassigning the original; tracked so that
  // partial-failure errors can point the user at it for manual cleanup.
  const [cloneKey, setCloneKey] = useState<string | null>(null);
  // Survives failed attempts (unlike cloneKey, which resets per run) so "Try Again" reuses
  // the clone it already made instead of minting a new one on every retry. `done` records
  // whether the failure path already transitioned it, so the retry skips a doomed re-transition.
  const cloneRef = useRef<{ key: string; url: string; done: boolean } | null>(null);
  // Non-fatal warnings (clone comment failed, done-transition failed). Listed alongside success.
  const [softWarnings, setSoftWarnings] = useState<string[]>([]);

  // PRR: dynamic form state. Picker + createmeta-driven field values.
  const [prrIssueTypeId, setPrrIssueTypeId] = useState<string>('');
  const [prrFieldValues, setPrrFieldValues] = useState<Record<string, string>>({});
  const [prrMeta, setPrrMeta] = useState<CreateMetaField[] | null>(null);
  const [prrMetaState, setPrrMetaState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [prrMetaError, setPrrMetaError] = useState<string | null>(null);

  // DBO: same shape as PRR (dynamic form driven by createmeta), but scoped to the DBO
  // project + issue-type list.
  const [dboIssueTypeId, setDboIssueTypeId] = useState<string>('');
  const [dboFieldValues, setDboFieldValues] = useState<Record<string, string>>({});
  const [dboMeta, setDboMeta] = useState<CreateMetaField[] | null>(null);
  const [dboMetaState, setDboMetaState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [dboMetaError, setDboMetaError] = useState<string | null>(null);

  // FRAUD: dynamic form driven by createmeta (mirrors DBO/PRR). Two issue types
  // (Task, Other) each with 3 required custom fields including the ~100-option
  // Fraud Detection Method picker.
  const [fraudIssueTypeId, setFraudIssueTypeId] = useState<string>('');
  const [fraudFieldValues, setFraudFieldValues] = useState<Record<string, string>>({});
  const [fraudMeta, setFraudMeta] = useState<CreateMetaField[] | null>(null);
  const [fraudMetaState, setFraudMetaState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [fraudMetaError, setFraudMetaError] = useState<string | null>(null);

  // PFO: dynamic form driven by createmeta (mirrors DBO/PRR/FRAUD). The bespoke
  // Express Shipping UI this replaced hardcoded field IDs and option labels from the
  // now-deprecated OLDPFO project — see the PFO block in moveConfig.ts.
  const [pfoIssueTypeId, setPfoIssueTypeId] = useState<string>(PFO_ISSUE_TYPES[0].id);
  const [pfoFieldValues, setPfoFieldValues] = useState<Record<string, string>>({});
  const [pfoMeta, setPfoMeta] = useState<CreateMetaField[] | null>(null);
  const [pfoMetaState, setPfoMetaState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [pfoMetaError, setPfoMetaError] = useState<string | null>(null);
  // Cardholder Name + Shipping Address aren't on the WOCOO ticket — they come from the
  // same headless Atlas scrape the Refund Auth Letter workflow uses. Held as the scraped
  // record rather than pushed straight into pfoFieldValues so an issue-type switch (which
  // resets the field values) can re-apply it without a second Atlas tab.
  const [pfoAtlas, setPfoAtlas] = useState<AtlasClientDetails | null>(null);
  const [pfoAtlasState, setPfoAtlasState] = useState<FetchState>('idle');
  const [pfoAtlasError, setPfoAtlasError] = useState<string | null>(null);
  const pfoAtlasAttempted = useRef(false);

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && status !== 'executing') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, status]);

  // Shared Atlas Account-ID fetch. Safe to call from any destination's field OR from the
  // Source Card fallback button — dedupes concurrent calls via `fetchState`.
  const runAtlasFetch = useCallback(async () => {
    if (!ticket.identityId) return;
    setFetchState((s) => (s === 'pending' ? s : 'pending'));
    setFetchError(null);
    try {
      const { accountNumber } = await fetchAtlasAccountIdHeadless({
        identityId: ticket.identityId,
        sourceTicketId: ticket.id,
      });
      setAccountIdInput(accountNumber);
      setFetchState('success');
    } catch (e: any) {
      setFetchError(e?.message || 'Atlas fetch failed');
      setFetchState('failed');
    }
  }, [ticket.id, ticket.identityId]);

  // Auto-run once on modal open when Account ID is missing from the ticket. Skipped if the
  // ticket already has an accountId (Jira value wins) or if there's no identityId to look up.
  useEffect(() => {
    if (autoFetchAttempted.current) return;
    autoFetchAttempted.current = true;
    if (!ticket.accountId && ticket.identityId) {
      void runAtlasFetch();
    }
  }, [ticket.accountId, ticket.identityId, runAtlasFetch]);

  // PFO-only Atlas scrape for the client's name + mailing address. Deliberately NOT run on
  // modal open like the account-ID lookup — it costs a background tab, and every other
  // destination ignores the result.
  const runPfoAtlasFetch = useCallback(async () => {
    if (!ticket.identityId) return;
    setPfoAtlasState('pending');
    setPfoAtlasError(null);
    try {
      const details = await fetchAtlasClientDetailsHeadless({
        identityId: ticket.identityId,
        sourceTicketId: ticket.id,
      });
      setPfoAtlas(details);
      setPfoAtlasState('success');
    } catch (e: any) {
      setPfoAtlasError(e?.message || 'Atlas lookup failed');
      setPfoAtlasState('failed');
    }
  }, [ticket.id, ticket.identityId]);

  const dest = useMemo(() => DESTINATIONS.find((d) => d.key === destKey)!, [destKey]);

  const prrConfig: PrrIssueTypeConfig | null = useMemo(
    () => PRR_ISSUE_TYPES.find((t) => t.id === prrIssueTypeId) || null,
    [prrIssueTypeId],
  );

  const dboConfig: PrrIssueTypeConfig | null = useMemo(
    () => DBO_ISSUE_TYPES.find((t) => t.id === dboIssueTypeId) || null,
    [dboIssueTypeId],
  );

  const fraudConfig: PrrIssueTypeConfig | null = useMemo(
    () => FRAUD_ISSUE_TYPES.find((t) => t.id === fraudIssueTypeId) || null,
    [fraudIssueTypeId],
  );

  const pfoConfig: PrrIssueTypeConfig | null = useMemo(
    () => PFO_ISSUE_TYPES.find((t) => t.id === pfoIssueTypeId) || null,
    [pfoIssueTypeId],
  );

  // When the PRR issue type changes: reset field values (with prefill from ticket), and
  // fetch createmeta so option pickers have real labels to render.
  useEffect(() => {
    if (!prrConfig) {
      setPrrMeta(null);
      setPrrMetaState('idle');
      setPrrMetaError(null);
      setPrrFieldValues({});
      return;
    }
    setPrrFieldValues(textPrefills(prrConfig.requiredFields, ticket));
    setPrrMetaState('loading');
    setPrrMetaError(null);
    let cancelled = false;
    fetchCreateMetaFields(PRR_PROJECT_KEY, prrConfig.id)
      .then((fields) => {
        if (cancelled) return;
        setPrrMeta(fields);
        setPrrMetaState('ready');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setPrrMeta(null);
        setPrrMetaError(e?.message || 'Failed to load PRR metadata');
        setPrrMetaState('error');
      });
    return () => { cancelled = true; };
  }, [prrConfig, ticket.identityId, ticket.id]);

  // Same effect for FRAUD — separate hook so it can coexist with DBO/PRR across dest switches.
  useEffect(() => {
    if (!fraudConfig) {
      setFraudMeta(null);
      setFraudMetaState('idle');
      setFraudMetaError(null);
      setFraudFieldValues({});
      return;
    }
    setFraudFieldValues(textPrefills(fraudConfig.requiredFields, ticket));
    setFraudMetaState('loading');
    setFraudMetaError(null);
    let cancelled = false;
    fetchCreateMetaFields(FRAUD_PROJECT_KEY, fraudConfig.id)
      .then((fields) => {
        if (cancelled) return;
        setFraudMeta(fields);
        setFraudMetaState('ready');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setFraudMeta(null);
        setFraudMetaError(e?.message || 'Failed to load FRAUD metadata');
        setFraudMetaState('error');
      });
    return () => { cancelled = true; };
  }, [fraudConfig, ticket.identityId, ticket.id]);

  // Same effect for DBO — separate hook so PRR and DBO can coexist across dest switches.
  useEffect(() => {
    if (!dboConfig) {
      setDboMeta(null);
      setDboMetaState('idle');
      setDboMetaError(null);
      setDboFieldValues({});
      return;
    }
    setDboFieldValues(textPrefills(dboConfig.requiredFields, ticket));
    setDboMetaState('loading');
    setDboMetaError(null);
    let cancelled = false;
    fetchCreateMetaFields(DBO_PROJECT_KEY, dboConfig.id)
      .then((fields) => {
        if (cancelled) return;
        setDboMeta(fields);
        setDboMetaState('ready');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setDboMeta(null);
        setDboMetaError(e?.message || 'Failed to load DBO metadata');
        setDboMetaState('error');
      });
    return () => { cancelled = true; };
  }, [dboConfig, ticket.identityId, ticket.id]);

  // Same effect for PFO. Extra step vs the others: User Tier is an option-typed prefill, so
  // it can only be seeded once createmeta has resolved its option IDs — hence the merge in
  // .then() rather than a single setState up front.
  useEffect(() => {
    if (!pfoConfig) {
      setPfoMeta(null);
      setPfoMetaState('idle');
      setPfoMetaError(null);
      setPfoFieldValues({});
      return;
    }
    setPfoFieldValues(textPrefills(pfoConfig.requiredFields, ticket));
    setPfoMetaState('loading');
    setPfoMetaError(null);
    let cancelled = false;
    fetchCreateMetaFields(PFO_PROJECT_KEY, pfoConfig.id)
      .then((fields) => {
        if (cancelled) return;
        setPfoMeta(fields);
        setPfoFieldValues((prev) => ({ ...prev, ...applyOptionPrefills(pfoConfig.requiredFields, fields, ticket) }));
        setPfoMetaState('ready');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setPfoMeta(null);
        setPfoMetaError(e?.message || 'Failed to load PFO metadata');
        setPfoMetaState('error');
      });
    return () => { cancelled = true; };
  }, [pfoConfig, ticket.identityId, ticket.id, ticket.tier]);

  // Fire the Atlas lookup once, the first time PFO is selected with an issue type that has
  // somewhere to put the result — Internal Projects and Bug don't, and shouldn't cost a tab.
  // The retry button calls runPfoAtlasFetch directly, so the ref guard only suppresses the
  // automatic run.
  useEffect(() => {
    if (destKey !== 'PFO' || !ticket.identityId || pfoAtlasAttempted.current) return;
    const wantsAtlas = pfoConfig?.requiredFields.some(
      (f) => f.prefillFrom === 'atlasName' || f.prefillFrom === 'atlasAddress',
    );
    if (!wantsAtlas) return;
    pfoAtlasAttempted.current = true;
    void runPfoAtlasFetch();
  }, [destKey, ticket.identityId, pfoConfig, runPfoAtlasFetch]);

  // Apply the Atlas scrape once it lands. Declared after the effect above so an issue-type
  // change (which resets pfoFieldValues) is followed by a re-apply in the same commit.
  useEffect(() => {
    if (!pfoConfig || !pfoAtlas) return;
    setPfoFieldValues((prev) => {
      const add = atlasPrefills(pfoConfig.requiredFields, pfoAtlas, prev);
      return Object.keys(add).length ? { ...prev, ...add } : prev;
    });
  }, [pfoConfig, pfoAtlas]);

  function reset() {
    setStatus('configuring');
    setError(null);
    setResultNote(null);
    setLogWarning(null);
    setCloneKey(null);
    setSoftWarnings([]);
  }

  // Fire-and-warn: append a row to the v3 Moves sheet via the Apps Script bridge.
  // The Jira move itself has already succeeded by the time this is called, so a logging
  // failure must NOT roll back the move — surface a soft warning instead.
  async function logMove(destProject: string, destDetail: string) {
    try {
      const me = await getMyself().catch(() => null);
      const operatorName = me?.displayName || ticket.assignee || '';
      await logMoveViaBridge({
        sourceTicketId: ticket.id,
        destProject,
        destDetail,
        operatorName,
        notes: reason.trim(),
      });
    } catch (e: any) {
      setLogWarning(`Move applied, but sheet log failed: ${e?.message || String(e)}`);
    }
  }

  // ---- Field validity ----
  // Prefer the (editable) input over the Jira-provided value so the "Fetch Account ID"
  // override can take effect even on tickets that already have an Account ID populated.
  const accountId = (accountIdInput || ticket.accountId || '').trim().toUpperCase();
  const accountIdValid = /^[CHWN][0-9A-Z]{7,}$/i.test(accountId);
  const eocReady =
    !!problemArea &&
    !!ticket.identityId &&
    accountIdValid;
  const credReady = !!ticket.summary;
  const fraudReady =
    !!fraudConfig &&
    fraudMetaState === 'ready' &&
    fraudConfig.requiredFields.every((f) => {
      const v = fraudFieldValues[f.fieldId];
      return !!v && !!v.trim();
    });
  const dboReady =
    !!dboConfig &&
    dboMetaState === 'ready' &&
    dboConfig.requiredFields.every((f) => {
      const v = dboFieldValues[f.fieldId];
      return !!v && !!v.trim();
    });
  const prrReady =
    !!prrConfig &&
    prrMetaState === 'ready' &&
    prrConfig.requiredFields.every((f) => {
      const v = prrFieldValues[f.fieldId];
      if (!v || !v.trim()) return false;
      if (f.type === 'option-with-child') {
        // Require child only if the selected parent has children in metadata.
        const meta = prrMeta?.find((m) => m.fieldId === f.fieldId);
        const parent = meta?.allowedValues?.find((p) => p.id === v);
        const hasChildren = !!parent?.children && parent.children.length > 0;
        if (hasChildren) {
          const child = prrFieldValues[`${f.fieldId}__child`];
          return !!child && !!child.trim();
        }
      }
      return true;
    });

  const pfoReady =
    !!pfoConfig &&
    !!ticket.identityId &&
    pfoMetaState === 'ready' &&
    // `optional` fields are listed only because we can prefill them — Jira doesn't require
    // them, so a blank one (failed Atlas scrape) must not hold the move.
    pfoConfig.requiredFields.filter((f) => !f.optional).every((f) => {
      const v = pfoFieldValues[f.fieldId];
      return !!v && !!v.trim();
    });

  const reasonReady = reason.trim().length > 0;
  const ready =
    reasonReady && (
      dest.key === 'EOC' ? eocReady :
      dest.key === 'DBO' ? dboReady :
      dest.key === 'CRED' ? credReady :
      dest.key === 'PRR' ? prrReady :
      dest.key === 'PFO' ? pfoReady :
      dest.key === 'FRAUD' ? fraudReady :
      false
    );

  // ---- Execute ----
  // Clone/Move flow (replaces the old "just move" behavior):
  //   1. Clone the original ticket on the same board (reporting artifact).
  //   2. Link clone --clones--> original.
  //   3. Reassign the ORIGINAL ticket to the destination board (preserves Zendesk link).
  //   4. Comment on original + comment on clone (cross-reference).
  //   5. Transition the clone to Done (transition id 251).
  //   6. Log the move to the v3 sheet.
  //
  // Hard failures (clone, link, move) abort + surface error. Soft failures (comments,
  // done-transition, sheet log) collect warnings but the run is still treated as success.
  async function execute() {
    setStatus('executing');
    setError(null);
    setSoftWarnings([]);
    setCloneKey(null);

    let createdCloneKey: string | null = null;
    const warnings: string[] = [];
    const noteForReassignment = (destLabel: string) => `Reassigned to ${destLabel}. Reason: ${reason.trim()}`;

    try {
      // --- Pre-validate destination args BEFORE creating the clone, so we don't leave an
      // orphan clone if the user has a missing field. ---
      let destLabel = '';
      let moveCall: () => ReturnType<typeof moveTicket>;

      if (dest.key === 'EOC') {
        if (!ticket.identityId) throw new Error('Source ticket has no Identity ID.');
        if (!accountIdValid) throw new Error('Account ID format is invalid (need C/H/W/N + 7+ chars).');
        if (!problemArea) throw new Error('Pick a Problem Area first.');
        const paOptionId = await resolveEocProblemAreaId(problemArea);
        const csId = EOC_CLIENT_STATUS_IDS[clientStatus];
        destLabel = `EOC (Problem Area: ${problemArea}, Status: ${clientStatus})`;
        moveCall = () => moveTicket({
          sourceKey: ticket.id,
          destProjectId: EOC_TARGET.PROJECT_ID,
          destIssueTypeId: EOC_TARGET.ISSUETYPE_ID,
          mandatoryFields: {
            [MOVE_FIELDS.SUMMARY]:        rawField(ticket.summary),
            [MOVE_FIELDS.IDENTITY_ID]:    rawField(ticket.identityId),
            [MOVE_FIELDS.ACCOUNT_ID]:     rawField(accountId),
            [MOVE_FIELDS.CLIENT_STATUS]: rawField(csId),
            [MOVE_FIELDS.PROBLEM_AREA]:  rawField(paOptionId),
          },
        });
      } else if (dest.key === 'CRED') {
        const { projectId, issueTypeId } = await lookupProjectAndIssueType('CRED', 'Task');
        destLabel = 'CRED (Task)';
        moveCall = () => moveTicket({
          sourceKey: ticket.id,
          destProjectId: projectId,
          destIssueTypeId: issueTypeId,
          mandatoryFields: {
            [MOVE_FIELDS.SUMMARY]: rawField(ticket.summary),
          },
        });
      } else if (dest.key === 'PRR') {
        if (!prrConfig) throw new Error('Select a PRR issue type first.');
        const { projectId } = await lookupProjectAndIssueType(PRR_PROJECT_KEY, prrConfig.name);
        destLabel = `PRR (${prrConfig.name})`;
        const fields: Record<string, ReturnType<typeof rawField>> = {
          [MOVE_FIELDS.SUMMARY]: rawField(ticket.summary),
        };
        for (const f of prrConfig.requiredFields) {
          const v = prrFieldValues[f.fieldId];
          if (f.type === 'option-with-child') {
            const child = prrFieldValues[`${f.fieldId}__child`];
            fields[f.fieldId] = child
              ? { retain: false, type: 'raw', value: [v, child] }
              : rawField(v);
          } else if (f.type === 'paragraph') {
            fields[f.fieldId] = adfField(v);
          } else {
            fields[f.fieldId] = rawField(v);
          }
        }
        moveCall = () => moveTicket({
          sourceKey: ticket.id,
          destProjectId: projectId,
          destIssueTypeId: prrConfig.id,
          mandatoryFields: fields,
        });
      } else if (dest.key === 'DBO') {
        if (!dboConfig) throw new Error('Select a DBO issue type first.');
        const { projectId } = await lookupProjectAndIssueType(DBO_PROJECT_KEY, dboConfig.name);
        destLabel = `DBO (${dboConfig.name})`;
        const fields: Record<string, ReturnType<typeof rawField>> = {
          [MOVE_FIELDS.SUMMARY]: rawField(ticket.summary),
        };
        for (const f of dboConfig.requiredFields) {
          const v = dboFieldValues[f.fieldId];
          if (f.type === 'option-with-child') {
            const child = dboFieldValues[`${f.fieldId}__child`];
            fields[f.fieldId] = child
              ? { retain: false, type: 'raw', value: [v, child] }
              : rawField(v);
          } else if (f.type === 'paragraph') {
            fields[f.fieldId] = adfField(v);
          } else {
            // string | number | date | option | array-option all serialise the same
            // way via rawField — Jira infers the shape from the target field.
            fields[f.fieldId] = rawField(v);
          }
        }
        moveCall = () => moveTicket({
          sourceKey: ticket.id,
          destProjectId: projectId,
          destIssueTypeId: dboConfig.id,
          mandatoryFields: fields,
        });
      } else if (dest.key === 'FRAUD') {
        if (!fraudConfig) throw new Error('Select a FRAUD issue type first.');
        const { projectId } = await lookupProjectAndIssueType(FRAUD_PROJECT_KEY, fraudConfig.name);
        destLabel = `FRAUD (${fraudConfig.name})`;
        const fields: Record<string, ReturnType<typeof rawField>> = {
          [MOVE_FIELDS.SUMMARY]: rawField(ticket.summary),
        };
        for (const f of fraudConfig.requiredFields) {
          const v = fraudFieldValues[f.fieldId];
          if (f.type === 'option-with-child') {
            const child = fraudFieldValues[`${f.fieldId}__child`];
            fields[f.fieldId] = child
              ? { retain: false, type: 'raw', value: [v, child] }
              : rawField(v);
          } else if (f.type === 'paragraph') {
            fields[f.fieldId] = adfField(v);
          } else {
            fields[f.fieldId] = rawField(v);
          }
        }
        moveCall = () => moveTicket({
          sourceKey: ticket.id,
          destProjectId: projectId,
          destIssueTypeId: fraudConfig.id,
          mandatoryFields: fields,
        });
      } else if (dest.key === 'PFO') {
        if (!pfoConfig) throw new Error('Select a PFO issue type first.');
        if (!ticket.identityId) throw new Error('Source ticket has no Identity ID.');
        // Resolved by key, never by hardcoded id — the previous numeric id (13086) silently
        // became the deprecated OLDPFO project when fulfillment was rebuilt.
        const { projectId } = await lookupProjectAndIssueType(PFO_PROJECT_KEY, pfoConfig.name);
        destLabel = `PFO (${pfoConfig.name})`;
        const fields: Record<string, ReturnType<typeof rawField>> = {
          [MOVE_FIELDS.SUMMARY]: rawField(ticket.summary),
        };
        for (const f of pfoConfig.requiredFields) {
          const v = pfoFieldValues[f.fieldId];
          // A blank optional field is omitted rather than sent empty — Jira rejects an
          // empty value on a field it didn't ask for. Non-optional fields can't be blank
          // here; pfoReady gates the button on them.
          if (f.optional && !(v || '').trim()) continue;
          if (f.type === 'paragraph') fields[f.fieldId] = adfField(v);
          else fields[f.fieldId] = rawField(v);
        }
        moveCall = () => moveTicket({
          sourceKey: ticket.id,
          destProjectId: projectId,
          destIssueTypeId: pfoConfig.id,
          mandatoryFields: fields,
        });
      } else {
        // FRAUD path is handled by the UI-only branch (no execute button shown).
        throw new Error(`Destination ${dest.key} is not API-supported.`);
      }

      // --- Hard step 1: clone (reused across retries) ---
      // A retry after a failed move must NOT clone again — the first attempt's clone is
      // already on the board, linked to the original, and is just as valid a reporting artifact.
      const reusedClone = cloneRef.current ?? await findExistingClone(ticket.id);
      const clone = reusedClone ?? await cloneTicket(ticket.id);
      cloneRef.current = reusedClone ?? { key: clone.key, url: clone.url, done: false };
      createdCloneKey = clone.key;
      setCloneKey(clone.key);

      // --- Hard step 2: link clone --clones--> original ---
      // outwardIssue is the side that "clones"; inwardIssue is the side "cloned by".
      if (!reusedClone) {
        try {
          await linkAsClone(clone.key, ticket.id);
        } catch (e) {
          warnings.push(`Clone link failed: ${e instanceof Error ? e.message : String(e)} (link manually if needed)`);
        }
      }

      // --- Hard step 3: reassign the ORIGINAL to destination ---
      // If this fails, the clone is orphaned and the error message points to it.
      const moveResult = await moveCall();
      if (moveResult.placeholderedFields.length > 0) {
        warnings.push(
          `${destLabel.split(' ')[0]} required ${moveResult.placeholderedFields.join(', ')} — ` +
          `off-screen fields the panel can't collect, so they were set to "N/A" to get the move ` +
          `through. Worth asking a Jira admin to un-require them.`,
        );
      }

      // --- Soft step 4a: comment on original referencing the clone ---
      try {
        await postComment(ticket.id, [
          { type: 'text', text: `${noteForReassignment(destLabel)} · Clone logged for tracking: ` },
          { type: 'link', text: clone.key, href: clone.url },
        ]);
      } catch (e) {
        warnings.push(`Comment on original failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // --- Soft step 4b: comment on clone explaining why it's about to be Done ---
      try {
        await postComment(clone.key, [
          { type: 'text', text: `Original ` },
          { type: 'link', text: ticket.id, href: `https://wealthsimple.atlassian.net/browse/${ticket.id}` },
          { type: 'text', text: ` has been reassigned to ${destLabel}. This clone exists for reporting only and is being moved to Done immediately.` },
        ]);
      } catch (e) {
        warnings.push(`Comment on clone failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // --- Soft step 5: transition the clone to Done ---
      // Skipped when a previous failed attempt already Done'd this clone.
      if (!cloneRef.current?.done) {
        try {
          await transitionTicket(clone.key, '251');
          if (cloneRef.current) cloneRef.current.done = true;
        } catch (e) {
          warnings.push(`Clone Done-transition failed: ${e instanceof Error ? e.message : String(e)} (move ${clone.key} to Done manually)`);
        }
      }

      // --- Soft step 6: audit log ---
      await logMove(dest.key, destLabel);

      // Phase 1 Ticket Log: emit a Move event for the source WOCOO ticket so the
      // sidepanel writes a row to the Ticket Log sheet and can prompt for a note.
      try {
        emitMoveTransition(ticket.id, dest.key);
      } catch (e) {
        console.debug('[MoveModal] emitMoveTransition failed (non-fatal):', e);
      }

      setSoftWarnings(warnings);
      setResultNote(
        `Original ${ticket.id} reassigned to ${destLabel}. Clone ${clone.key} ` +
        `${reusedClone ? 'reused from the earlier attempt' : 'created'} and moved to Done.`,
      );
      setStatus('success');
    } catch (e: any) {
      const baseMsg = e?.message || String(e);
      // If we created a clone before failing, best-effort transition it to Done so the
      // failed run doesn't leave board clutter. If the cleanup itself fails, fall back
      // to the manual message + warn about the cleanup failure.
      let orphan = '';
      if (createdCloneKey && cloneRef.current?.done) {
        orphan = ` (clone ${createdCloneKey} from the earlier attempt is still on the board, already Done — Try Again reuses it)`;
      } else if (createdCloneKey) {
        try {
          await transitionTicket(createdCloneKey, '251');
          if (cloneRef.current) cloneRef.current.done = true;
          orphan = ` (clone ${createdCloneKey} was created; auto-transitioned to Done and reused if you Try Again)`;
        } catch (cleanupErr) {
          const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          warnings.push(`Auto-cleanup of clone ${createdCloneKey} failed: ${cleanupMsg}`);
          orphan = ` (clone ${createdCloneKey} was created and is now orphaned on the CXA board — move it to Done manually)`;
        }
      }
      setError(baseMsg + orphan);
      setSoftWarnings(warnings);
      setStatus('error');
    }
  }

  return (
    <Overlay onClick={onClose}>
      <Modal onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <header style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)' }}>
            Clone/Move <span style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticket.id}</span>
          </h2>
          <button onClick={onClose} aria-label="Close" style={iconButtonStyle}>×</button>
        </header>

        {/* Body: scroll-able middle */}
        <div style={bodyStyle}>
          {status === 'success' ? (
            <SuccessPanel ticketId={ticket.id} note={resultNote || 'Clone/Move accepted.'} warnings={softWarnings} cloneKey={cloneKey} onClose={onClose} />
          ) : (
            <>
              <DestinationPicker
                value={destKey}
                onChange={(k) => { setDestKey(k); reset(); }}
                locked={status === 'confirming' || status === 'executing'}
              />

              <SourceCard
                ticket={ticket}
                effectiveAccountId={accountIdInput || ticket.accountId || ''}
                fetchState={fetchState}
                fetchError={fetchError}
                onFetch={runAtlasFetch}
                locked={status === 'confirming' || status === 'executing'}
              />

              {dest.key === 'EOC' && (
                <EocFields
                  ticket={ticket}
                  clientStatus={clientStatus}
                  onClientStatus={setClientStatus}
                  problemArea={problemArea}
                  onProblemArea={setProblemArea}
                  accountIdInput={accountIdInput}
                  onAccountIdInput={setAccountIdInput}
                  accountIdValid={accountIdValid}
                  fetchState={fetchState}
                  onFetch={runAtlasFetch}
                  locked={status === 'confirming' || status === 'executing'}
                />
              )}

              {dest.key === 'DBO' && (
                <DboFields
                  issueTypeId={dboIssueTypeId}
                  onIssueTypeId={setDboIssueTypeId}
                  fieldValues={dboFieldValues}
                  onFieldValues={setDboFieldValues}
                  meta={dboMeta}
                  metaState={dboMetaState}
                  metaError={dboMetaError}
                  locked={status === 'confirming' || status === 'executing'}
                />
              )}

              {dest.key === 'CRED' && (
                <InfoCard tone="info">{dest.notes}</InfoCard>
              )}

              {dest.key === 'PRR' && (
                <PrrFields
                  issueTypeId={prrIssueTypeId}
                  onIssueTypeId={setPrrIssueTypeId}
                  fieldValues={prrFieldValues}
                  onFieldValues={setPrrFieldValues}
                  meta={prrMeta}
                  metaState={prrMetaState}
                  metaError={prrMetaError}
                  locked={status === 'confirming' || status === 'executing'}
                />
              )}

              {dest.key === 'PFO' && (
                <PfoFields
                  issueTypeId={pfoIssueTypeId}
                  onIssueTypeId={setPfoIssueTypeId}
                  fieldValues={pfoFieldValues}
                  onFieldValues={setPfoFieldValues}
                  meta={pfoMeta}
                  metaState={pfoMetaState}
                  metaError={pfoMetaError}
                  atlasState={pfoAtlasState}
                  atlasError={pfoAtlasError}
                  onRetryAtlas={() => { void runPfoAtlasFetch(); }}
                  locked={status === 'confirming' || status === 'executing'}
                />
              )}

              {dest.key === 'FRAUD' && (
                <FraudFields
                  issueTypeId={fraudIssueTypeId}
                  onIssueTypeId={setFraudIssueTypeId}
                  fieldValues={fraudFieldValues}
                  onFieldValues={setFraudFieldValues}
                  meta={fraudMeta}
                  metaState={fraudMetaState}
                  metaError={fraudMetaError}
                  locked={status === 'confirming' || status === 'executing'}
                />
              )}

              {/* Reason for move — required for the v3 sheet log */}
              {dest.apiEnabled && (
                <div style={{ marginTop: 'var(--mint-sp-3)' }}>
                  <label style={{ display: 'block', fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 6 }}>
                    Reason for move <span style={{ color: 'var(--mint-negative-fg-strong)' }}>*</span>
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    placeholder="Why is this ticket being moved?"
                    disabled={status === 'confirming' || status === 'executing'}
                    style={{ width: '100%', padding: 'var(--mint-sp-2)', fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', boxSizing: 'border-box', lineHeight: 1.5, color: 'var(--mint-fg-strong)' }}
                  />
                  <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
                    Logged to the WOCOO Moves sheet alongside ticket + destination.
                  </div>
                </div>
              )}

              {error && <InfoCard tone="negative">{error}</InfoCard>}
              {logWarning && <InfoCard tone="warning">{logWarning}</InfoCard>}
            </>
          )}
        </div>

        {/* Footer / actions */}
        {status !== 'success' && dest.apiEnabled && (
          <footer style={footerStyle}>
            {status === 'confirming' ? (
              <ConfirmRow
                onConfirm={execute}
                onBack={reset}
                destName={dest.name}
                ticketId={ticket.id}
              />
            ) : (
              <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', justifyContent: 'flex-end' }}>
                <button onClick={onClose} style={secondaryButton}>Cancel</button>
                <button
                  onClick={() => setStatus('confirming')}
                  disabled={!ready || status === 'executing'}
                  style={{ ...primaryButton, opacity: ready && status !== 'executing' ? 1 : 0.55, cursor: ready && status !== 'executing' ? 'pointer' : 'not-allowed' }}
                >
                  {status === 'executing' ? 'Cloning + Moving…' : status === 'error' ? 'Try Again' : 'Review & Clone/Move'}
                </button>
              </div>
            )}
          </footer>
        )}
      </Modal>
    </Overlay>
  );
}

// ---------- subcomponents ----------

function DestinationPicker({ value, onChange, locked }: { value: MoveDestination; onChange: (k: MoveDestination) => void; locked: boolean }) {
  return (
    <section style={sectionStyle}>
      <Label>Step 1: Destination</Label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--mint-sp-2)' }}>
        {DESTINATIONS.map((d) => {
          const active = value === d.key;
          return (
            <button
              key={d.key}
              onClick={() => onChange(d.key)}
              disabled={locked}
              style={{
                padding: 'var(--mint-sp-2) var(--mint-sp-3)',
                background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)',
                color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)',
                border: 'var(--mint-card-stroke)',
                borderRadius: 'var(--mint-radius-button)',
                cursor: locked ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                opacity: locked ? 0.6 : 1,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 'var(--mint-text-meta)' }}>
                {d.name}{' '}
                <span style={{ fontWeight: 500, opacity: 0.7, fontSize: 'var(--mint-text-nano)' }}>
                  {d.apiEnabled ? '· API' : '· UI only'}
                </span>
              </div>
              <div style={{ fontSize: 'var(--mint-text-nano)', opacity: 0.8, marginTop: 2 }}>{d.fullName}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SourceCard({ ticket, effectiveAccountId, fetchState, fetchError, onFetch, locked }: {
  ticket: WocooTicket;
  effectiveAccountId: string;
  fetchState: FetchState;
  fetchError: string | null;
  onFetch: () => void;
  locked: boolean;
}) {
  return (
    <section style={sectionStyle}>
      <Label>Step 2: Source ticket</Label>
      <div style={{ background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)' }}>
        <Row label="Summary">{ticket.summary}</Row>
        <Row label="Identity ID" mono>{ticket.identityId || <Missing>missing</Missing>}</Row>
        <Row label="Account ID" mono>
          <AccountIdCell
            value={effectiveAccountId}
            canFetch={!!ticket.identityId && !locked}
            fetchState={fetchState}
            fetchError={fetchError}
            onFetch={onFetch}
          />
        </Row>
        <Row label="Tier">{ticket.tier}</Row>
      </div>
    </section>
  );
}

function AccountIdCell({ value, canFetch, fetchState, fetchError, onFetch }: {
  value: string;
  canFetch: boolean;
  fetchState: FetchState;
  fetchError: string | null;
  onFetch: () => void;
}) {
  if (value) return <>{value}</>;
  if (fetchState === 'pending') {
    return (
      <span style={{ color: 'var(--mint-fg-soft)', fontStyle: 'italic', fontFamily: 'var(--mint-font-family)' }}>
        Fetching from Atlas…
      </span>
    );
  }
  const failed = fetchState === 'failed';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Missing>missing</Missing>
      {canFetch && (
        <button
          onClick={onFetch}
          title={failed ? (fetchError || 'Retry Atlas fetch') : 'Open Atlas → CHEQUING (SPEND) → read Account Number'}
          style={{
            padding: '2px 8px',
            background: 'var(--mint-highlight-fg-graphic)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--mint-radius-button)',
            fontSize: 'var(--mint-text-nano)',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'var(--mint-font-family)',
          }}
        >
          {failed ? '↻ Retry Fetch' : '↗ Fetch'}
        </button>
      )}
      {failed && fetchError && (
        <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', fontFamily: 'var(--mint-font-family)' }}>
          {fetchError}
        </span>
      )}
    </span>
  );
}

function EocFields(props: {
  ticket: WocooTicket;
  clientStatus: keyof typeof EOC_CLIENT_STATUS_IDS;
  onClientStatus: (s: keyof typeof EOC_CLIENT_STATUS_IDS) => void;
  problemArea: string;
  onProblemArea: (s: string) => void;
  accountIdInput: string;
  onAccountIdInput: (s: string) => void;
  accountIdValid: boolean;
  fetchState: FetchState;
  onFetch: () => void;
  locked: boolean;
}) {
  return (
    <section style={sectionStyle}>
      <Label>Step 3: EOC fields</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Client Status</FieldLabel>
        <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
          {(['Core', 'Premium', 'Generation'] as const).map((s) => {
            const active = props.clientStatus === s;
            return (
              <button
                key={s}
                disabled={props.locked}
                onClick={() => props.onClientStatus(s)}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  background: active ? 'var(--mint-warning-fg-graphic)' : 'var(--mint-bg-card)',
                  color: active ? '#fff' : 'var(--mint-fg-strong)',
                  border: 'var(--mint-card-stroke)',
                  borderRadius: 'var(--mint-radius-button)',
                  fontWeight: 600,
                  fontSize: 'var(--mint-text-meta)',
                  cursor: props.locked ? 'not-allowed' : 'pointer',
                  opacity: props.locked ? 0.6 : 1,
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Problem Area</FieldLabel>
        <ProblemAreaTypeahead value={props.problemArea} onChange={props.onProblemArea} disabled={props.locked} />
      </div>

      <div>
        <FieldLabel>
          Account ID {props.ticket.accountId
            ? <span style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>· from Jira (editable)</span>
            : <span style={{ color: 'var(--mint-warning-fg-strong)', fontWeight: 600 }}>· enter manually</span>}
        </FieldLabel>
        <AccountIdInputWithFetch
          ticket={props.ticket}
          value={props.accountIdInput || props.ticket.accountId || ''}
          valid={props.accountIdValid}
          locked={props.locked}
          fetchState={props.fetchState}
          onFetch={props.onFetch}
          onChange={(v) => props.onAccountIdInput(v.toUpperCase())}
        />
      </div>
    </section>
  );
}

// Account ID input + adjacent "Fetch" button. Fetch state is hoisted to MoveModal so the
// Source Card row (which auto-fetches on open) and this input share one in-flight Atlas tab.
function AccountIdInputWithFetch({ ticket, value, valid, locked, fetchState, onFetch, onChange }: {
  ticket: WocooTicket;
  value: string;
  valid: boolean;
  locked: boolean;
  fetchState: FetchState;
  onFetch: () => void;
  onChange: (v: string) => void;
}) {
  const fetchPending = fetchState === 'pending';
  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
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
          onClick={onFetch}
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
        <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
          Invalid format. Need C/H/W/N + 7+ alphanumeric chars.
        </div>
      )}
      {fetchPending && (
        <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
          Waiting for Atlas Portfolio Details… (CHEQUING (SPEND) will be clicked automatically)
        </div>
      )}
    </>
  );
}

// DBO destination fields — same shape as PrrFields (an issue-type picker plus dynamic
// per-type required fields resolved via createmeta). Kept as a distinct component so
// the copy ("Step 3: DBO fields") and the source issue-type list (DBO_ISSUE_TYPES) can
// diverge from PRR without conditional logic in one shared renderer.
function DboFields(props: {
  issueTypeId: string;
  onIssueTypeId: (id: string) => void;
  fieldValues: Record<string, string>;
  onFieldValues: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  meta: CreateMetaField[] | null;
  metaState: 'idle' | 'loading' | 'ready' | 'error';
  metaError: string | null;
  locked: boolean;
}) {
  const { issueTypeId, onIssueTypeId, fieldValues, onFieldValues, meta, metaState, metaError, locked } = props;
  const cfg = DBO_ISSUE_TYPES.find((t) => t.id === issueTypeId) || null;

  const setField = (fieldId: string, value: string) =>
    onFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  return (
    <section style={sectionStyle}>
      <Label>Step 3: DBO fields</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Issue Type</FieldLabel>
        <select
          value={issueTypeId}
          disabled={locked}
          onChange={(e) => onIssueTypeId(e.target.value)}
          style={selectStyle}
        >
          <option value="">— Pick an issue type —</option>
          {DBO_ISSUE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {cfg && (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
            {cfg.description}
          </div>
        )}
      </div>

      {cfg && metaState === 'loading' && (
        <InfoCard tone="info">Loading DBO field options from Jira…</InfoCard>
      )}
      {cfg && metaState === 'error' && (
        <InfoCard tone="negative">Failed to load DBO fields: {metaError || 'unknown error'}. Reopen the modal to retry.</InfoCard>
      )}

      {cfg && metaState === 'ready' && meta && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
          {cfg.requiredFields.map((f) => (
            <PrrFieldInput
              key={f.fieldId}
              field={f}
              meta={meta}
              value={fieldValues[f.fieldId] || ''}
              childValue={fieldValues[`${f.fieldId}__child`] || ''}
              onChange={(v) => setField(f.fieldId, v)}
              onChildChange={(v) => setField(`${f.fieldId}__child`, v)}
              locked={locked}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// PFO destination fields — issue-type picker plus dynamic required fields resolved via
// createmeta, same shape as DboFields / PrrFields / FraudFields. Replaced a bespoke
// work-type + Express Shipping form whose field IDs and option labels were pinned to the
// now-deprecated OLDPFO project; see the PFO block in moveConfig.ts for the mapping.
function PfoFields(props: {
  issueTypeId: string;
  onIssueTypeId: (id: string) => void;
  fieldValues: Record<string, string>;
  onFieldValues: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  meta: CreateMetaField[] | null;
  metaState: 'idle' | 'loading' | 'ready' | 'error';
  metaError: string | null;
  atlasState: FetchState;
  atlasError: string | null;
  onRetryAtlas: () => void;
  locked: boolean;
}) {
  const { issueTypeId, onIssueTypeId, fieldValues, onFieldValues, meta, metaState, metaError, atlasState, atlasError, onRetryAtlas, locked } = props;
  const cfg = PFO_ISSUE_TYPES.find((t) => t.id === issueTypeId) || null;

  const setField = (fieldId: string, value: string) =>
    onFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  // Express Shipping Request requires all 11 of its fields, so none can be dropped from the
  // move payload — but the ones we can resolve for the operator (Identity ID, Atlas URL and
  // User Tier from the ticket; Cardholder Name and Shipping Address from Atlas) don't need
  // to occupy the form. They collapse behind a summary line, leaving only what has to be
  // filled by hand. A prefill that resolved empty (ticket with no identityId, a tier with no
  // matching option, an Atlas lookup that failed) stays in the visible list: a blank required
  // field has to be fixable here or the move 400s.
  //
  // The set is sticky — a field joins it the moment its prefill lands and never leaves. That
  // covers the Atlas values, which arrive seconds after the form first renders, without
  // letting a field jump out from under the cursor if the operator clears it mid-edit.
  // It resets when metaState leaves 'ready', which is what an issue-type change triggers.
  const autoIdsRef = useRef<Set<string>>(new Set());
  const autoGenRef = useRef<string>('');
  const gen = metaState === 'ready' && cfg ? cfg.id : '';
  if (autoGenRef.current !== gen) {
    autoGenRef.current = gen;
    autoIdsRef.current = new Set();
  }
  if (gen && cfg) {
    for (const f of cfg.requiredFields) {
      if (f.prefillFrom && (fieldValues[f.fieldId] || '').trim()) autoIdsRef.current.add(f.fieldId);
    }
  }
  const autoIds = autoIdsRef.current;
  const autoFields = cfg && gen ? cfg.requiredFields.filter((f) => autoIds.has(f.fieldId)) : [];
  const manualFields = cfg && gen ? cfg.requiredFields.filter((f) => !autoIds.has(f.fieldId)) : (cfg?.requiredFields || []);

  return (
    <section style={sectionStyle}>
      <Label>Step 3: PFO fields</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Issue Type</FieldLabel>
        <select
          value={issueTypeId}
          disabled={locked}
          onChange={(e) => onIssueTypeId(e.target.value)}
          style={selectStyle}
        >
          <option value="">— Pick an issue type —</option>
          {PFO_ISSUE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {cfg && (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
            {cfg.description}
          </div>
        )}
      </div>

      {cfg && metaState === 'loading' && (
        <InfoCard tone="info">Loading PFO field options from Jira…</InfoCard>
      )}
      {cfg && metaState === 'error' && (
        <InfoCard tone="negative">Failed to load PFO fields: {metaError || 'unknown error'}. Reopen the modal to retry.</InfoCard>
      )}

      {cfg && metaState === 'ready' && atlasState === 'pending' && (
        <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
          <InfoCard tone="info">Looking up Cardholder Name + Shipping Address in Atlas…</InfoCard>
        </div>
      )}
      {cfg && metaState === 'ready' && atlasState === 'failed' && (
        <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
          <InfoCard tone="warning">
            Atlas lookup failed ({atlasError || 'unknown error'}) — fill Cardholder Name and Shipping Address by hand.{' '}
            <button
              type="button"
              onClick={onRetryAtlas}
              disabled={locked}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 700, color: 'inherit', textDecoration: 'underline' }}
            >
              Retry
            </button>
          </InfoCard>
        </div>
      )}

      {cfg && metaState === 'ready' && meta && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
          {autoFields.length > 0 && (
            <AutoFilledFields
              fields={autoFields}
              meta={meta}
              fieldValues={fieldValues}
              onChange={setField}
              onChildChange={(id, v) => setField(`${id}__child`, v)}
              locked={locked}
            />
          )}
          {manualFields.map((f) => (
            <PrrFieldInput
              key={f.fieldId}
              field={f}
              meta={meta}
              value={fieldValues[f.fieldId] || ''}
              childValue={fieldValues[`${f.fieldId}__child`] || ''}
              onChange={(v) => setField(f.fieldId, v)}
              onChildChange={(v) => setField(`${f.fieldId}__child`, v)}
              locked={locked}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// Collapsed summary for fields already prefilled from the source ticket. Expands into the
// same PrrFieldInput controls so a wrong prefill is still correctable before the move.
function AutoFilledFields({ fields, meta, fieldValues, onChange, onChildChange, locked }: {
  fields: PrrRequiredField[];
  meta: CreateMetaField[];
  fieldValues: Record<string, string>;
  onChange: (fieldId: string, value: string) => void;
  onChildChange: (fieldId: string, value: string) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Option-typed values are stored as option IDs, so the summary has to map back through
  // createmeta to show the label the operator would recognise ("Core", not "13704").
  const summaryFor = (f: PrrRequiredField) => {
    const raw = fieldValues[f.fieldId] || '';
    if (f.type === 'option' || f.type === 'array-option' || f.type === 'option-with-child') {
      const opt = meta.find((m) => m.fieldId === f.fieldId)?.allowedValues?.find((o) => o.id === raw);
      const label = (opt?.value ?? opt?.name ?? '').toString();
      return label ? `${f.name} (${label})` : f.name;
    }
    // Identity IDs and Atlas URLs are far too long to inline — name only.
    return raw.length <= 24 ? `${f.name} (${raw})` : f.name;
  };

  return (
    <div style={{
      background: 'var(--mint-bg-subtle)',
      border: '1px solid var(--mint-outline)',
      borderRadius: 'var(--mint-radius-button)',
      padding: 'var(--mint-sp-2) var(--mint-sp-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--mint-sp-2)' }}>
        <div style={{ flex: 1, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 700 }}>✓ Auto-filled</span>
          {' — '}
          {fields.map((f) => summaryFor(f)).join(' · ')}
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 'var(--mint-text-nano)', fontWeight: 700,
            color: 'var(--mint-fg-subdued-title)', textDecoration: 'underline',
          }}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)', marginTop: 'var(--mint-sp-3)' }}>
          {fields.map((f) => (
            <PrrFieldInput
              key={f.fieldId}
              field={f}
              meta={meta}
              value={fieldValues[f.fieldId] || ''}
              childValue={fieldValues[`${f.fieldId}__child`] || ''}
              onChange={(v) => onChange(f.fieldId, v)}
              onChildChange={(v) => onChildChange(f.fieldId, v)}
              locked={locked}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// FRAUD destination fields — same shape as DboFields / PrrFields (issue-type picker
// plus dynamic required fields resolved via createmeta). Kept as its own component
// so the "Step 3: FRAUD fields" copy + FRAUD_ISSUE_TYPES source can diverge from
// DBO / PRR without conditional logic in a shared renderer.
function FraudFields(props: {
  issueTypeId: string;
  onIssueTypeId: (id: string) => void;
  fieldValues: Record<string, string>;
  onFieldValues: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  meta: CreateMetaField[] | null;
  metaState: 'idle' | 'loading' | 'ready' | 'error';
  metaError: string | null;
  locked: boolean;
}) {
  const { issueTypeId, onIssueTypeId, fieldValues, onFieldValues, meta, metaState, metaError, locked } = props;
  const cfg = FRAUD_ISSUE_TYPES.find((t) => t.id === issueTypeId) || null;

  const setField = (fieldId: string, value: string) =>
    onFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  return (
    <section style={sectionStyle}>
      <Label>Step 3: FRAUD fields</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Issue Type</FieldLabel>
        <select
          value={issueTypeId}
          disabled={locked}
          onChange={(e) => onIssueTypeId(e.target.value)}
          style={selectStyle}
        >
          <option value="">— Pick an issue type —</option>
          {FRAUD_ISSUE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {cfg && (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
            {cfg.description}
          </div>
        )}
      </div>

      {cfg && metaState === 'loading' && (
        <InfoCard tone="info">Loading FRAUD field options from Jira…</InfoCard>
      )}
      {cfg && metaState === 'error' && (
        <InfoCard tone="negative">Failed to load FRAUD fields: {metaError || 'unknown error'}. Reopen the modal to retry.</InfoCard>
      )}

      {cfg && metaState === 'ready' && meta && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
          {cfg.requiredFields.map((f) => (
            <PrrFieldInput
              key={f.fieldId}
              field={f}
              meta={meta}
              value={fieldValues[f.fieldId] || ''}
              childValue={fieldValues[`${f.fieldId}__child`] || ''}
              onChange={(v) => setField(f.fieldId, v)}
              onChildChange={(v) => setField(`${f.fieldId}__child`, v)}
              locked={locked}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- Problem Area typeahead ----------

function ProblemAreaTypeahead({ value, onChange, disabled }: { value: string; onChange: (s: string) => void; disabled: boolean }) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  useEffect(() => { setQ(value); }, [value]);

  // Compute popover position when opened or on resize. Portaled to document.body so the modal
  // body's overflow doesn't clip it. Sizes the maxHeight to whatever space is below the input.
  useEffect(() => {
    if (!open) { setPopoverPos(null); return; }
    function update() {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom - 16; // 16px viewport margin
      setPopoverPos({
        top: r.bottom + 4,
        left: r.left,
        width: r.width,
        maxHeight: Math.max(180, Math.min(spaceBelow, 360)),
      });
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  // Flatten options with group hints, then filter on every keystroke
  const all = useMemo(() => {
    const r: Array<{ label: string; group: string }> = [];
    EOC_PROBLEM_AREAS.forEach((g) => g.options.forEach((o) => r.push({ label: o, group: g.group })));
    return r;
  }, []);
  const ft = q.toLowerCase().trim();
  const committed = (value || '').toLowerCase().trim();
  // When the input still shows the committed value (user hasn't typed yet), don't filter —
  // we want them to see all 157 options. As soon as their text differs from the committed
  // value, the filter kicks in normally.
  const isShowingCommitted = ft === committed && ft.length > 0;
  const filtered = ft && !isShowingCommitted
    ? all.filter((o) => o.label.toLowerCase().includes(ft))
    : all;

  function pick(idx: number) {
    if (idx < 0 || idx >= filtered.length) return;
    const opt = filtered[idx];
    setQ(opt.label);
    onChange(opt.label);
    setOpen(false);
  }

  // Popover body — portaled so the modal body's overflow doesn't clip it.
  const popover = open && popoverPos ? createPortal(
    <div
      style={{
        position: 'fixed',
        top: popoverPos.top,
        left: popoverPos.left,
        width: popoverPos.width,
        maxHeight: popoverPos.maxHeight,
        overflowY: 'auto',
        background: 'var(--mint-bg-card)',
        border: 'var(--mint-card-stroke)',
        borderRadius: 'var(--mint-radius-card)',
        boxShadow: '0 8px 24px rgba(20,17,12,0.22)',
        zIndex: 2000, // above modal (modal uses 1000)
      }}
    >
      {filtered.length === 0 ? (
        <div style={{ padding: 'var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
          No matches for "{q}"
        </div>
      ) : filtered.map((opt, i) => {
        const prev = i > 0 ? filtered[i - 1].group : null;
        return (
          <div key={opt.label + i}>
            {opt.group !== prev && (
              <div style={{ padding: '6px 12px 2px', fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, background: 'var(--mint-bg-subtle)', position: 'sticky', top: 0 }}>
                {opt.group}
              </div>
            )}
            <div
              onMouseDown={(e) => { e.preventDefault(); pick(i); }}
              style={{
                padding: '8px 12px',
                fontSize: 'var(--mint-text-meta)',
                background: i === hl ? 'var(--mint-highlight-bg-soft)' : 'transparent',
                color: i === hl ? 'var(--mint-highlight-fg-strong)' : 'var(--mint-fg-strong)',
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <div>
      <input
        ref={inputRef}
        type="text"
        value={q}
        disabled={disabled}
        placeholder="Type to search… (157 options)"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); setQ(value || ''); }, 150)}
        onChange={(e) => { setQ(e.target.value); setHl(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHl((p) => (p < filtered.length - 1 ? p + 1 : 0)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((p) => (p > 0 ? p - 1 : filtered.length - 1)); }
          else if (e.key === 'Enter')  { e.preventDefault(); pick(hl); }
          else if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
        }}
        style={{
          width: '100%',
          padding: '6px 10px',
          border: 'var(--mint-card-stroke)',
          borderRadius: 'var(--mint-radius-button)',
          fontSize: 'var(--mint-text-meta)',
          background: 'var(--mint-bg-card)',
          color: 'var(--mint-fg-strong)',
        }}
      />
      {popover}
    </div>
  );
}

// ---------- Confirm + success ----------

function ConfirmRow({ onConfirm, onBack, destName, ticketId }: { onConfirm: () => void; onBack: () => void; destName: string; ticketId: string }) {
  return (
    <div style={{ background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-3)', width: '100%' }}>
      <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 600, color: 'var(--mint-warning-fg-strong)', marginBottom: 'var(--mint-sp-2)' }}>
        Clone {ticketId}, then reassign the original to {destName}, then move the clone to Done? The original keeps its Zendesk link.
      </div>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <button onClick={onConfirm} style={{ ...primaryButton, background: 'var(--mint-positive-fg-graphic)' }}>✓ Confirm Clone/Move</button>
        <button onClick={onBack} style={secondaryButton}>← Back to Edit</button>
      </div>
    </div>
  );
}

function SuccessPanel({ ticketId, note, warnings, cloneKey, onClose }: { ticketId: string; note: string; warnings: string[]; cloneKey: string | null; onClose: () => void }) {
  return (
    <div style={{ padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ fontSize: 24, marginBottom: 'var(--mint-sp-2)' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-positive-fg-strong)' }}>Clone/Move accepted</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)' }}>{note}</p>
      <p style={{ margin: 0, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        Jira processes the move asynchronously — usually 10–30 seconds. Open{' '}
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticketId}</a>
        {cloneKey ? (
          <>
            {' '}or{' '}
            <a href={`https://wealthsimple.atlassian.net/browse/${cloneKey}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>{cloneKey}</a>
          </>
        ) : null}
        {' '}in Jira to verify.
      </p>
      {warnings.length > 0 ? (
        <ul style={{ textAlign: 'left', margin: 'var(--mint-sp-3) 0 0', padding: '8px 12px', background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', listStyle: 'disc', paddingLeft: 24 }}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      ) : null}
      <button onClick={onClose} style={{ ...primaryButton, marginTop: 'var(--mint-sp-3)' }}>Close</button>
    </div>
  );
}

// ---------- bits ----------

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 'var(--mint-sp-2)' }}>{children}</div>;
}
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)', fontWeight: 600, marginBottom: 4 }}>{children}</div>;
}
function Row({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', padding: '4px 0', borderBottom: '1px dashed var(--mint-outline)' }}>
      <div style={{ minWidth: 90, color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ flex: 1, color: 'var(--mint-fg-strong)', fontSize: 'var(--mint-text-micro)', fontFamily: mono ? 'var(--mint-font-mono)' : 'inherit', wordBreak: 'break-all' }}>{children}</div>
    </div>
  );
}
function Missing({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--mint-negative-fg-strong)', fontStyle: 'italic' }}>{children}</span>;
}
function InfoCard({ tone, children }: { tone: 'info' | 'warning' | 'negative'; children: React.ReactNode }) {
  const palette = {
    info:     { bg: 'var(--mint-highlight-bg-soft)', fg: 'var(--mint-highlight-fg-strong)' },
    warning:  { bg: 'var(--mint-warning-bg-soft)',   fg: 'var(--mint-warning-fg-strong)' },
    negative: { bg: 'var(--mint-negative-bg-soft)',  fg: 'var(--mint-negative-fg-strong)' },
  }[tone];
  return (
    <div style={{ background: palette.bg, color: palette.fg, padding: 'var(--mint-sp-2) var(--mint-sp-3)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-meta)', fontWeight: 500 }}>
      {children}
    </div>
  );
}

// ---------- shells ----------

function Overlay({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(20,17,12,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--mint-sp-3)',
        zIndex: 1000,
      }}
    >
      {children}
    </div>
  );
}

function Modal({ onClick, children }: { onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--mint-bg-card)',
        border: 'var(--mint-card-stroke)',
        borderRadius: 'var(--mint-radius-card)',
        maxWidth: 480,
        width: '100%',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(20,17,12,0.25)',
      }}
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
  display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)',
};
const footerStyle: React.CSSProperties = {
  padding: 'var(--mint-sp-3) var(--mint-sp-4)',
  borderTop: 'var(--mint-card-stroke)',
  display: 'flex', justifyContent: 'flex-end',
};
function PrrFields(props: {
  issueTypeId: string;
  onIssueTypeId: (id: string) => void;
  fieldValues: Record<string, string>;
  onFieldValues: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  meta: CreateMetaField[] | null;
  metaState: 'idle' | 'loading' | 'ready' | 'error';
  metaError: string | null;
  locked: boolean;
}) {
  const { issueTypeId, onIssueTypeId, fieldValues, onFieldValues, meta, metaState, metaError, locked } = props;
  const cfg = PRR_ISSUE_TYPES.find((t) => t.id === issueTypeId) || null;

  const setField = (fieldId: string, value: string) =>
    onFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  return (
    <section style={sectionStyle}>
      <Label>Step 3: PRR fields</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Issue Type</FieldLabel>
        <select
          value={issueTypeId}
          disabled={locked}
          onChange={(e) => onIssueTypeId(e.target.value)}
          style={selectStyle}
        >
          <option value="">— Pick an issue type —</option>
          {PRR_ISSUE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {cfg && (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
            {cfg.description}
          </div>
        )}
      </div>

      {cfg && metaState === 'loading' && (
        <InfoCard tone="info">Loading PRR field options from Jira…</InfoCard>
      )}
      {cfg && metaState === 'error' && (
        <InfoCard tone="negative">Failed to load PRR fields: {metaError || 'unknown error'}. Reopen the modal to retry.</InfoCard>
      )}

      {cfg && metaState === 'ready' && meta && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
          {cfg.requiredFields.map((f) => (
            <PrrFieldInput
              key={f.fieldId}
              field={f}
              meta={meta}
              value={fieldValues[f.fieldId] || ''}
              childValue={fieldValues[`${f.fieldId}__child`] || ''}
              onChange={(v) => setField(f.fieldId, v)}
              onChildChange={(v) => setField(`${f.fieldId}__child`, v)}
              locked={locked}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PrrFieldInput({ field, meta, value, childValue, onChange, onChildChange, locked }: {
  field: PrrRequiredField;
  meta: CreateMetaField[];
  value: string;
  childValue: string;
  onChange: (v: string) => void;
  onChildChange: (v: string) => void;
  locked: boolean;
}) {
  const metaField = meta.find((m) => m.fieldId === field.fieldId);
  const options = metaField?.allowedValues || [];
  const labelFor = (v: CreateMetaAllowedValue) => v.value ?? v.name ?? v.id;
  // Only PFO marks fields optional today (fields it lists purely to prefill them). Saying so
  // matters when a prefill fails and the input turns up blank in the manual list — without it
  // the operator can't tell it apart from something the move actually needs.
  const name = field.optional ? `${field.name} (optional)` : field.name;

  if (field.type === 'string') {
    return (
      <div>
        <FieldLabel>{name}</FieldLabel>
        <input type="text" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      </div>
    );
  }
  if (field.type === 'number') {
    return (
      <div>
        <FieldLabel>{name}</FieldLabel>
        <input type="number" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      </div>
    );
  }
  if (field.type === 'paragraph') {
    return (
      <div>
        <FieldLabel>{name}</FieldLabel>
        <textarea value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
      </div>
    );
  }
  if (field.type === 'date') {
    return (
      <div>
        <FieldLabel>{name}</FieldLabel>
        <input type="date" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      </div>
    );
  }
  if (field.type === 'option' || field.type === 'array-option') {
    // array-option = Jira checkbox field (a value-array on the wire). We surface it as a
    // single-select for now — the submit branch wraps the chosen option ID in a
    // 1-length array so Jira accepts it. Agent can add more selections via Jira after.
    return (
      <div>
        <FieldLabel>{name}{field.type === 'array-option' ? ' (pick one)' : ''}</FieldLabel>
        <select value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
          <option value="">— Select —</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{labelFor(o)}</option>
          ))}
        </select>
      </div>
    );
  }
  if (field.type === 'option-with-child') {
    const parent = options.find((o) => o.id === value);
    const children = parent?.children || [];
    return (
      <div>
        <FieldLabel>{name}</FieldLabel>
        <select value={value} disabled={locked} onChange={(e) => { onChange(e.target.value); onChildChange(''); }} style={selectStyle}>
          <option value="">— Select —</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{labelFor(o)}</option>
          ))}
        </select>
        {children.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <select value={childValue} disabled={locked} onChange={(e) => onChildChange(e.target.value)} style={selectStyle}>
              <option value="">— Select detail —</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>{labelFor(c)}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  }
  return null;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 'var(--mint-text-micro)',
  border: '1px solid var(--mint-outline-strong)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column' };
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
