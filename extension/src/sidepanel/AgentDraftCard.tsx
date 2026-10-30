// Agent draft card: the local draft agent's reply for the open ticket, its evidence and flags,
// and a one-click "Post + mark Done". Renders nothing when the agent has no draft for the ticket.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import type { AgentDraft, DraftActionNeeded, DraftSegment } from '../data/agentDraftTypes';
import { toMovePrefill, type MovePrefill } from '../data/movePrefill';
import { DraftStoreUnavailable, getDraft, getTeam, isDraftStoreNotSetUp, recordOutcome } from '../api/draftStore';
import { buildJiraOutcomeRow, rememberDraft, type ExistingReply } from '../data/outcomeCapture';
import { checkExistingReplyLive, lookupAssignedAtLive } from '../data/outcomeCaptureLive';
import { getIssuePeople, postComment, searchJiraUsers, transitionTicketByName } from '../api/jira';
import {
  applyMentionResolution, buildOutcomeRow, canPost, currentStatusName, flagLabel, isHttpUrl, markPostedThisSession, matchPeopleByName,
  plainToSegments, postLabel, segmentsToPlain, shouldTransition, unresolvedMentionNames, wasPostedThisSession,
  type MentionCandidate,
} from '../data/agentDraftView';
import {
  CLEAR_PREFILL_MESSAGE, INITIAL_PREFILL_RETRY, PREFILL_COMMENT_MESSAGE, afterPrefillReply, afterTicketShown,
  type ClearPrefillMessage, type ClearPrefillReply, type PrefillCommentMessage, type PrefillCommentReply, type PrefillRetryState,
} from '../data/commentPrefill';
import { JIRA_TAB_URL } from '../data/jiraTab';
import { errorBanner, primaryButton, secondaryButton } from './toolUi';
import { LessonReview } from './LessonReview';
import { worthReviewing } from '../data/draftLessons';
import { greetTarget, pickReplyTarget, replyParentId, type ReplyTarget } from '../data/replyTarget';
import { planPost } from '../data/postPlan';

type Load =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; draft: AgentDraft };

type Mentions =
  | { kind: 'resolving' }
  | { kind: 'done'; segments: DraftSegment[]; unresolved: string[] };

type Phase = 'idle' | 'posting' | 'comment-posted' | 'done';

/** State of pre-filling the Jira tab's comment box with the draft (never saved by Sidekick). */
type Prefill =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'inserted'; partial: boolean }
  | { kind: 'skipped'; reason: 'not-empty' | 'no-editor' | 'wrong-ticket' | 'interrupted' | 'busy-elsewhere' | 'unreachable' | 'error' };

/** Whether the card may offer this draft for posting. 'checking' shows the editor while Jira is
 *  asked whether the user already replied (Post re-checks; the automatic prefill waits). */
type Gate =
  | { kind: 'checking' }
  | { kind: 'open' }
  /** The ticket is Done or Cancelled: nothing to post, no prefill. */
  | { kind: 'closed'; status: string }
  /** The earlier-reply check failed: the draft stays usable by hand, but is never auto-filled. */
  | { kind: 'unchecked' }
  | { kind: 'posted-earlier' }
  | { kind: 'already-replied'; existing: ExistingReply };

/** After a 'wrong-ticket' / 'unreachable' prefill, how long to let a freshly shown Jira ticket
 *  render before the one retry. */
const PREFILL_RETRY_DELAY_MS = 1_000;

/** Asks the Jira content script in the active tab to fill its comment box. null when there is no
 *  Jira tab in front or its content script can't be reached (e.g. the tab predates an extension reload). */
async function requestCommentPrefill(
  key: string, segments: DraftSegment[], force: boolean, auto: boolean,
): Promise<PrefillCommentReply | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || !tab.url || !JIRA_TAB_URL.test(tab.url)) return null;
    const msg: PrefillCommentMessage = { type: PREFILL_COMMENT_MESSAGE, key, segments, force, auto };
    const reply = (await chrome.tabs.sendMessage(tab.id, msg)) as PrefillCommentReply | undefined;
    return reply ?? null;
  } catch {
    return null;
  }
}

/** After a successful post: asks the Jira tab to empty its comment box if it still holds the
 *  prefilled draft (so the unsaved copy can't be saved a second time). Fire and forget. */
async function requestClearPrefill(key: string, segments: DraftSegment[]): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || !tab.url || !JIRA_TAB_URL.test(tab.url)) return;
    const msg: ClearPrefillMessage = { type: CLEAR_PREFILL_MESSAGE, key, segments };
    const reply = (await chrome.tabs.sendMessage(tab.id, msg)) as ClearPrefillReply | undefined;
    if (reply && !reply.cleared && reply.reason !== 'empty') console.debug('[AgentDraftCard] left the Jira box alone:', reply.reason);
  } catch { /* no Jira tab / content script: nothing to clear */ }
}

const PREFILL_NOTES: Record<Extract<Prefill, { kind: 'skipped' }>['reason'], string> = {
  'not-empty': 'The Jira comment box already has text, so the draft was not inserted.',
  'no-editor': "Couldn't find the Jira comment box.",
  'wrong-ticket': 'The Jira tab is showing a different ticket.',
  interrupted: 'Inserting stopped because the Jira comment box lost focus or the page changed — check what landed there; copy the rest from the card.',
  'busy-elsewhere': "You were typing in another field on the Jira page, so the draft wasn't inserted.",
  unreachable: "Couldn't reach the Jira tab — reload it to insert the draft.",
  error: "The Jira tab couldn't insert the draft (another insert was still running, or it hit an error) — try again.",
};

/** Which skipped states offer the Insert draft button, and with what force. */
const INSERT_FORCE: Partial<Record<Extract<Prefill, { kind: 'skipped' }>['reason'], boolean>> = {
  'not-empty': true,
  'no-editor': false,
  'busy-elsewhere': false,
  unreachable: false,
  error: false,
};

/** Vendor workflows fill the i2c / KOHO card below with the agent's text instead of opening a tile. */
const VENDOR_WORKFLOW_LABEL: Partial<Record<NonNullable<DraftActionNeeded['workflow']>, string>> = {
  i2c_ticket: 'Open i2c form with draft',
  koho_email: 'Go to KOHO email with draft',
};

const STATUSES: ReadonlyArray<WocooTicket['status']> = ['Triage', 'Back Office', 'Pending', 'Done', 'Cancelled', 'Other'];

export function AgentDraftCard({ ticket, onOpenWorkflow, onTicketUpdate, onOpenMove, onSolveAgain }: {
  ticket: WocooTicket;
  onOpenWorkflow: (workflow: NonNullable<DraftActionNeeded['workflow']>, vendorDraft?: DraftActionNeeded['vendor_draft']) => void;
  onTicketUpdate?: (t: WocooTicket) => void;
  /** Opens the Move modal pre-filled from the agent's move suggestion. */
  onOpenMove?: (prefill: MovePrefill) => void;
  /** Re-queues the ticket with the agent (e.g. after a new message); this draft is replaced. */
  onSolveAgain?: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    getDraft(ticket.id).then(
      (draft) => {
        // Keep what the user saw: the agent's poll may supersede it before they close the ticket.
        if (draft) rememberDraft(draft);
        if (!cancelled) setLoad(draft ? { kind: 'ready', draft } : { kind: 'none' });
      },
      (e) => {
        if (cancelled) return;
        // No draft agent on this machine (a teammate sharing the extension): render nothing.
        if (isDraftStoreNotSetUp(e)) setLoad({ kind: 'none' });
        else setLoad(e instanceof DraftStoreUnavailable ? { kind: 'unavailable' } : { kind: 'none' });
      },
    );
    return () => { cancelled = true; };
  }, [ticket.id]);

  if (load.kind === 'loading' || load.kind === 'none') return null;
  if (load.kind === 'unavailable') {
    return (
      <div style={cardStyle}>
        <div style={mutedStyle}>Draft store unreachable — run native-host/install.sh</div>
      </div>
    );
  }
  return (
    <DraftBody
      key={`${load.draft.ticket}:${load.draft.created_at}`}
      ticket={ticket}
      draft={load.draft}
      onOpenWorkflow={onOpenWorkflow}
      onTicketUpdate={onTicketUpdate}
      onOpenMove={onOpenMove}
      onSolveAgain={onSolveAgain}
    />
  );
}

function DraftBody({ ticket, draft, onOpenWorkflow, onTicketUpdate, onOpenMove, onSolveAgain }: {
  ticket: WocooTicket;
  draft: AgentDraft;
  onOpenWorkflow: (workflow: NonNullable<DraftActionNeeded['workflow']>, vendorDraft?: DraftActionNeeded['vendor_draft']) => void;
  onTicketUpdate?: (t: WocooTicket) => void;
  onOpenMove?: (prefill: MovePrefill) => void;
  onSolveAgain?: () => void;
}) {
  const editable = draft.outcome === 'draft' || draft.outcome === 'needs_info';
  const [text, setText] = useState(() => segmentsToPlain(draft.segments));
  const [actionDone, setActionDone] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mentions, setMentions] = useState<Mentions>({ kind: 'resolving' });
  const [recordFailed, setRecordFailed] = useState(false);
  /** What was posted, when it differs enough from the draft to learn from. */
  const [editedPost, setEditedPost] = useState<string | null>(null);
  const recordedRef = useRef(false);
  const [prefill, setPrefill] = useState<Prefill>({ kind: 'idle' });
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  const autoPrefilledRef = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  /** Whose comment Post replies under ('loading' until comments + team are read). */
  const [target, setTarget] = useState<{ kind: 'loading' } | { kind: 'ready'; target: ReplyTarget | null; teamMissing: boolean }>({ kind: 'loading' });
  const targetRef = useRef(target);
  targetRef.current = target;
  /** Set when Post found a different target and the user has seen it: '' = new comment. */
  const [confirmedTarget, setConfirmedTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gateRef = useRef(gate);
  gateRef.current = gate;

  // A draft already handled from this card this session (memory or chrome.storage.session, so a
  // panel reload counts) is never offered again; nor is one the user already answered in Jira.
  // Checked once on mount: during this card's own post the posted mark flips true early.
  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    (async () => {
      // A ticket this card just posted and closed keeps its "posted" state; only a ticket found
      // already closed gets the closed note.
      if ((ticket.status === 'Done' || ticket.status === 'Cancelled') && phaseRef.current === 'idle') {
        setGate({ kind: 'closed', status: currentStatusName(ticket) });
        return;
      }
      if (await wasPostedThisSession(ticket.id, draft.created_at)) {
        if (!cancelled) setGate({ kind: 'posted-earlier' });
        return;
      }
      try {
        const existing = await checkExistingReplyLive(draft);
        if (!cancelled) setGate(existing.reply ? { kind: 'already-replied', existing } : { kind: 'open' });
        const t = await resolveTarget(existing);
        if (!cancelled) setTarget({ kind: 'ready', ...t });
      } catch (e) {
        // Fail closed for the automatic prefill (it would land on a ticket he may already have
        // answered); Insert draft and Post stay available, and Post checks again before posting.
        console.warn('[AgentDraftCard] could not check for an earlier reply', e);
        if (!cancelled) setGate({ kind: 'unchecked' });
        if (!cancelled) setTarget({ kind: 'ready', target: null, teamMissing: false });
      }
    })();
    return () => { cancelled = true; };
  }, [draft, editable, ticket.id, ticket.status]);

  // Resolve @Name mentions to Jira accounts as the card loads, so any problem shows before posting.
  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    const names = unresolvedMentionNames(draft.segments);
    (async () => {
      const results: Record<string, MentionCandidate[]> = {};
      // People already on the ticket first (the usual mention is its reporter); user search, which
      // needs a profile scope Sidekick may not have, only for names not found there.
      const people = names.length ? await getIssuePeople(ticket.id).catch(() => [] as MentionCandidate[]) : [];
      await Promise.all(names.map(async (name) => {
        const onTicket = matchPeopleByName(people, name);
        if (onTicket.length === 1) { results[name] = onTicket; return; }
        try { results[name] = await searchJiraUsers(name); } catch { /* leave unresolved */ }
      }));
      if (cancelled) return;
      const r = applyMentionResolution(draft.segments, results);
      setMentions({ kind: 'done', segments: r.segments, unresolved: r.unresolved });
    })();
    return () => { cancelled = true; };
  }, [draft, editable, ticket.id]);

  // One automatic retry when the Jira tab wasn't showing this ticket yet (e.g. opened from Drafts
  // ready, which navigates the tab): fired when the content script reports this ticket.
  const retryRef = useRef<PrefillRetryState>(INITIAL_PREFILL_RETRY);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const sendPrefillRef = useRef<(force: boolean, auto?: boolean) => Promise<void>>(async () => {});

  const retryPrefillSoon = () => {
    setTimeout(() => {
      const p = prefillRef.current;
      // Only if the card is still up and nothing happened meanwhile (no Insert click, no post).
      if (!mountedRef.current || gateRef.current.kind !== 'open' || phaseRef.current !== 'idle' || p.kind !== 'skipped' || (p.reason !== 'wrong-ticket' && p.reason !== 'unreachable')) return;
      void sendPrefillRef.current(false, true);
    }, PREFILL_RETRY_DELAY_MS);
  };

  // Never guess a target without the team list: replying under a teammate is the one mistake
  // the rule exists to avoid, so a missing list falls back to a new comment.
  const resolveTarget = async (existing: ExistingReply): Promise<{ target: ReplyTarget | null; teamMissing: boolean }> => {
    try {
      return { target: pickReplyTarget(existing.comments, await getTeam()), teamMissing: false };
    } catch {
      return { target: null, teamMissing: true };
    }
  };

  // Pre-fill the Jira comment box with the (mention-resolved, possibly edited) draft. Never saves.
  const sendPrefill = async (force: boolean, auto = false) => {
    if (mentions.kind !== 'done') return;
    const segments = plainToSegments(textRef.current, mentions.segments);
    if (!segmentsToPlain(segments).trim()) return;
    setPrefill({ kind: 'sending' });
    const reply = await requestCommentPrefill(ticket.id, segments, force, auto);
    const next = afterPrefillReply(retryRef.current, reply, auto);
    retryRef.current = next.state;
    if (next.retryNow) retryPrefillSoon();
    if (!reply) { setPrefill({ kind: 'skipped', reason: 'unreachable' }); return; }
    if (!reply.ok) { setPrefill({ kind: 'skipped', reason: 'error' }); return; }
    if (reply.inserted) { setPrefill({ kind: 'inserted', partial: reply.reason === 'partial' }); return; }
    // inserted:false with no reason = nothing to insert; leave the controls alone.
    setPrefill(reply.reason ? { kind: 'skipped', reason: reply.reason } : { kind: 'idle' });
  };
  sendPrefillRef.current = sendPrefill;

  useEffect(() => {
    if (!editable || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string; key?: string } | null;
      if (m?.type !== 'wocoo:ticket-changed' || m.key !== ticket.id) return;
      const next = afterTicketShown(retryRef.current);
      retryRef.current = next.state;
      if (next.retryNow) retryPrefillSoon();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, ticket.id]);

  // Once per ticket open (this card mounts per ticket + draft), as soon as mentions are resolved
  // and Jira shows no reply from the user since the draft.
  useEffect(() => {
    if (!editable || gate.kind !== 'open' || mentions.kind !== 'done' || autoPrefilledRef.current) return;
    autoPrefilledRef.current = true;
    void sendPrefill(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, gate.kind, mentions.kind]);

  /** The target Post settled on (kept for the outcome row and a retried status change). */
  const postTargetRef = useRef<ReplyTarget | null>(null);

  const resolving = mentions.kind === 'resolving';
  const allowed = editable && !resolving && canPost(draft, actionDone, text);
  const flags = useMemo(() => draft.flags.filter((f) => !(draft.outcome === 'no_new_angle' && f === 'no_new_angle')), [draft]);

  const onPost = async () => {
    if (mentions.kind !== 'done') return;
    setError(null);
    setNotice(null);
    let commentPosted = phase === 'comment-posted';
    // 'posting' holds until the transition settles, so Retry is never live mid-flight.
    setPhase('posting');
    if (!commentPosted) {
      // Never post a second reply: the user may have saved the pre-filled draft in Jira already.
      let existing: ExistingReply;
      try {
        existing = await checkExistingReplyLive(draft);
      } catch (e) {
        setPhase('idle');
        setError(`Couldn't check whether you already replied, so nothing was posted: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (existing.reply) {
        setPhase('idle');
        setGate({ kind: 'already-replied', existing });
        return;
      }
      // A comment that arrived since the card loaded changes who this replies under: show it,
      // and only post on a second click.
      const shown = targetRef.current.kind === 'ready' ? targetRef.current.target : null;
      const fresh = await resolveTarget(existing);
      const plan = planPost({ shown, fresh: fresh.target, confirmedId: confirmedTarget });
      setTarget({ kind: 'ready', ...fresh });
      if (plan.kind === 'targetChanged') {
        setConfirmedTarget(plan.target?.commentId ?? '');
        setPhase('idle');
        setNotice(plan.target
          ? `${plan.target.name} commented since this draft was written. Post again to reply to them.`
          : 'The comment this was replying to is gone. Post again to send it as a new comment.');
        return;
      }
      postTargetRef.current = plan.target;
    }
    try {
      if (!commentPosted) {
        const t = postTargetRef.current;
        const base = plainToSegments(text, mentions.segments);
        const postedSegments = t ? greetTarget(base, t) : base;
        const parentId = t ? replyParentId(t) : undefined;
        const posted = await postComment(ticket.id, postedSegments, { multiline: true, parentId });
        commentPosted = true;
        setNotice(parentId && posted.parentId == null
          ? "Posted, but Jira didn't thread it: it went in as a normal comment."
          : null);
        if (worthReviewing(segmentsToPlain(t ? greetTarget(draft.segments, t) : draft.segments), segmentsToPlain(postedSegments), t?.name ?? null)) {
          setEditedPost(segmentsToPlain(postedSegments));
        }
        void markPostedThisSession(ticket.id, draft.created_at);
        void requestClearPrefill(ticket.id, postedSegments);
      }
    } catch (e) {
      setPhase('idle');
      setError(`Couldn't post: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // A workflow may already have closed the ticket; being in the suggested status counts as done.
    const currentStatus = currentStatusName(ticket);
    let actualStatus: string = currentStatus;
    let transitionError: string | null = null;
    if (shouldTransition(draft.suggested_status, currentStatus)) {
      try {
        await transitionTicketByName(ticket.id, draft.suggested_status!);
        actualStatus = draft.suggested_status!;
      } catch (e) {
        transitionError = e instanceof Error ? e.message : String(e);
      }
    }

    // Record once, right after the comment lands, whether or not the status change worked.
    if (!recordedRef.current) {
      recordedRef.current = true;
      try {
        const assignedAt = await lookupAssignedAtLive(ticket.id);
        const t = postTargetRef.current;
        const sent = t ? segmentsToPlain(greetTarget(plainToSegments(text, mentions.segments), t)) : text;
        await recordOutcome(buildOutcomeRow(draft, sent, ticket, actualStatus, { assignedAt, replyTarget: t }));
      } catch (e) {
        console.warn('Could not record the draft outcome', e);
        setRecordFailed(true);
      }
    }

    if (transitionError) {
      setPhase('comment-posted');
      setError(`Comment posted, but the status change failed: ${transitionError}`);
      return;
    }
    setPhase('done');
    applyStatus(actualStatus);
  };

  const applyStatus = (actualStatus: string) => {
    const status = STATUSES.find((s) => s === actualStatus);
    if (status && status !== ticket.status && onTicketUpdate) {
      onTicketUpdate({ ...ticket, status, jiraStatus: { name: actualStatus, bucket: status } });
    }
  };

  // The user already replied in Jira: only change the status, never comment. The outcome is the
  // Jira reply compared with the draft (Jira-path row), recorded once.
  const onMarkOnly = async () => {
    if (gate.kind !== 'already-replied') return;
    const { existing } = gate;
    setError(null);
    setPhase('posting');
    // The card handles this draft now, so the close-in-Jira sweep must not add a second row.
    void markPostedThisSession(ticket.id, draft.created_at);
    const currentStatus = currentStatusName(ticket);
    let actualStatus: string = currentStatus;
    let transitionError: string | null = null;
    if (shouldTransition(draft.suggested_status, currentStatus)) {
      try {
        await transitionTicketByName(ticket.id, draft.suggested_status!);
        actualStatus = draft.suggested_status!;
      } catch (e) {
        transitionError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!recordedRef.current) {
      recordedRef.current = true;
      try {
        const assignedAt = await lookupAssignedAtLive(ticket.id);
        await recordOutcome(buildJiraOutcomeRow(draft, existing.comments, existing.me, actualStatus, assignedAt));
      } catch (e) {
        console.warn('Could not record the draft outcome', e);
        setRecordFailed(true);
      }
    }
    if (transitionError) {
      setPhase('idle');
      setError(`The status change failed: ${transitionError}`);
      return;
    }
    setPhase('done');
    applyStatus(actualStatus);
  };

  const header = draft.outcome === 'move' ? 'Move suggestion'
    : draft.outcome === 'no_new_angle' ? 'No new angle found'
    : draft.kind === 'followup' ? 'Sidekick Agent draft — follow-up' : 'Sidekick Agent draft';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{header}</div>
        {onSolveAgain && (
          <button
            type="button"
            style={{ ...secondaryButton, padding: '4px 8px', fontSize: 'var(--mint-text-nano)', flexShrink: 0 }}
            title="Have the Sidekick Agent redo this ticket, e.g. after a new message. Replaces this draft."
            onClick={onSolveAgain}
          >
            ↻ Solve again
          </button>
        )}
      </div>
      {draft.summary && <div style={mutedStyle}>{draft.summary}</div>}

      {draft.action_needed && (
        <div style={bannerStyle}>
          <div style={{ fontWeight: 700 }}>Action needed — you</div>
          <div style={{ marginTop: 2 }}>{draft.action_needed.summary}</div>
          {draft.action_needed.workflow && !VENDOR_WORKFLOW_LABEL[draft.action_needed.workflow] && (
            <div style={{ marginTop: 4, fontStyle: 'italic' }}>
              This workflow posts its own reply and closes the ticket — use this draft only if you do the action by hand.
            </div>
          )}
          {draft.action_needed.workflow && (
            <button type="button" style={{ ...secondaryButton, marginTop: 6 }}
              onClick={() => onOpenWorkflow(draft.action_needed!.workflow!, draft.action_needed!.vendor_draft)}>
              {VENDOR_WORKFLOW_LABEL[draft.action_needed.workflow] ?? 'Open workflow'}
            </button>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={actionDone} onChange={(e) => setActionDone(e.target.checked)} />
            <span>I've done this</span>
          </label>
        </div>
      )}

      {draft.outcome === 'move' && draft.move && (() => {
        const move = draft.move;
        const movePrefill = toMovePrefill(move);
        return (
          <div style={{ ...mutedStyle, marginTop: 8 }}>
            {movePrefill ? (
              <>
                <div><b>{move.destination}</b> — {move.issue_type}</div>
                <div style={{ marginTop: 4 }}>{move.reason}</div>
              </>
            ) : (
              <div>Move manually to <b>{move.destination}</b> ({move.issue_type}): {move.reason}</div>
            )}
            {move.comment?.trim() && <MoveComment text={move.comment} />}
            {movePrefill && onOpenMove && (
              <button type="button" style={{ ...primaryButton, marginTop: 'var(--mint-sp-2)' }}
                onClick={() => onOpenMove(movePrefill)}>
                Move to {move.destination}
              </button>
            )}
          </div>
        );
      })()}

      {editable && gate.kind === 'closed' && (
        <div style={{ ...mutedStyle, fontWeight: 600 }}>This ticket is {gate.status} — nothing to post.</div>
      )}

      {editable && gate.kind === 'unchecked' && (
        <div style={mutedStyle}>Couldn't check whether you already replied, so the draft wasn't filled into Jira's box. Use Insert draft if you still want it.</div>
      )}

      {editable && gate.kind === 'posted-earlier' && (
        <div style={{ ...mutedStyle, fontWeight: 600 }}>Posted earlier this session.</div>
      )}

      {editable && gate.kind === 'already-replied' && (() => {
        const status = draft.suggested_status;
        const canMark = !!status && shouldTransition(status, currentStatusName(ticket));
        const blocked = !!draft.action_needed && !actionDone;
        return (
          <>
            {phase === 'done' ? (
              <div style={{ ...mutedStyle, fontWeight: 600 }}>You already replied — marked {status}.</div>
            ) : canMark ? (
              <>
                <div style={{ ...mutedStyle, fontWeight: 600 }}>You already replied — mark {status} only?</div>
                <button
                  type="button"
                  disabled={blocked || phase === 'posting'}
                  onClick={() => void onMarkOnly()}
                  style={{ ...primaryButton, marginTop: 'var(--mint-sp-2)', opacity: blocked || phase === 'posting' ? 0.5 : 1 }}
                  title={blocked ? "Tick \"I've done this\" first" : undefined}
                >
                  {phase === 'posting' ? 'Marking…' : `Mark ${status}`}
                </button>
              </>
            ) : (
              <div style={{ ...mutedStyle, fontWeight: 600 }}>You already replied in Jira.</div>
            )}
            {error && <div style={{ ...errorBanner, marginTop: 'var(--mint-sp-2)' }}>{error}</div>}
            {recordFailed && <div style={warnStyle}>Couldn't log this outcome — the status change itself went through.</div>}
          </>
        );
      })()}

      {editable && (gate.kind === 'checking' || gate.kind === 'open' || gate.kind === 'unchecked') && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={phase !== 'idle'}
            rows={8}
            style={textareaStyle}
            aria-label="Draft reply"
          />
          {target.kind === 'ready' && (
            <div style={mutedStyle}>
              {target.target ? (
                <>Replying to <a href={`https://wealthsimple.atlassian.net/browse/${ticket.id}?focusedCommentId=${target.target.commentId}`} target="_blank" rel="noreferrer">{target.target.name || 'this person'}'s comment</a></>
              ) : 'New comment'}
            </div>
          )}
          {target.kind === 'ready' && target.teamMissing && (
            <div style={warnStyle}>Couldn't load your team list, so this posts as a new comment.</div>
          )}
          {notice && <div style={warnStyle}>{notice}</div>}
          {mentions.kind === 'done' && mentions.unresolved.map((m) => (
            <div key={m} style={warnStyle}>Couldn't resolve {m} — check before posting</div>
          ))}
          <div style={mutedStyle}>
            {draft.suggested_status ? `Suggested status: ${draft.suggested_status}` : 'No status change suggested'}
          </div>
          {resolving && phase === 'idle' && <div style={mutedStyle}>Resolving mentions…</div>}
          {phase === 'done' ? (
            <div style={{ ...mutedStyle, fontWeight: 600 }}>Posted{draft.suggested_status ? ` and marked ${draft.suggested_status}` : ''}.</div>
          ) : (
            <button
              type="button"
              disabled={!allowed || phase === 'posting'}
              onClick={() => void onPost()}
              style={{ ...primaryButton, marginTop: 'var(--mint-sp-2)', opacity: !allowed || phase === 'posting' ? 0.5 : 1 }}
              title={draft.action_needed && !actionDone ? "Tick \"I've done this\" first" : undefined}
            >
              {phase === 'posting' ? 'Posting…' : phase === 'comment-posted' ? 'Retry status change' : postLabel(draft)}
            </button>
          )}
          {editedPost !== null && (
            <LessonReview ticketKey={ticket.id} workType={ticket.workType} draft={segmentsToPlain(postTargetRef.current ? greetTarget(draft.segments, postTargetRef.current) : draft.segments)} posted={editedPost} evidence={draft.evidence} />
          )}
          {phase === 'idle' && prefill.kind === 'inserted' && !prefill.partial && (
            <div style={mutedStyle}>Draft inserted into the Jira comment box (not saved) — edit it there and click Save.</div>
          )}
          {phase === 'idle' && prefill.kind === 'inserted' && prefill.partial && (
            <div style={warnStyle}>Only part of the draft could be inserted; copy the rest from the card.</div>
          )}
          {phase !== 'idle' && (prefill.kind === 'inserted' || (prefill.kind === 'skipped' && prefill.reason === 'interrupted')) && (
            <div style={warnStyle}>The Jira comment box still holds the unsaved draft — discard it there so it isn't posted twice.</div>
          )}
          {phase === 'idle' && prefill.kind === 'sending' && <div style={mutedStyle}>Inserting draft into Jira…</div>}
          {phase === 'idle' && prefill.kind === 'skipped' && (
            <div style={mutedStyle}>
              {PREFILL_NOTES[prefill.reason]}
              {INSERT_FORCE[prefill.reason] !== undefined && (
                <button
                  type="button"
                  style={{ ...secondaryButton, marginLeft: 6 }}
                  onClick={() => void sendPrefill(INSERT_FORCE[prefill.reason]!)}
                >
                  Insert draft
                </button>
              )}
            </div>
          )}
          {error && <div style={{ ...errorBanner, marginTop: 'var(--mint-sp-2)' }}>{error}</div>}
          {recordFailed && <div style={warnStyle}>Couldn't log this outcome — the post itself went through.</div>}
        </>
      )}

      {flags.length > 0 && (
        <ul style={listStyle}>
          {flags.map((f) => <li key={f}>⚠ {flagLabel(f)}</li>)}
        </ul>
      )}

      {draft.evidence.length > 0 && (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <div style={{ ...mutedStyle, fontWeight: 600 }}>
            {draft.outcome === 'no_new_angle' ? 'What was checked' : 'Evidence'}
          </div>
          <ul style={listStyle}>
            {draft.evidence.map((e, i) => (
              <li key={i}>
                <b>{e.label}</b>
                {e.detail ? ` — ${e.detail}` : ''}
                {isHttpUrl(e.url) && <>{' '}<a href={e.url} target="_blank" rel="noreferrer" style={linkStyle}>open</a></>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isHttpUrl(draft.compass_thread) && (
        <a href={draft.compass_thread} target="_blank" rel="noreferrer" style={{ ...linkStyle, display: 'inline-block', marginTop: 6, fontSize: 'var(--mint-text-micro)' }}>
          Compass thread
        </a>
      )}
    </div>
  );
}

/** The comment the agent suggests posting with the move (the Move modal has no field for it). */
function MoveComment({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable; the text is selectable */ }
  };
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontWeight: 600 }}>Suggested move comment</div>
      <div style={{ ...bannerStyle, marginTop: 2, whiteSpace: 'pre-wrap', userSelect: 'text' }}>{text}</div>
      <button type="button" style={{ ...secondaryButton, marginTop: 4 }} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  marginTop: 'var(--mint-sp-3)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
  marginTop: 4,
};

const bannerStyle: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: '8px 12px',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-strong)',
};

const warnStyle: React.CSSProperties = {
  ...mutedStyle,
  color: 'var(--mint-negative-fg-strong)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 'var(--mint-sp-2)',
  padding: 8,
  fontSize: 'var(--mint-text-meta)',
  fontFamily: 'inherit',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  resize: 'vertical',
};

const listStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
  margin: '6px 0 0',
  paddingLeft: 18,
};

const linkStyle: React.CSSProperties = { color: 'var(--mint-fg-strong)' };
