// Ticket-in-Context Side Panel — Phase B-1.
//
// Flow:
//   - On mount, check auth tokens. If none → show AuthGate.
//   - When signed in, subscribe to chrome.storage.session for the current WOCOO ticket key
//     (broadcast by the content script + service worker as the agent navigates Jira tabs).
//   - When key changes: fetch the ticket via jira.ts and render.
//   - States: signed-out / no-tab-detected / loading / error / loaded.

import { useEffect, useState } from 'react';
import { MOCK_TICKET, type WocooTicket } from '../data/mockTicket';
import { StatusBadge, PriorityIndicator, TierBadge } from '../components/StatusBadge';
import { TranscriptCard } from '../components/TranscriptCard';
import { getStoredTokens, clearTokens } from '../auth/oauth';
import { getTicket, transitionTicket } from '../api/jira';
import { useCurrentTicketKey } from './useCurrentTicket';
import { AuthGate } from './AuthGate';
import { MoveModal } from './MoveModal';
import { CreateReimbModal } from './CreateReimbModal';
import { WalletTriageWorkflow } from './WalletTriageWorkflow';
import { WalletTriageCard } from './WalletTriageCard';
import { OverpaymentTriageCard } from './OverpaymentTriageCard';
import { ReverseFeeCard } from './ReverseFeeCard';
import { QCFeeWaiverCard } from './QCFeeWaiverCard';
import { RetentionFeeWaiverCard } from './RetentionFeeWaiverCard';
import { VisaCompanionCard } from './VisaCompanionCard';
import type { MoveDestination } from '../data/moveConfig';
import { CredRouteCard } from './CredRouteCard';
import { AITriageCard } from './AITriageCard';
import { OverpaymentTriage } from './OverpaymentTriage';
import { ReverseFeeWorkflow } from './ReverseFeeWorkflow';
import { QCFeeWaiverWorkflow } from './QCFeeWaiverWorkflow';
import { RetentionFeeWaiverWorkflow } from './RetentionFeeWaiverWorkflow';
import { VisaCompanionRpinWorkflow } from './VisaCompanionRpinWorkflow';
import { QCAutoReimbCard } from './QCAutoReimbCard';
import { L3EscalationCard } from './L3EscalationCard';
import { InterestInvestigationCard } from './InterestInvestigationCard';
import { RefundAuthLetterWorkflow } from './RefundAuthLetterWorkflow';
import { useInterestTool } from './useInterestTool';
import { detectL3Escalation } from '../data/l3EscalationDetect';
import { detectInterestInvestigation } from '../data/interestInvestigationDetect';
import { HomeView } from './HomeView';
import { WiresPendingPosting } from './WiresPendingPosting';
import { WiresPendingPostingV2 } from './WiresPendingPostingV2';
import { SettingsView } from './SettingsView';
import { I2cCard, KohoCard } from './MessagingCards';
import { fetchAtlasAccountIdHeadless } from '../data/atlasAccountLookup';
import { isInterestRelatedWorkType, isInterestFeeInContent } from '../data/reverseFeeDetect';
import { subscribeToTicketTransitions, emitTicketTransition, type TicketTransitionEvent } from './ticketLogEvents';
import { logTicketViaBridge, acknowledgeReplyViaBridge, findI2cThreadViaBridge, i2cThreadUrl, type TicketReply } from '../api/bridge';
import { NotePrompt } from './NotePrompt';
import type { TicketTransitionKind } from '../data/ticketLogTypes';
import { clearPresetIdentityMirror, mirrorPresetIdentity, stagePresetIdentity } from '../data/presetIdentity';

// Bridge: DOM-observer transition detections come in as chrome.runtime messages from
// the service worker. Feed them into the local event bus so a single subscribe path
// handles both sidepanel-originating and DOM-originating transitions.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'wocoo:transition-detected') {
      const statusName: string = String(msg.statusName || '');
      const kind: TicketTransitionKind = statusName === 'Cancelled' || statusName === 'Canceled' ? 'Cancelled' : 'Done';
      emitTicketTransition({
        ticketId: String(msg.ticketId),
        kind,
        source: 'dom',
      });
    }
  });
}

const ATLAS_URL = (id: string, ticketId: string) =>
  `https://atlas.wealthsimple.com/identity/${id}/overview/?ticketId=${ticketId}`;

type AuthState = 'checking' | 'signed-out' | 'signed-in';

export function SidePanel() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [ticketKey, setTicketKey] = useCurrentTicketKey();
  const [homeMode, setHomeMode] = useState(false);
  const [settingsMode, setSettingsMode] = useState(false);
  const [wiresPendingActive, setWiresPendingActive] = useState(false);
  const [wiresPendingV2Active, setWiresPendingV2Active] = useState(false);
  const [ticket, setTicket] = useState<WocooTicket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picking a ticket from the Home view: synchronously update ticketKey (so the panel
  // doesn't flash Home for a frame waiting on the storage event), then exit home mode.
  // setTicketKey also writes through to chrome.storage.session so the service worker +
  // any other panel surfaces stay in sync.
  const onOpenTicket = (key: string) => {
    setTicketKey(key);
    setHomeMode(false);
    setSettingsMode(false);
  };
  const onGoHome = () => { setSettingsMode(false); setHomeMode(true); };
  const onOpenSettings = () => setSettingsMode(true);
  const onCloseSettings = () => setSettingsMode(false);

  // Check auth on mount
  useEffect(() => {
    getStoredTokens().then((t) => setAuthState(t ? 'signed-in' : 'signed-out'));
  }, []);

  // Fetch the ticket whenever the current key changes (and we're signed in)
  useEffect(() => {
    if (authState !== 'signed-in') return;
    if (!ticketKey) { setTicket(null); setError(null); return; }
    setLoading(true);
    setError(null);
    let cancelled = false;
    getTicket(ticketKey)
      .then((t) => { if (!cancelled) setTicket(t); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authState, ticketKey]);

  // Mirror the open ticket's identity for the Preset content script. A Preset page the
  // user opens by hand (rather than through a workflow button) has no staged identity of
  // its own, and before this it fell back to whatever identity was last left in storage —
  // i.e. an unrelated client's. Publishing the current ticket here makes a hand-opened
  // dashboard filter to the ticket sitting in the panel.
  useEffect(() => {
    if (ticket?.identityId) {
      void mirrorPresetIdentity(ticket.identityId, ticket.id);
    } else {
      // No identity to publish — including while a newly picked ticket is still
      // loading. Drop the mirror rather than leave the previous ticket's identity
      // standing in for it.
      void clearPresetIdentityMirror();
    }
  }, [ticket?.identityId, ticket?.id, ticketKey]);

  // Auto-exit modal views (Home / Settings / WiresPendingPosting) when a new ticket key
  // arrives — e.g. the user is on Home and clicks a card in the Jira board, which
  // publishes the ticket key via chrome.storage.session. Without this, the panel stays
  // parked on Home and the user has no signal that the click registered.
  useEffect(() => {
    if (!ticketKey) return;
    setHomeMode(false);
    setSettingsMode(false);
    setWiresPendingActive(false);
    setWiresPendingV2Active(false);
  }, [ticketKey]);

  if (authState === 'checking') return <CenteredText>Checking sign-in…</CenteredText>;
  if (authState === 'signed-out') return <AuthGate onSignedIn={() => setAuthState('signed-in')} />;

  const handleSignOut = async () => { await clearTokens(); setAuthState('signed-out'); };

  if (settingsMode) {
    return <SettingsView onBack={onCloseSettings} onSignOut={handleSignOut} />;
  }

  if (wiresPendingActive) {
    return <WiresPendingPosting onClose={() => setWiresPendingActive(false)} />;
  }

  if (wiresPendingV2Active) {
    return <WiresPendingPostingV2 onClose={() => setWiresPendingV2Active(false)} />;
  }

  if (homeMode) {
    return (
      <HomeView
        onOpenTicket={onOpenTicket}
        onOpenWiresPending={() => setWiresPendingActive(true)}
        onOpenWiresPendingV2={() => setWiresPendingV2Active(true)}
        header={<HomeHeader onOpenSettings={onOpenSettings} />}
      />
    );
  }

  // Signed in but no Jira tab open and not in home — drop into home as a sensible default.
  if (!ticketKey) {
    return (
      <HomeView
        onOpenTicket={onOpenTicket}
        onOpenWiresPending={() => setWiresPendingActive(true)}
        onOpenWiresPendingV2={() => setWiresPendingV2Active(true)}
        header={<HomeHeader onOpenSettings={onOpenSettings} />}
      />
    );
  }

  if (loading) return <CenteredText>Loading {ticketKey}…</CenteredText>;
  if (error) return <ErrorState message={error} ticketKey={ticketKey} onRetry={() => setTicket(null)} />;
  if (!ticket) return <CenteredText>No ticket loaded.</CenteredText>;

  return (
    <TicketView
      ticket={ticket}
      onTicketUpdate={(updated) => setTicket(updated)}
      onGoHome={onGoHome}
      onOpenSettings={onOpenSettings}
    />
  );
}

function HomeHeader({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--mint-sp-2)' }}>
      <SettingsButton onClick={onOpenSettings} />
    </header>
  );
}

function TicketView({ ticket, onTicketUpdate, onGoHome, onOpenSettings }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onGoHome: () => void; onOpenSettings: () => void }) {
  const [triageActive, setTriageActive] = useState(false);
  const [reverseFeeActive, setReverseFeeActive] = useState(false);
  const [walletTriageActive, setWalletTriageActive] = useState(false);
  const [qcFeeWaiverActive, setQCFeeWaiverActive] = useState(false);
  const [retentionFeeWaiverActive, setRetentionFeeWaiverActive] = useState(false);
  const [visaCompanionRpinActive, setVisaCompanionRpinActive] = useState(false);
  const [refundAuthLetterActive, setRefundAuthLetterActive] = useState(false);
  if (refundAuthLetterActive) {
    return (
      <RefundAuthLetterWorkflow
        ticket={ticket}
        onClose={() => setRefundAuthLetterActive(false)}
      />
    );
  }
  if (triageActive) {
    return (
      <OverpaymentTriage
        ticket={ticket}
        onClose={() => setTriageActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
  if (reverseFeeActive) {
    return (
      <ReverseFeeWorkflow
        ticket={ticket}
        onClose={() => setReverseFeeActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
  if (qcFeeWaiverActive) {
    return (
      <QCFeeWaiverWorkflow
        ticket={ticket}
        onClose={() => setQCFeeWaiverActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
  if (retentionFeeWaiverActive) {
    return (
      <RetentionFeeWaiverWorkflow
        ticket={ticket}
        onClose={() => setRetentionFeeWaiverActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
  if (visaCompanionRpinActive) {
    return (
      <VisaCompanionRpinWorkflow
        ticket={ticket}
        onClose={() => setVisaCompanionRpinActive(false)}
      />
    );
  }
  if (walletTriageActive) {
    return (
      <WalletTriageWorkflow
        ticket={ticket}
        onClose={() => setWalletTriageActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
  return (
    <TicketViewInner
      ticket={ticket}
      onTicketUpdate={onTicketUpdate}
      onStartTriage={() => setTriageActive(true)}
      onStartReverseFee={() => setReverseFeeActive(true)}
      onStartQCFeeWaiver={() => setQCFeeWaiverActive(true)}
      onStartWalletTriage={() => setWalletTriageActive(true)}
      onStartRetentionFeeWaiver={() => setRetentionFeeWaiverActive(true)}
      onStartVisaCompanionRpin={() => setVisaCompanionRpinActive(true)}
      onStartRefundAuthLetter={() => setRefundAuthLetterActive(true)}
      onGoHome={onGoHome}
      onOpenSettings={onOpenSettings}
    />
  );
}

function TicketViewInner({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onStartWalletTriage, onStartRetentionFeeWaiver, onStartVisaCompanionRpin, onStartRefundAuthLetter, onGoHome, onOpenSettings }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onStartWalletTriage: () => void; onStartRetentionFeeWaiver: () => void; onStartVisaCompanionRpin: () => void; onStartRefundAuthLetter: () => void; onGoHome: () => void; onOpenSettings: () => void }) {
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [showComments, setShowComments] = useState(false);
  // Lifted from QuickActions so other surfaces (e.g. CredRouteCard recommendation banner)
  // can open the Clone/Move modal with a specific destination preselected.
  const [moveOpen, setMoveOpen] = useState(false);
  const [createReimbActive, setCreateReimbActive] = useState(false);
  const [moveInitialDest, setMoveInitialDest] = useState<MoveDestination>('EOC');
  const openCloneMove = (initialDestKey: MoveDestination = 'EOC') => {
    setMoveInitialDest(initialDestKey);
    setMoveOpen(true);
  };

  const description = ticket.description;
  const descShort = description.length > 220 && !showFullDescription
    ? description.slice(0, 220) + '…'
    : description;

  // When the ticket routes to L3, that card owns the ticket — hide the in-panel
  // fee-handling cards it supersedes so there's only one recommended action.
  const l3Matched = detectL3Escalation(ticket.summary || '', ticket.description || '', ticket.workType, ticket.attachmentCount || 0).matched;
  // Same idea for interest investigations: "find out why this was charged" and "start a
  // fee waiver" are contradictory recommendations, and Reverse Fee stays available as a
  // quick action if the investigation concludes the charge was wrong.
  const interestInvestigationMatched = detectInterestInvestigation(ticket.summary || '', ticket.description || '', ticket.workType).matched;

  // Phase 1 Ticket Log: track the most recent transition event and the row_number
  // returned from logTicketViaBridge, so NotePrompt can update it. `unsavedChips`
  // holds dismissed prompts the user can restore for up to 5 minutes.
  interface ActivePrompt {
    ticketId: string;
    kind: TicketTransitionKind;
    rowNumber: number;
    movedToBoard?: string;
    createdAtMs: number;
  }
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
  const [unsavedChips, setUnsavedChips] = useState<ActivePrompt[]>([]);

  useEffect(() => {
    const unsub = subscribeToTicketTransitions(async (evt: TicketTransitionEvent) => {
      // Best-effort description snippet + workType from the currently loaded ticket.
      // If the sidepanel is between tickets we still log with blanks — the transition
      // is authoritative.
      const t = ticket && ticket.id === evt.ticketId ? ticket : null;
      try {
        const { rowNumber } = await logTicketViaBridge({
          ticketId: evt.ticketId,
          ticketLink: 'https://wealthsimple.atlassian.net/browse/' + evt.ticketId,
          summary: t?.summary || '',
          descriptionSnippet: (t?.description || '').slice(0, 500),
          originalWorkType: t?.workType || '',
          finalWorkType: '', // Phase 1: blank; Phase 2 can reconcile with post-transition ticket refetch
          transition: evt.kind,
          movedToBoard: evt.movedToBoard || '',
          timeOnTicketMinutes: 0, // Phase 1: not tracked; Phase 2 wires this via panel-open timestamps
        });
        setActivePrompt((prev) => {
          // If a prior prompt is still open, park it in the unsaved-chips queue so it
          // isn't silently dropped when a new transition arrives on a different ticket.
          if (prev) setUnsavedChips((cs) => [...cs, prev]);
          return {
            ticketId: evt.ticketId,
            kind: evt.kind,
            rowNumber,
            movedToBoard: evt.movedToBoard,
            createdAtMs: Date.now(),
          };
        });
      } catch (e) {
        console.error('[SidePanel] logTicketViaBridge failed:', e);
      }
    });
    return unsub;
  }, [ticket]);

  // Age out unsaved chips beyond 5 minutes.
  useEffect(() => {
    if (unsavedChips.length === 0) return;
    const now = Date.now();
    const kept = unsavedChips.filter((c) => now - c.createdAtMs < 5 * 60_000);
    if (kept.length !== unsavedChips.length) { setUnsavedChips(kept); return; }
    const nextExpiryAt = Math.min(...kept.map((c) => c.createdAtMs + 5 * 60_000));
    const timer = window.setTimeout(
      () => setUnsavedChips((cs) => cs.filter((c) => Date.now() - c.createdAtMs < 5 * 60_000)),
      Math.max(1000, nextExpiryAt - now),
    );
    return () => window.clearTimeout(timer);
  }, [unsavedChips]);

  return (
    <div style={{ minWidth: 280, padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
      {/* HEADER */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--mint-sp-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)', flexWrap: 'wrap' }}>
          <a
            href={`https://wealthsimple.atlassian.net/browse/${ticket.id}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 600, fontSize: 'var(--mint-text-h-sm)', textDecoration: 'none' }}
          >
            {ticket.id}
          </a>
          <StatusBadge status={ticket.status} />
          <PriorityIndicator priority={ticket.priority} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={onGoHome}
            title="Home"
            aria-label="Home"
            style={{
              width: 32, height: 32, borderRadius: 8,
              border: 'var(--mint-card-stroke)',
              background: 'var(--mint-bg-card)',
              color: 'var(--mint-fg-subdued-title)',
              cursor: 'pointer',
              fontSize: 14,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            🏠
          </button>
          <SettingsButton onClick={onOpenSettings} />
        </div>
      </header>

      {/* TITLE + TIER */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--mint-sp-2)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 600, lineHeight: 1.35, color: 'var(--mint-fg-strong)', flex: 1, minWidth: 0 }}>
          {ticket.summary}
        </h1>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <TierBadge tier={ticket.tier} />
        </div>
      </div>

      {/* META ROW */}
      <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>
        Assignee: <strong style={{ color: 'var(--mint-fg-subdued-title)', fontWeight: 600 }}>{ticket.assignee}</strong>
        {' · '}
        Reporter: <strong style={{ color: 'var(--mint-fg-subdued-title)', fontWeight: 600 }}>{ticket.reporter}</strong>
        {' · '}
        Created: <strong style={{ color: 'var(--mint-fg-subdued-title)', fontWeight: 600 }}>{new Date(ticket.created).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}</strong>
      </div>

      {/* IDENTITY + ACCOUNT BLOCK
          Order: Identity ID → Client Email → Account ID.
          Account ID row is hidden entirely when there's no value (reduces visual noise
          for the common case of tickets without an account number filled in). */}
      <section style={cardStyle()} aria-label="Client identifiers">
        <FieldRow label="Identity ID" value={ticket.identityId || '—'} mono />
        <FieldRow label="Client Email" value={ticket.clientEmail || '—'} mono />
        {ticket.accountId ? (
          <FieldRow label="Account ID" value={ticket.accountId} mono />
        ) : null}
      </section>

      {/* REPLY PILL — shown when the current ticket has an unacknowledged Koho/i2c reply. */}
      <ReplyPill ticketId={ticket.id} clientEmail={ticket.clientEmail} i2cTicketRef={ticket.i2cTicketRef} />

      {/* EXTERNAL TOOLS ROW — Atlas always, then i2c (Credit Card) or Koho (Prepaid Card) */}
      <ExternalToolsRow ticket={ticket} />

      {/* UNSAVED NOTE-PROMPT CHIPS — dismissed prompts recoverable for 5 min */}
      {unsavedChips.length > 0 ? (
        <section style={{ padding: '4px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {unsavedChips.map((c) => (
            <button
              key={c.ticketId + '::' + c.createdAtMs}
              onClick={() => {
                setActivePrompt(c);
                setUnsavedChips((cs) => cs.filter((x) => x !== c));
              }}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 12,
                border: '1px solid var(--mint-border, #d0d5dd)',
                background: '#fff8ea',
                cursor: 'pointer',
              }}
              title="Reopen the note prompt for this ticket (kept for 5 min)"
            >
              unsaved: {c.ticketId} → {c.kind}
            </button>
          ))}
        </section>
      ) : null}

      {/* DESCRIPTION */}
      <section style={cardStyle()}>
        <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', marginBottom: 'var(--mint-sp-1)', fontWeight: 700 }}>Description</div>
        <p style={{ margin: 0, fontSize: 'var(--mint-text-meta)', lineHeight: 1.6, color: 'var(--mint-fg-strong)', whiteSpace: 'pre-wrap' }}>
          {descShort}
        </p>
        {description.length > 220 ? (
          <button
            onClick={() => setShowFullDescription((v) => !v)}
            style={{ marginTop: 'var(--mint-sp-2)', background: 'none', border: 'none', padding: 0, color: 'var(--mint-highlight-fg-strong)', fontWeight: 600, fontSize: 'var(--mint-text-micro)' }}
          >
            {showFullDescription ? 'Show less' : 'Show more'}
          </button>
        ) : null}
      </section>

      {/* NOTE PROMPT — appears after a Jira transition; non-modal, dismissible */}
      {activePrompt ? (
        <NotePrompt
          ticketId={activePrompt.ticketId}
          kind={activePrompt.kind}
          rowNumber={activePrompt.rowNumber}
          onSaved={() => setActivePrompt(null)}
          onSkipped={() => setActivePrompt(null)}
          onDismissed={() => {
            setUnsavedChips((cs) => [...cs, activePrompt]);
            setActivePrompt(null);
          }}
        />
      ) : null}

      {/* INTEREST INVESTIGATION DETECTION — "why was I charged interest?" → validation tool */}
      <InterestInvestigationCard ticket={ticket} />

      {/* L3 ESCALATION DETECTION — Reverse Fee / Code 450 / joint account / DD timing */}
      <L3EscalationCard ticket={ticket} onTicketUpdate={onTicketUpdate} />

      {/* QC AUTO-REIMB DETECTION — shows when ticket looks like a newly-eligible QC client */}
      {l3Matched ? null : <QCAutoReimbCard ticket={ticket} onTicketUpdate={onTicketUpdate} />}

      {/* OVERPAYMENT TRIAGE DETECTION — credit card overpayment refund flow */}
      <OverpaymentTriageCard ticket={ticket} onStart={onStartTriage} />

      {/* REVERSE FEE DETECTION — fee reversal request (FX/ATM/foreign transaction) */}
      {l3Matched || interestInvestigationMatched ? null : <ReverseFeeCard ticket={ticket} onStart={onStartReverseFee} />}

      {/* QC FEE WAIVER DETECTION — Quebec client needs MANUAL annual-fee waiver */}
      {l3Matched ? null : <QCFeeWaiverCard ticket={ticket} onStart={onStartQCFeeWaiver} />}

      {/* RETENTION FEE WAIVER DETECTION — non-QC "waive CC fee for N months" retention ask */}
      <RetentionFeeWaiverCard ticket={ticket} onStart={onStartRetentionFeeWaiver} />

      {/* CRED ROUTE DETECTION — shows when ticket looks like a credit-decisioning task */}
      <CredRouteCard ticket={ticket} onOpenCloneMove={() => openCloneMove('CRED')} />

      {/* WALLET PROVISIONING DETECTION — shows when ticket looks like a wallet-add issue */}
      <WalletTriageCard ticket={ticket} onStart={onStartWalletTriage} />

      {/* VISA COMPANION — one-click canned reply + Move to Done */}
      <VisaCompanionCard ticket={ticket} onTicketUpdate={onTicketUpdate} />

      {/* QUICK ACTIONS */}
      <QuickActions
        ticket={ticket}
        onTicketUpdate={onTicketUpdate}
        onStartTriage={onStartTriage}
        onStartReverseFee={onStartReverseFee}
        onStartQCFeeWaiver={onStartQCFeeWaiver}
        onStartWalletTriage={onStartWalletTriage}
        onStartRetentionFeeWaiver={onStartRetentionFeeWaiver}
        onStartVisaCompanionRpin={onStartVisaCompanionRpin}
        onStartRefundAuthLetter={onStartRefundAuthLetter}
        onOpenCloneMove={openCloneMove}
        onOpenCreateReimb={() => setCreateReimbActive(true)}
      />
      {moveOpen ? (
        <MoveModal
          ticket={ticket}
          initialDestKey={moveInitialDest}
          onClose={() => { setMoveOpen(false); void onTicketUpdate; }}
        />
      ) : null}
      {createReimbActive ? (
        <CreateReimbModal
          ticket={ticket}
          onClose={() => setCreateReimbActive(false)}
        />
      ) : null}

      {/* AI VERDICT — grounded in the ticket log + Notion playbook */}
      <AITriageCard ticket={ticket} onOpenSettings={onOpenSettings} />

      {/* RECENT COMMENTS (collapsed) */}
      {ticket.recentComments.length > 0 ? (
        <>
          <button
            onClick={() => setShowComments((v) => !v)}
            style={{ ...cardStyle(), textAlign: 'left', background: 'var(--mint-bg-card)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', fontWeight: 600 }}>
              {showComments ? '▼' : '▶'} {ticket.recentComments.length === 1 ? 'View 1 comment' : `View ${ticket.recentComments.length} comments`}
            </span>
          </button>
          {showComments && (
            <section style={cardStyle()}>
              {ticket.recentComments.map((c, i) => (
                <div key={i} style={{ marginBottom: i < ticket.recentComments.length - 1 ? 'var(--mint-sp-3)' : 0 }}>
                  <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', marginBottom: 'var(--mint-sp-1)' }}>
                    <strong style={{ color: 'var(--mint-fg-subdued-title)', fontWeight: 600 }}>{c.author}</strong>
                    {' · '}{new Date(c.timestamp).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 'var(--mint-text-meta)', lineHeight: 1.5, color: 'var(--mint-fg-strong)', wordBreak: 'break-word' }}>{c.body}</div>
                </div>
              ))}
            </section>
          )}
        </>
      ) : null}

      {/* MESSAGING CARDS — copy-paste i2c template (Credit Card) or send Koho email
          (Prepaid Card or Cash — WS Cash is on Koho's platform too). */}
      {/eligibility\s*confirmation/i.test(ticket.workType || '') ? null : (() => {
        const wt = (ticket.workType || '').toLowerCase();
        if (wt.includes('credit card')) return <I2cCard ticket={ticket} />;
        if (wt.includes('prepaid card') || wt.includes('cash')) return <KohoCard ticket={ticket} />;
        return null;
      })()}

      {/* TRANSCRIPT PARSER */}
      <TranscriptCard />

      {/* FOOTER */}
      <footer style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-inactive)', textAlign: 'center', marginTop: 'var(--mint-sp-2)' }}>
        WOCOO Triager · v0.1 · live data
      </footer>
    </div>
  );
}

// ---------- external tools row (Atlas + i2c/Koho) ----------

const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';
const KOHO_ADMIN_URL = 'https://admin.koho.ca/';
// Bare dashboard URLs — the `native_filters_key=...` param restores a saved filter
// state with prior identities, which the content script can't reliably clear (they
// render as a "+ N ..." overflow chip, not as individual chips). Loading the
// dashboard cold gives a clean slate for the content script to type into.
const VERIFY_ELIGIBLE_DD_URLS = [
  'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/7320/',
  'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/8324/',
];

function ExternalToolsRow({ ticket }: { ticket: WocooTicket }) {
  const workType = (ticket.workType || '').toLowerCase();
  const isCreditCard = workType.includes('credit card');
  // Prepaid Card and Cash both route to Koho — WS Cash is on Koho's platform, so
  // Cash: Other / Cash: * tickets need the same ↗ Koho lookup as Prepaid Card.
  const isPrepaidOrCash = workType.includes('prepaid card') || workType.includes('cash');
  // Interest-Related Issues tickets are credit-card inquiries too — surface the i2c
  // button so the agent can look up the account's interest charges.
  const isInterestIssue = workType.includes('interest');

  const openAtlas = () => {
    if (!ticket.identityId) return;
    window.open(ATLAS_URL(ticket.identityId, ticket.id), '_blank', 'noopener,noreferrer');
  };

  const openI2c = () => {
    if (ticket.clientEmail) {
      void chrome.storage.local.set({
        pending_i2c_email: ticket.clientEmail,
        pending_i2c_started_at: Date.now(),
      });
      // Generic i2c click — no flow flag, no extra context. Explicitly clear any
      // leftover flow keys so the chain stops at "Continue with this Customer" instead
      // of barging into Account Transactions / Administrative Services / etc.
      void chrome.storage.local.remove([
        'pending_i2c_flow',
        'pending_i2c_source_ticket_id',
        'pending_i2c_ticket_url',
        'pending_i2c_admin_debit_amount',
      ]);
    }
    window.open(I2C_LOGIN_URL, '_blank', 'noopener,noreferrer');
  };

  const openKoho = () => {
    if (ticket.clientEmail) {
      void chrome.storage.local.set({ pending_koho_email: ticket.clientEmail });
    }
    window.open(KOHO_ADMIN_URL, '_blank', 'noopener,noreferrer');
  };

  // Fire the headless Atlas lookup. The shared helper opens a background tab, waits
  // for the content script to scrape CHEQUING (SPEND), closes the tab, and resolves
  // with the captured value. The on-mount/onChanged listener below keeps the W# chip
  // in sync with the storage value regardless of which workflow triggered the fetch.
  const [fetchPending, setFetchPending] = useState(false);
  const fetchAccountNumber = async () => {
    if (!ticket.identityId || fetchPending) return;
    setFetchPending(true);
    try {
      await fetchAtlasAccountIdHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id });
      // Captured value is mirrored into `captured` state by the storage listener below.
    } catch {
      // timeout / tab-create failure — user can retry manually
    } finally {
      setFetchPending(false);
    }
  };

  // Listen for the captured account number + INDIVIDUAL TIERS > Status coming back from
  // the Atlas content script.
  const [captured, setCaptured] = useState<{ accountNumber: string; individualTierStatus: string | null; capturedAt: string } | null>(null);
  useEffect(() => {
    const read = () => {
      chrome.storage.local.get('atlas_account_number').then((res) => {
        const v = res.atlas_account_number as { sourceTicketId?: string; accountNumber?: string; individualTierStatus?: string | null; capturedAt?: string } | undefined;
        if (v && v.sourceTicketId === ticket.id && typeof v.accountNumber === 'string') {
          setCaptured({
            accountNumber: v.accountNumber,
            individualTierStatus: typeof v.individualTierStatus === 'string' ? v.individualTierStatus : null,
            capturedAt: v.capturedAt || '',
          });
        } else {
          setCaptured(null);
        }
      });
    };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'atlas_account_number' in changes) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [ticket.id]);

  const [copied, setCopied] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton variant="positive" onClick={openAtlas} disabled={!ticket.identityId}>↗ Atlas</ActionButton>
        {isCreditCard || isInterestIssue ? (
          <ActionButton variant="warning" onClick={openI2c} disabled={!ticket.clientEmail}>↗ i2c</ActionButton>
        ) : isPrepaidOrCash ? (
          <ActionButton variant="warning" onClick={openKoho} disabled={!ticket.clientEmail}>↗ Koho</ActionButton>
        ) : null}
      </div>
      <div style={{ display: 'flex' }}>
        <ActionButton variant="highlight" onClick={fetchAccountNumber} disabled={!ticket.identityId || fetchPending} title="Open Atlas in a background tab, click into CHEQUING (SPEND), read back the Account Number, and also capture INDIVIDUAL TIERS > Status">
          {fetchPending ? 'Fetching…' : '↗ Fetch Account Number (W#) and Client Status'}
        </ActionButton>
      </div>
      {captured ? (
        <div style={{ padding: '6px 10px', background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-button)', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--mint-text-micro)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 700, flexShrink: 0 }}>W#:</span>
            <span style={{ fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', flex: 1, userSelect: 'all' }}>{captured.accountNumber}</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(captured.accountNumber).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
              }}
              disabled={copied}
              style={{
                padding: '4px 10px',
                background: copied ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-bg-card)',
                color: copied ? '#fff' : 'var(--mint-positive-fg-strong)',
                border: '1px solid var(--mint-positive-fg-graphic)',
                borderRadius: 'var(--mint-radius-pill)',
                fontSize: 'var(--mint-text-nano)',
                fontWeight: 700,
                cursor: copied ? 'default' : 'pointer',
                flexShrink: 0,
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 700, flexShrink: 0 }}>Status:</span>
            <span style={{ color: 'var(--mint-fg-strong)', userSelect: 'all' }}>
              {captured.individualTierStatus ?? <em style={{ color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>not detected</em>}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- quick actions ----------

const TRANSITION_TO_DONE_ID = '251'; // matches v3 / Apps Script bridge convention

function QuickActions({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onStartWalletTriage, onStartRetentionFeeWaiver, onStartVisaCompanionRpin, onStartRefundAuthLetter, onOpenCloneMove, onOpenCreateReimb }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onStartWalletTriage: () => void; onStartRetentionFeeWaiver: () => void; onStartVisaCompanionRpin: () => void; onStartRefundAuthLetter: () => void; onOpenCloneMove: (initialDestKey?: MoveDestination) => void; onOpenCreateReimb: () => void }) {
  const [doneState, setDoneState] = useState<'idle' | 'pending' | 'done' | 'error'>(
    ticket.status === 'Done' ? 'done' : 'idle',
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { busy: interestBusy, note: interestNote, setNote: setInterestNote, run: runInterestTool } = useInterestTool();

  // Re-sync local action state when the ticket changes (e.g. agent switched to another ticket).
  useEffect(() => {
    setDoneState(ticket.status === 'Done' ? 'done' : 'idle');
    setErrorMsg(null);
    setInterestNote(null);
  }, [ticket.id, ticket.status, setInterestNote]);

  const handleDone = async () => {
    if (doneState === 'pending' || doneState === 'done') return;
    setDoneState('pending');
    setErrorMsg(null);
    try {
      await transitionTicket(ticket.id, TRANSITION_TO_DONE_ID);
      // Optimistic update: status flips to Done without an extra fetch round-trip.
      onTicketUpdate({ ...ticket, status: 'Done' });
      setDoneState('done');
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
      setDoneState('error');
    }
  };

  const doneLabel = (() => {
    switch (doneState) {
      case 'pending': return '… Moving';
      case 'done':    return '✓ Done';
      case 'error':   return '↻ Retry';
      default:        return '✓ Done';
    }
  })();

  // "✓ Done" transitions are only the right call for Eligibility Confirmation tickets;
  // every other workType needs a routed Move or a downstream workflow first.
  const showDone = /eligibility\s*confirmation/i.test(ticket.workType || '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton variant="highlight" onClick={() => onOpenCloneMove()}>→ Clone/Move</ActionButton>
        <ActionButton variant="special" onClick={onStartTriage} title="Start Overpayment Triage">⚡ Triage Overpayment</ActionButton>
        {showDone ? (
          <ActionButton
            variant="positive"
            onClick={handleDone}
            disabled={doneState === 'pending' || doneState === 'done'}
          >
            {doneLabel}
          </ActionButton>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton
          variant="positive"
          onClick={() => {
            if (!ticket.identityId) return;
            const id = ticket.identityId;
            void stagePresetIdentity(id, ticket.id);
            window.open(VERIFY_ELIGIBLE_DD_URLS[0], '_blank', 'noopener,noreferrer');
            // Re-write the pending identity before opening the second tab — the first
            // tab's content script clears the key once its chain completes (Apply →
            // Activity), so this guarantees the second tab also picks it up regardless
            // of timing. Both tabs share the same filter-fill machinery.
            window.setTimeout(() => {
              void stagePresetIdentity(id, ticket.id);
              window.open(VERIFY_ELIGIBLE_DD_URLS[1], '_blank', 'noopener,noreferrer');
            }, 600);
          }}
          disabled={!ticket.identityId}
          title="Open both Verify-Eligible-DD Preset dashboards (7320 + 8324) filtered by this identity"
        >
          📊 Verify Eligible DD
        </ActionButton>
        <ActionButton
          variant="special"
          onClick={onOpenCreateReimb}
          disabled={!ticket.identityId}
          title="Create a new REIMB ticket from this WOCOO ticket"
        >
          💸 Create REIMB Ticket
        </ActionButton>
        <ActionButton variant="neutral" onClick={onStartWalletTriage} disabled={!ticket.identityId} title="Start Wallet Triage workflow (Apple Pay / Google Pay / etc.)">
          💳 Wallet Triage
        </ActionButton>
      </div>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton variant="warning" onClick={onStartVisaCompanionRpin} disabled={!ticket.identityId} title="Visa Companion RPIN diagnostic — open Preset dashboard 7666, then optionally create an i2c ticket to add RPIN">
          🛫 Visa Companion
        </ActionButton>
        <ActionButton
          variant="special"
          onClick={() => { void runInterestTool({ identityId: ticket.identityId, ticketId: ticket.id }); }}
          disabled={interestBusy}
          title="Open the Interest Validation tool (localhost:8501) — starts it locally via Start App.command if it isn't already running"
        >
          {interestBusy ? '… Starting tool' : '🔎 Investigate Interest'}
        </ActionButton>
        <ActionButton
          variant="highlight"
          onClick={onStartRefundAuthLetter}
          title="Generate a refund authorization letter — pulls the client's name and mailing address from Atlas, fills the template, exports a PDF and attaches it to this ticket"
        >
          ✉ Refund Auth Letter
        </ActionButton>
      </div>
      {interestNote ? (
        <div
          role={interestNote.kind === 'error' ? 'alert' : undefined}
          style={{
            fontSize: 'var(--mint-text-micro)',
            lineHeight: 1.45,
            color: interestNote.kind === 'error' ? 'var(--mint-negative-fg-strong)' : 'var(--mint-positive-fg-strong)',
            background: interestNote.kind === 'error' ? 'var(--mint-negative-bg-soft)' : 'var(--mint-positive-bg-soft)',
            padding: '4px 8px',
            borderRadius: 'var(--mint-radius-button)',
          }}
        >
          {interestNote.text}
        </div>
      ) : null}
      {/* Fee-remediation row. Sits below the Visa Companion / Investigate Interest /
          Refund Auth Letter row, and below `interestNote` specifically so that note stays
          adjacent to the Investigate Interest button that produces it. */}
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton
          variant="warning"
          onClick={onStartReverseFee}
          // Interest tickets (by workType OR by content) don't need a ticket-provided
          // clientEmail — the workflow fetches it from Atlas on entry.
          disabled={
            isInterestRelatedWorkType(ticket.workType) || isInterestFeeInContent(ticket.summary, ticket.description)
              ? !ticket.identityId
              : !ticket.clientEmail
          }
          title="Start Reverse Fee workflow"
        >
          ↗ Reverse Fee
        </ActionButton>
        <ActionButton variant="neutral" onClick={onStartQCFeeWaiver} disabled={!ticket.clientEmail} title="Start QC Fee Waiver workflow">
          ⚖️ QC Fee Waiver
        </ActionButton>
        <ActionButton variant="neutral" onClick={onStartRetentionFeeWaiver} disabled={!ticket.clientEmail} title="Start Retention Fee Waiver workflow ($20 × months, admin credit in i2c)">
          🎁 Retention Fee Waiver
        </ActionButton>
      </div>
      {doneState === 'error' && errorMsg ? (
        <div
          role="alert"
          style={{
            fontSize: 'var(--mint-text-micro)',
            color: 'var(--mint-negative-fg-strong)',
            background: 'var(--mint-negative-bg-soft)',
            padding: '4px 8px',
            borderRadius: 'var(--mint-radius-button)',
            marginTop: 2,
          }}
        >
          {errorMsg}
        </div>
      ) : null}
      {doneState === 'done' ? (
        <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', padding: '2px 8px' }}>
          Transitioned to Done.
        </div>
      ) : null}
    </div>
  );
}

// ---------- settings button (gear → navigates to SettingsView) ----------

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Settings"
      aria-label="Settings"
      style={{
        width: 32, height: 32, borderRadius: 8,
        border: 'var(--mint-card-stroke)',
        background: 'var(--mint-bg-card)',
        color: 'var(--mint-fg-subdued-title)',
        cursor: 'pointer',
        fontSize: 14,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      ⚙
    </button>
  );
}

// ---------- helpers ----------

function CenteredText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 'var(--mint-sp-6) var(--mint-sp-4)', textAlign: 'center', color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-meta)' }}>
      {children}
    </div>
  );
}

function EmptyState({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div style={{ padding: 'var(--mint-sp-6) var(--mint-sp-4)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--mint-sp-2)', textAlign: 'center' }}>
      <div style={{ fontSize: 28 }}>🔎</div>
      <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)', fontWeight: 600 }}>No WOCOO ticket open</h2>
      <p style={{ margin: 0, color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-meta)', maxWidth: 280 }}>
        Open a ticket on the WOCOO board in Jira and it'll appear here automatically.
      </p>
      <p style={{ margin: 0, marginTop: 'var(--mint-sp-2)', color: 'var(--mint-fg-inactive)', fontSize: 'var(--mint-text-nano)' }}>
        ⊙ Watching the active tab
      </p>
      <button
        onClick={onSignOut}
        style={{ marginTop: 'var(--mint-sp-3)', padding: '6px 14px', background: 'transparent', color: 'var(--mint-fg-soft)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)', fontWeight: 600 }}
      >
        Sign out
      </button>
    </div>
  );
}

function ErrorState({ message, ticketKey, onRetry }: { message: string; ticketKey: string; onRetry: () => void }) {
  return (
    <div style={{ padding: 'var(--mint-sp-3)' }}>
      <div style={{ background: 'var(--mint-negative-bg-soft)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-3)' }}>
        <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-negative-fg-strong)', fontWeight: 600, marginBottom: 'var(--mint-sp-1)' }}>
          Couldn't load {ticketKey}
        </div>
        <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)', wordBreak: 'break-word' }}>{message}</div>
        <button
          onClick={onRetry}
          style={{ marginTop: 'var(--mint-sp-2)', padding: '6px 14px', background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)', fontWeight: 600, color: 'var(--mint-fg-strong)' }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function cardStyle(): React.CSSProperties {
  return {
    background: 'var(--mint-bg-card)',
    border: 'var(--mint-card-stroke)',
    borderRadius: 'var(--mint-radius-card)',
    padding: 'var(--mint-sp-3)',
    boxShadow: 'var(--mint-card-shadow)',
  };
}

function atlasLinkStyle(): React.CSSProperties {
  return {
    fontSize: 'var(--mint-text-micro)',
    color: 'var(--mint-highlight-fg-strong)',
    fontWeight: 600,
    textDecoration: 'none',
    padding: '2px 6px',
    border: 'var(--mint-card-stroke)',
    borderRadius: 'var(--mint-radius-button)',
  };
}

function FieldRow({ label, value, mono, extra }: { label: string; value: string; mono?: boolean; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--mint-sp-2)', padding: '6px 0', borderBottom: 'var(--mint-card-stroke)' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 2 }}>{label}</div>
        <div
          style={{
            fontFamily: mono ? 'var(--mint-font-mono)' : 'inherit',
            fontSize: 'var(--mint-text-micro)',
            color: 'var(--mint-fg-strong)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={value}
        >
          {value}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-1)' }}>
        <CopyButton value={value} />
        {extra}
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }
      }}
      title="Copy"
      style={{ width: 22, height: 22, padding: 0, background: 'transparent', border: 'none', borderRadius: 4, color: 'var(--mint-fg-soft)', fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

type ActionVariant = 'positive' | 'neutral' | 'ghost' | 'highlight' | 'warning' | 'special';

function ActionButton({ variant, children, onClick, title, disabled }: { variant: ActionVariant; children: React.ReactNode; onClick: () => void; title?: string; disabled?: boolean }) {
  const base: React.CSSProperties = {
    padding: '8px 14px',
    borderRadius: 'var(--mint-radius-button)',
    fontWeight: 600,
    fontSize: 'var(--mint-text-meta)',
    border: 'none',
    flex: variant === 'ghost' ? '0 0 auto' : 1,
    minHeight: 36,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
  const variantStyle: Record<ActionVariant, React.CSSProperties> = {
    positive:  { background: 'var(--mint-positive-fg-graphic)',  color: '#ffffff' },
    neutral:   { background: 'var(--mint-fg-strong)',            color: 'var(--mint-fg-inverted)' },
    ghost:     { background: 'var(--mint-bg-card)',              color: 'var(--mint-fg-strong)', border: 'var(--mint-card-stroke)', padding: '8px 12px' },
    highlight: { background: 'var(--mint-highlight-fg-graphic)', color: '#ffffff' },
    warning:   { background: 'var(--mint-warning-fg-graphic)',   color: '#ffffff' },
    special:   { background: '#7c3aed',                          color: '#ffffff' }, // violet — Mint has no purple token
  };
  return <button onClick={onClick} title={title} disabled={disabled} style={{ ...base, ...variantStyle[variant] }}>{children}</button>;
}

// ---------- reply pill (Koho / i2c inbox notification) ----------
//
// Subscribes to chrome.storage.local[`ticket_replies`] — a map keyed by wocooTicketId
// that the background reply-poll updates every 5 min (and on manual refresh).
//
// The pill renders in one of two states:
//   • unacked (red): "New reply from …" — needs attention
//   • acked (muted): a compact "Reopen last reply in Gmail" chip — the deeplink
//     stays accessible after ack so the agent can revisit the email
//
// It is deliberately sticky: once a ticket has been tracked, the chip stays on the
// panel for good. Reading the reply only downgrades red → muted, and the lookup falls
// back to the append-only archive so a poll that no longer returns the row (bridge
// filters acked rows, transient short response) can't make the deeplink vanish.
//
// Main click opens the Gmail permalink without touching ack state (idempotent —
// safe to click as many times as needed). The ✕ button flips ack (unacked → acked).

const REPLIES_STORAGE_KEY = 'ticket_replies';
const REPLIES_ARCHIVE_KEY = 'ticket_replies_archive';

/** Sheet-derived entries have no received date (the tracking sheet only records when we
 *  sent), so every label that shows one has to cope with an empty/garbage value. */
function fmtReplyDate(iso: string, opts: Intl.DateTimeFormatOptions): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleString('en-CA', opts);
}

/** What to put in a Gmail search when there's no message ID to permalink to.
 *
 *  An i2c PO ref wins for i2c threads: it's in the notification subject, it's unique to the
 *  one investigation, and — unlike the client's address — it's present even on tickets where
 *  the Client Email field is blank (which is most of them, since that field comes back
 *  masked or empty).
 *
 *  Otherwise: i2c rows already track the client's address, so their trackKey is the right
 *  query. Koho rows track the WOCOO id instead — and searching that mostly turns up Jira
 *  notification mail, not the Koho thread. The client's address finds the real thread, so
 *  prefer it whenever the panel has one. */
function gmailSearchKey(
  reply: TicketReply,
  clientEmail: string | undefined,
  ticketId: string,
  i2cTicketRef?: string,
): string {
  if (reply.kind === 'i2c' && i2cTicketRef) return i2cTicketRef;
  const trackKey = reply.trackKey || '';
  if (trackKey.includes('@')) return trackKey;
  return clientEmail || trackKey || ticketId;
}

function ReplyPill({ ticketId, clientEmail, i2cTicketRef }: { ticketId: string; clientEmail?: string; i2cTicketRef?: string }) {
  const [reply, setReply] = useState<TicketReply | null>(null);
  // True while the bridge is resolving an i2c ref to its exact thread — the round-trip
  // opens a background GAS tab, so it's slow enough to need its own label.
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    const read = () => {
      chrome.storage.local.get([REPLIES_STORAGE_KEY, REPLIES_ARCHIVE_KEY]).then((res) => {
        const map = res[REPLIES_STORAGE_KEY] as Record<string, TicketReply> | undefined;
        const archive = res[REPLIES_ARCHIVE_KEY] as Record<string, TicketReply> | undefined;
        const live = map?.[ticketId];
        // Archive-only hits are by definition already-seen, so render them muted.
        const archived = archive?.[ticketId];
        setReply(live || (archived ? { ...archived, acked: true } : null));
      });
    };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (REPLIES_STORAGE_KEY in changes || REPLIES_ARCHIVE_KEY in changes)) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [ticketId]);

  // A tracking row only exists when the extension itself sent the Koho email or opened the
  // i2c form. An i2c ticket raised by hand — pasted into a Jira comment, which is the common
  // case — has no row, so the pill used to render nothing at all. The ticket's own PO ref is
  // enough to find the thread, so synthesise a reply-less entry and let the existing muted
  // chip handle it. messageId stays empty, so it renders as `awaiting` (no ✕, no ack call:
  // there's no sheet row to acknowledge).
  const effective: TicketReply | null =
    reply ?? (i2cTicketRef
      ? { wocooTicketId: ticketId, kind: 'i2c', messageId: '', trackKey: i2cTicketRef, from: '', snippet: '', receivedAt: '', acked: true }
      : null);

  if (!effective) return null;

  const searchUrl = () =>
    `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(gmailSearchKey(effective, clientEmail, ticketId, i2cTicketRef))}`;

  const openEmail = () => {
    // A matched reply already has a message ID to permalink to.
    if (effective.messageId) {
      window.open(`https://mail.google.com/mail/u/0/#inbox/${effective.messageId}`, '_blank', 'noopener,noreferrer');
      return;
    }
    // No reply matched, but an i2c ref can be resolved to the exact thread by the bridge
    // (GAS reads Gmail; the extension can't). Resolve on click rather than on mount — this
    // opens a background bridge tab, which is far too costly to do for every ticket the
    // agent merely looks at. Cached, so only the first click on a ticket pays for it.
    if (i2cTicketRef) {
      setResolving(true);
      void findI2cThreadViaBridge(i2cTicketRef)
        .then((result) => {
          const url = i2cThreadUrl(result);
          // Nothing matched — the notification may not have arrived yet. Fall back to the
          // search rather than leaving the click dead.
          void chrome.tabs.create({ url: url || searchUrl() });
        })
        .catch((err) => {
          // Bridge down, or findI2cThread not deployed yet. Degrade to the search.
          console.warn('[wocoo-reply-pill] i2c thread lookup failed, falling back to search:', err);
          void chrome.tabs.create({ url: searchUrl() });
        })
        .finally(() => setResolving(false));
      return;
    }
    window.open(searchUrl(), '_blank', 'noopener,noreferrer');
  };

  const markAsRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Optimistically flip local acked=true + tell the bridge to persist. The pill
    // stays visible in muted style so the deeplink remains reachable.
    void chrome.storage.local.get(REPLIES_STORAGE_KEY).then((res) => {
      const map = { ...(res[REPLIES_STORAGE_KEY] as Record<string, TicketReply> | undefined || {}) };
      if (map[ticketId]) map[ticketId] = { ...map[ticketId], acked: true };
      void chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
    });
    void acknowledgeReplyViaBridge(ticketId, effective.messageId).catch((err) => {
      console.warn('[wocoo-reply-pill] ack failed:', err);
    });
  };

  const label = effective.kind === 'koho' ? 'Koho' : 'i2c';
  const truncated = effective.snippet.length > 140 ? effective.snippet.slice(0, 140) + '…' : effective.snippet;
  // No messageId = tracked but nothing inbound yet. There's no reply to shout about,
  // so it shares the muted chip and links to a Gmail search for the outbound thread.
  const awaiting = !effective.messageId;
  const acked = effective.acked === true || awaiting;
  const seenDate = fmtReplyDate(effective.receivedAt, { month: 'short', day: 'numeric' });

  if (acked) {
    // Muted "seen" chip — small, single-line, still deep-links to Gmail.
    return (
      <button
        type="button"
        onClick={resolving ? undefined : openEmail}
        title={!awaiting
          ? `Reopen the ${label} reply in Gmail`
          : i2cTicketRef
            ? `Open the Gmail thread for i2c ${i2cTicketRef}. Looked up through the Apps Script bridge ` +
              `on first click, then cached; falls back to a Gmail search if no thread matches yet.`
            : `Search Gmail for the ${label} thread. No reply has been captured for this ticket — ` +
              `that can mean none has arrived, or that reply detection didn't match the thread.`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          margin: '0 var(--mint-sp-3)',
          background: 'var(--mint-bg-subtle)',
          border: 'var(--mint-card-stroke)',
          borderRadius: 'var(--mint-radius-card)',
          cursor: 'pointer',
          textAlign: 'left',
          width: 'calc(100% - 2 * var(--mint-sp-3))',
          boxSizing: 'border-box',
          font: 'inherit',
          color: 'var(--mint-fg-soft)',
        }}
      >
        <span style={{ fontSize: 12, lineHeight: 1, flexShrink: 0 }}>{resolving ? '⏳' : awaiting ? '📤' : '📭'}</span>
        <span style={{ fontSize: 'var(--mint-text-nano)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {/* Deliberately makes no claim about whether a reply exists — detection can
              miss a thread, and asserting "no reply yet" over a real reply is worse
              than saying nothing. */}
          {resolving
            ? `Finding ${i2cTicketRef || label} thread…`
            : awaiting
              ? `↗ Open ${label} thread${label === 'i2c' && i2cTicketRef ? ` — ${i2cTicketRef}` : ' in Gmail'}`
              : `↗ Reopen ${label} reply${seenDate ? ` — ${seenDate}` : ''}`}
        </span>
      </button>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 12px',
        margin: '0 var(--mint-sp-3)',
        background: 'var(--mint-negative-bg-soft)',
        border: '1px solid var(--mint-negative-fg-graphic)',
        borderRadius: 'var(--mint-radius-card)',
        width: 'calc(100% - 2 * var(--mint-sp-3))',
        boxSizing: 'border-box',
      }}
    >
      <button
        type="button"
        onClick={openEmail}
        title={`Open the ${label} reply in Gmail (stays available after mark as read)`}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
          flex: 1,
          minWidth: 0,
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>📬</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 'var(--mint-text-micro)', fontWeight: 700, color: 'var(--mint-negative-fg-strong)' }}>
            New reply from {label}
            {(() => {
              const at = fmtReplyDate(effective.receivedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
              return at ? ` · ${at}` : '';
            })()}
          </span>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.4 }}>
            {truncated || <em style={{ color: 'var(--mint-fg-soft)' }}>(no preview)</em>}
          </span>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            Click to open in Gmail
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={markAsRead}
        title="Mark as read — pill turns into a small persistent Gmail deeplink"
        aria-label="Mark reply notification as read"
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          padding: 0,
          background: 'transparent',
          border: 'none',
          borderRadius: 4,
          color: 'var(--mint-negative-fg-strong)',
          fontSize: 16,
          lineHeight: 1,
          cursor: 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        ×
      </button>
    </div>
  );
}

// Suppress unused-import warning — MOCK_TICKET is kept for any quick visual debug.
void MOCK_TICKET;
