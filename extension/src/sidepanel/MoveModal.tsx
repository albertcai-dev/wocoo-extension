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
// to the ticket. PFO (restored alongside DBO) handles Express Shipping Request card
// reissues and Cheques: Delivery Issue via hardcoded issue-type IDs.

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
  PFO_PROJECT_ID,
  PFO_EXPRESS_SHIPPING_ISSUETYPE_ID,
  PFO_CHEQUES_DELIVERY_ISSUETYPE_ID,
  EXPRESS_SHIPPING_FIELDS,
  CARD_TYPE_LABELS,
  type CardType,
  USER_TIER_LABELS,
  type UserTier,
  REISSUE_REASON_LABELS,
  PFO_API_SUPPORTED_WORK_TYPES,
  type PfoWorkType,
  recommendedCardType,
  recommendedPfoWorkType,
  tierToUserTierLabel,
} from '../data/moveConfig';
import {
  moveTicket,
  rawField,
  adfField,
  MOVE_FIELDS,
  lookupProjectAndIssueType,
  resolveEocProblemAreaId,
  resolveOptionId,
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
import { fetchAtlasAccountIdHeadless } from '../data/atlasAccountLookup';

type Status = 'configuring' | 'confirming' | 'executing' | 'success' | 'error';

type FetchState = 'idle' | 'pending' | 'success' | 'failed';

export function MoveModal({ ticket, onClose, initialDestKey = 'EOC' }: { ticket: WocooTicket; onClose: () => void; initialDestKey?: MoveDestination }) {
  const [destKey, setDestKey] = useState<MoveDestination>(initialDestKey);
  const [clientStatus, setClientStatus] = useState<keyof typeof EOC_CLIENT_STATUS_IDS>('Premium');
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

  // PFO: hardcoded issue types (Express Shipping Request 14656, Cheques Delivery 14658).
  // Express Shipping form has its own bespoke UI — auto-prefilled from ticket.workType /
  // ticket.tier and driven by resolveOptionId at submit.
  const [pfoWorkType, setPfoWorkType] = useState<PfoWorkType>(recommendedPfoWorkType(ticket.workType));
  const [cardType, setCardType] = useState<CardType>(recommendedCardType(ticket.workType));
  const [userTier, setUserTier] = useState<UserTier>(tierToUserTierLabel(ticket.tier));
  const [reissueReason, setReissueReason] = useState<string>('');
  const [dateNeeded, setDateNeeded] = useState<string>('ASAP');

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && status !== 'executing') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, status]);

  // Keep Card Type in sync with the PFO work-type button. Always overwrites — the picker
  // is the primary intent, so a stale toggle from a previous selection stays consistent.
  useEffect(() => {
    if (pfoWorkType === 'Credit Card: Delivery Issue') setCardType('Credit Card');
    else if (pfoWorkType === 'Prepaid Card: Delivery Issue') setCardType('Prepaid Mastercard');
  }, [pfoWorkType]);

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
    const prefilled: Record<string, string> = {};
    for (const f of prrConfig.requiredFields) {
      if (f.prefillFrom === 'identityId' && ticket.identityId) prefilled[f.fieldId] = ticket.identityId;
      else if (f.prefillFrom === 'ticketUrl') prefilled[f.fieldId] = `https://wealthsimple.atlassian.net/browse/${ticket.id}`;
    }
    setPrrFieldValues(prefilled);
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
    const prefilled: Record<string, string> = {};
    for (const f of fraudConfig.requiredFields) {
      if (f.prefillFrom === 'identityId' && ticket.identityId) prefilled[f.fieldId] = ticket.identityId;
      else if (f.prefillFrom === 'ticketUrl') prefilled[f.fieldId] = `https://wealthsimple.atlassian.net/browse/${ticket.id}`;
    }
    setFraudFieldValues(prefilled);
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
    const prefilled: Record<string, string> = {};
    for (const f of dboConfig.requiredFields) {
      if (f.prefillFrom === 'identityId' && ticket.identityId) prefilled[f.fieldId] = ticket.identityId;
      else if (f.prefillFrom === 'ticketUrl') prefilled[f.fieldId] = `https://wealthsimple.atlassian.net/browse/${ticket.id}`;
    }
    setDboFieldValues(prefilled);
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

  const isPfoCheques = pfoWorkType === 'Cheques: Delivery Issue';
  const pfoReady = !!ticket.identityId && (
    isPfoCheques
      ? true
      : !!reissueReason && !!dateNeeded.trim() && !!cardType && !!userTier
  );

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
        if (!ticket.identityId) throw new Error('Source ticket has no Identity ID.');

        if (isPfoCheques) {
          destLabel = `PFO (${pfoWorkType})`;
          moveCall = () => moveTicket({
            sourceKey: ticket.id,
            destProjectId: PFO_PROJECT_ID,
            destIssueTypeId: PFO_CHEQUES_DELIVERY_ISSUETYPE_ID,
            mandatoryFields: {
              [EXPRESS_SHIPPING_FIELDS.SUMMARY]:     rawField(ticket.summary),
              [EXPRESS_SHIPPING_FIELDS.IDENTITY_ID]: rawField(ticket.identityId),
            },
          });
        } else {
          if (!reissueReason) throw new Error('Pick a Reissue Reason first.');
          if (!dateNeeded.trim()) throw new Error('Enter a Date that card is needed.');

          const [cardTypeId, userTierId, reissueReasonId, didReissueId, cxKeepsId] = await Promise.all([
            resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.CARD_TYPE, cardType),
            resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.USER_TIER, userTier),
            resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.REISSUE_REASON, reissueReason),
            resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.DID_REISSUE, 'No'),
            resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.CX_KEEPS_OWNERSHIP, 'Yes'),
          ]);

          destLabel = `PFO (Express Shipping Request · ${cardType} · ${reissueReason})`;

          moveCall = () => moveTicket({
            sourceKey: ticket.id,
            destProjectId: PFO_PROJECT_ID,
            destIssueTypeId: PFO_EXPRESS_SHIPPING_ISSUETYPE_ID,
            mandatoryFields: {
              [EXPRESS_SHIPPING_FIELDS.SUMMARY]:               rawField(ticket.summary),
              [EXPRESS_SHIPPING_FIELDS.IDENTITY_ID]:           rawField(ticket.identityId),
              [EXPRESS_SHIPPING_FIELDS.CARD_TYPE]:             rawField(cardTypeId),
              [EXPRESS_SHIPPING_FIELDS.USER_TIER]:             rawField(userTierId),
              [EXPRESS_SHIPPING_FIELDS.REISSUE_REASON]:        rawField(reissueReasonId),
              [EXPRESS_SHIPPING_FIELDS.DATE_NEEDED]:           rawField(dateNeeded.trim()),
              [EXPRESS_SHIPPING_FIELDS.DID_REISSUE]:           rawField(didReissueId),
              [EXPRESS_SHIPPING_FIELDS.CX_KEEPS_OWNERSHIP]:    rawField(cxKeepsId),
              [EXPRESS_SHIPPING_FIELDS.UNABLE_REISSUE_REASON]: rawField('CX does not have tooling to perform the card reissue; requires PFO to action.'),
              [EXPRESS_SHIPPING_FIELDS.KEEP_OWNERSHIP_REASON]: rawField('CX to send final comms to client.'),
            },
          });
        }
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
                  workType={pfoWorkType}
                  onWorkType={setPfoWorkType}
                  locked={status === 'confirming' || status === 'executing'}
                />
              )}
              {dest.key === 'PFO' && !isPfoCheques && (
                <ExpressShippingFields
                  cardType={cardType}
                  onCardType={setCardType}
                  userTier={userTier}
                  onUserTier={setUserTier}
                  reissueReason={reissueReason}
                  onReissueReason={setReissueReason}
                  dateNeeded={dateNeeded}
                  onDateNeeded={setDateNeeded}
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

// PFO work-type picker — three-way button row (Credit Card / Prepaid Card / Cheques).
// Credit Card + Prepaid Card both route to Express Shipping Request; Cheques routes
// to the minimal Cheques: Delivery Issue path.
function PfoFields(props: {
  workType: PfoWorkType;
  onWorkType: (w: PfoWorkType) => void;
  locked: boolean;
}) {
  return (
    <section style={sectionStyle}>
      <Label>Step 3: PFO work type</Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {PFO_API_SUPPORTED_WORK_TYPES.map((w) => {
          const active = props.workType === w;
          return (
            <button
              key={w}
              disabled={props.locked}
              onClick={() => props.onWorkType(w)}
              style={{
                padding: '8px 12px',
                background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)',
                color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)',
                border: 'var(--mint-card-stroke)',
                borderRadius: 'var(--mint-radius-button)',
                fontWeight: 600,
                fontSize: 'var(--mint-text-meta)',
                cursor: props.locked ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                opacity: props.locked ? 0.6 : 1,
              }}
            >
              {w}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Express Shipping Request form — 4 visible fields. Four more (DID_REISSUE,
// CX_KEEPS_OWNERSHIP, UNABLE_REISSUE_REASON, KEEP_OWNERSHIP_REASON) are hidden
// and hardcoded at submit (the last two are Jira-required follow-ups to the
// first two answers).
function ExpressShippingFields(props: {
  cardType: CardType;
  onCardType: (c: CardType) => void;
  userTier: UserTier;
  onUserTier: (t: UserTier) => void;
  reissueReason: string;
  onReissueReason: (r: string) => void;
  dateNeeded: string;
  onDateNeeded: (d: string) => void;
  locked: boolean;
}) {
  return (
    <section style={sectionStyle}>
      <Label>Step 4: Express Shipping Request details</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Card Type</FieldLabel>
        <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
          {CARD_TYPE_LABELS.map((ct) => {
            const active = props.cardType === ct;
            return (
              <button
                key={ct}
                disabled={props.locked}
                onClick={() => props.onCardType(ct)}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)',
                  color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)',
                  border: 'var(--mint-card-stroke)',
                  borderRadius: 'var(--mint-radius-button)',
                  fontWeight: 600,
                  fontSize: 'var(--mint-text-meta)',
                  cursor: props.locked ? 'not-allowed' : 'pointer',
                  opacity: props.locked ? 0.6 : 1,
                }}
              >
                {ct}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>User Tier</FieldLabel>
        <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
          {USER_TIER_LABELS.map((t) => {
            const active = props.userTier === t;
            return (
              <button
                key={t}
                disabled={props.locked}
                onClick={() => props.onUserTier(t)}
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
                {t}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Reissue Reason <span style={{ color: 'var(--mint-negative-fg-strong)' }}>*</span></FieldLabel>
        <select
          value={props.reissueReason}
          disabled={props.locked}
          onChange={(e) => props.onReissueReason(e.target.value)}
          style={selectStyle}
        >
          <option value="">Select a reason…</option>
          {REISSUE_REASON_LABELS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      <div>
        <FieldLabel>Date that card is needed <span style={{ color: 'var(--mint-negative-fg-strong)' }}>*</span></FieldLabel>
        <input
          type="text"
          value={props.dateNeeded}
          disabled={props.locked}
          onChange={(e) => props.onDateNeeded(e.target.value)}
          placeholder="e.g. ASAP, June 26 2026, Not urgent"
          style={inputStyle}
        />
      </div>
    </section>
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

  if (field.type === 'string') {
    return (
      <div>
        <FieldLabel>{field.name}</FieldLabel>
        <input type="text" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      </div>
    );
  }
  if (field.type === 'number') {
    return (
      <div>
        <FieldLabel>{field.name}</FieldLabel>
        <input type="number" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      </div>
    );
  }
  if (field.type === 'paragraph') {
    return (
      <div>
        <FieldLabel>{field.name}</FieldLabel>
        <textarea value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
      </div>
    );
  }
  if (field.type === 'date') {
    return (
      <div>
        <FieldLabel>{field.name}</FieldLabel>
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
        <FieldLabel>{field.name}{field.type === 'array-option' ? ' (pick one)' : ''}</FieldLabel>
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
        <FieldLabel>{field.name}</FieldLabel>
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
