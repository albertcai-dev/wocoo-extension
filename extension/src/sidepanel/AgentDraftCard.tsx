// Agent draft card: the local draft agent's reply for the open ticket, its evidence and flags,
// and a one-click "Post + mark Done". Renders nothing when the agent has no draft for the ticket.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import type { AgentDraft, DraftActionNeeded, DraftSegment } from '../data/agentDraftTypes';
import { DraftStoreUnavailable, getDraft, recordOutcome } from '../api/draftStore';
import { postComment, searchJiraUsers, transitionTicketByName } from '../api/jira';
import {
  applyMentionResolution, buildOutcomeRow, canPost, flagLabel, isHttpUrl, markPostedThisSession,
  plainToSegments, postLabel, segmentsToPlain, shouldTransition, unresolvedMentionNames, wasPostedThisSession,
  type MentionCandidate,
} from '../data/agentDraftView';
import {
  PREFILL_COMMENT_MESSAGE, type PrefillCommentMessage, type PrefillCommentReply,
} from '../data/commentPrefill';
import { errorBanner, primaryButton, secondaryButton } from './toolUi';

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
  | { kind: 'skipped'; reason: 'not-empty' | 'no-editor' | 'wrong-ticket' | 'interrupted' | 'unreachable' | 'error' };

const JIRA_TAB_URL = /^https:\/\/wealthsimple\.atlassian\.net\//;

/** Asks the Jira content script in the active tab to fill its comment box. null when there is no
 *  Jira tab in front or its content script can't be reached (e.g. the tab predates an extension reload). */
async function requestCommentPrefill(key: string, segments: DraftSegment[], force: boolean): Promise<PrefillCommentReply | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null || !tab.url || !JIRA_TAB_URL.test(tab.url)) return null;
    const msg: PrefillCommentMessage = { type: PREFILL_COMMENT_MESSAGE, key, segments, force };
    const reply = (await chrome.tabs.sendMessage(tab.id, msg)) as PrefillCommentReply | undefined;
    return reply ?? null;
  } catch {
    return null;
  }
}

const PREFILL_NOTES: Record<Extract<Prefill, { kind: 'skipped' }>['reason'], string> = {
  'not-empty': 'The Jira comment box already has text, so the draft was not inserted.',
  'no-editor': "Couldn't find the Jira comment box.",
  'wrong-ticket': 'The Jira tab is showing a different ticket.',
  interrupted: 'Inserting stopped because the Jira comment box lost focus or the page changed — check what landed there; copy the rest from the card.',
  unreachable: "Couldn't reach the Jira tab — reload it to insert the draft.",
  error: "The Jira tab couldn't insert the draft (another insert was still running, or it hit an error) — try again.",
};

/** Which skipped states offer the Insert draft button, and with what force. */
const INSERT_FORCE: Partial<Record<Extract<Prefill, { kind: 'skipped' }>['reason'], boolean>> = {
  'not-empty': true,
  'no-editor': false,
  unreachable: false,
  error: false,
};

const STATUSES: ReadonlyArray<WocooTicket['status']> = ['Triage', 'Back Office', 'Pending', 'Done', 'Cancelled', 'Other'];

export function AgentDraftCard({ ticket, onOpenWorkflow, onTicketUpdate }: {
  ticket: WocooTicket;
  onOpenWorkflow: (workflow: NonNullable<DraftActionNeeded['workflow']>) => void;
  onTicketUpdate?: (t: WocooTicket) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    getDraft(ticket.id).then(
      (draft) => { if (!cancelled) setLoad(draft ? { kind: 'ready', draft } : { kind: 'none' }); },
      (e) => { if (!cancelled) setLoad(e instanceof DraftStoreUnavailable ? { kind: 'unavailable' } : { kind: 'none' }); },
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
    />
  );
}

function DraftBody({ ticket, draft, onOpenWorkflow, onTicketUpdate }: {
  ticket: WocooTicket;
  draft: AgentDraft;
  onOpenWorkflow: (workflow: NonNullable<DraftActionNeeded['workflow']>) => void;
  onTicketUpdate?: (t: WocooTicket) => void;
}) {
  const editable = draft.outcome === 'draft' || draft.outcome === 'needs_info';
  const [text, setText] = useState(() => segmentsToPlain(draft.segments));
  const [actionDone, setActionDone] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [mentions, setMentions] = useState<Mentions>({ kind: 'resolving' });
  const [recordFailed, setRecordFailed] = useState(false);
  const recordedRef = useRef(false);
  const [prefill, setPrefill] = useState<Prefill>({ kind: 'idle' });
  const autoPrefilledRef = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  // A draft already posted from this card this session is never offered again.
  // Read once on mount: during this card's own post it flips true before the transition settles.
  const [postedEarlier] = useState(() => wasPostedThisSession(ticket.id, draft.created_at));

  // Resolve @Name mentions to Jira accounts as the card loads, so any problem shows before posting.
  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    const names = unresolvedMentionNames(draft.segments);
    (async () => {
      const results: Record<string, MentionCandidate[]> = {};
      await Promise.all(names.map(async (name) => {
        try { results[name] = await searchJiraUsers(name); } catch { /* leave unresolved */ }
      }));
      if (cancelled) return;
      const r = applyMentionResolution(draft.segments, results);
      setMentions({ kind: 'done', segments: r.segments, unresolved: r.unresolved });
    })();
    return () => { cancelled = true; };
  }, [draft, editable]);

  // Pre-fill the Jira comment box with the (mention-resolved, possibly edited) draft. Never saves.
  const sendPrefill = async (force: boolean) => {
    if (mentions.kind !== 'done') return;
    const segments = plainToSegments(textRef.current, mentions.segments);
    if (!segmentsToPlain(segments).trim()) return;
    setPrefill({ kind: 'sending' });
    const reply = await requestCommentPrefill(ticket.id, segments, force);
    if (!reply) { setPrefill({ kind: 'skipped', reason: 'unreachable' }); return; }
    if (!reply.ok) { setPrefill({ kind: 'skipped', reason: 'error' }); return; }
    if (reply.inserted) { setPrefill({ kind: 'inserted', partial: reply.reason === 'partial' }); return; }
    // inserted:false with no reason = nothing to insert; leave the controls alone.
    setPrefill(reply.reason ? { kind: 'skipped', reason: reply.reason } : { kind: 'idle' });
  };

  // Once per ticket open (this card mounts per ticket + draft), as soon as mentions are resolved.
  useEffect(() => {
    if (!editable || postedEarlier || mentions.kind !== 'done' || autoPrefilledRef.current) return;
    autoPrefilledRef.current = true;
    void sendPrefill(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, postedEarlier, mentions.kind]);

  const resolving = mentions.kind === 'resolving';
  const allowed = editable && !resolving && canPost(draft, actionDone, text);
  const flags = useMemo(() => draft.flags.filter((f) => !(draft.outcome === 'no_new_angle' && f === 'no_new_angle')), [draft]);

  const onPost = async () => {
    if (mentions.kind !== 'done') return;
    setError(null);
    let commentPosted = phase === 'comment-posted';
    // 'posting' holds until the transition settles, so Retry is never live mid-flight.
    setPhase('posting');
    try {
      if (!commentPosted) {
        await postComment(ticket.id, plainToSegments(text, mentions.segments));
        commentPosted = true;
        markPostedThisSession(ticket.id, draft.created_at);
      }
    } catch (e) {
      setPhase('idle');
      setError(`Couldn't post: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // A workflow may already have closed the ticket; being in the suggested status counts as done.
    let actualStatus: string = ticket.status;
    let transitionError: string | null = null;
    if (shouldTransition(draft.suggested_status, ticket.status)) {
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
        await recordOutcome(buildOutcomeRow(draft, text, ticket, actualStatus));
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
    const status = STATUSES.find((s) => s === actualStatus);
    if (status && status !== ticket.status && onTicketUpdate) onTicketUpdate({ ...ticket, status });
  };

  const header = draft.outcome === 'move' ? 'Move suggestion'
    : draft.outcome === 'no_new_angle' ? 'No new angle found'
    : draft.kind === 'followup' ? 'Agent draft — follow-up' : 'Agent draft';

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{header}</div>
      {draft.summary && <div style={mutedStyle}>{draft.summary}</div>}

      {draft.action_needed && (
        <div style={bannerStyle}>
          <div style={{ fontWeight: 700 }}>Action needed — you</div>
          <div style={{ marginTop: 2 }}>{draft.action_needed.summary}</div>
          {draft.action_needed.workflow && (
            <div style={{ marginTop: 4, fontStyle: 'italic' }}>
              This workflow posts its own reply and closes the ticket — use this draft only if you do the action by hand.
            </div>
          )}
          {draft.action_needed.workflow && (
            <button type="button" style={{ ...secondaryButton, marginTop: 6 }}
              onClick={() => onOpenWorkflow(draft.action_needed!.workflow!)}>
              Open workflow
            </button>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={actionDone} onChange={(e) => setActionDone(e.target.checked)} />
            <span>I've done this</span>
          </label>
        </div>
      )}

      {draft.outcome === 'move' && draft.move && (
        <div style={{ ...mutedStyle, marginTop: 8 }}>
          <div><b>{draft.move.destination}</b> — {draft.move.issue_type}</div>
          <div style={{ marginTop: 4 }}>{draft.move.reason}</div>
        </div>
      )}

      {editable && postedEarlier && (
        <div style={{ ...mutedStyle, fontWeight: 600 }}>Posted earlier this session.</div>
      )}

      {editable && !postedEarlier && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={phase !== 'idle'}
            rows={8}
            style={textareaStyle}
            aria-label="Draft reply"
          />
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
