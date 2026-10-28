// Verify balance step shared by Overpayment Triage and Estate CC Payment: source pills
// (Preset / Atlas / i2c), the i2c running-balance capture, and Verified / Balance differs.
// Extracted unchanged from OverpaymentTriage's Step3Body; only the compare is now
// mode-aware (see data/balanceCompare.ts).
//
// i2c storage contract (unchanged): clicking i2c ↗ stages the pending_i2c_* keys with flow
// 'verify_balance'; content/i2c.ts writes i2c_running_balance, read back here filtered by
// sourceTicketId.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { compareBalance, type CompareMode } from '../data/balanceCompare';
import { stagePresetIdentity as stageIdentityForPreset } from '../data/presetIdentity';
import { PRESET_DASHBOARD_IDS, presetDashboardUrl } from '../data/presetConfig';

export function VerifyBalanceStep(props: {
  ticket: WocooTicket;
  fmtAmt: string;
  amount: number | null;
  adjustOpen: boolean;
  setAdjustOpen: (v: boolean) => void;
  adjustedAmountInput: string;
  setAdjustedAmountInput: (s: string) => void;
  applyAdjustedAmount: () => void;
  showContinue: boolean;
  onVerify: () => void;
  compareMode: CompareMode;
  /** Shown above the source pills, e.g. Estate's Pantheon balance line. */
  extraInfo?: React.ReactNode;
}) {
  const presetUrl = presetDashboardUrl(PRESET_DASHBOARD_IDS.overpayment);
  const atlasUrl = `https://atlas.wealthsimple.com/identity/${props.ticket.identityId}/overview/?ticketId=${props.ticket.id}`;
  const i2cUrl = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';
  const stageI2cEmail = () => {
    if (props.ticket.clientEmail) {
      // Set verify_balance flow so the i2c chain knows to: navigate to Account
      // Transactions, switch to Recent Activity, click Search, then scrape and write
      // back the most-recent Running Balance for this ticket.
      void chrome.storage.local.set({
        pending_i2c_email: props.ticket.clientEmail,
        pending_i2c_source_ticket_id: props.ticket.id,
        pending_i2c_flow: 'verify_balance',
        pending_i2c_started_at: Date.now(),
      });
      // Clear any stale flow-specific keys from a previous run.
      void chrome.storage.local.remove(['pending_i2c_ticket_url', 'pending_i2c_admin_debit_amount']);
    }
  };
  const stagePresetIdentity = () => {
    if (props.ticket.identityId) {
      void stageIdentityForPreset(props.ticket.identityId, props.ticket.id);
    }
  };

  // Read the running balance the i2c content script writes back after Search succeeds.
  // Only display it when sourceTicketId matches this ticket (otherwise it's a stale
  // capture from another customer).
  const [runningBalance, setRunningBalance] = useState<{ value: number; valueText: string; capturedAt: string } | null>(null);
  useEffect(() => {
    const read = () => {
      chrome.storage.local.get('i2c_running_balance').then((res) => {
        const v = res.i2c_running_balance as { sourceTicketId?: string; value?: number; valueText?: string; capturedAt?: string } | undefined;
        if (v && v.sourceTicketId === props.ticket.id && typeof v.value === 'number') {
          setRunningBalance({ value: v.value, valueText: v.valueText || `$${v.value.toFixed(2)}`, capturedAt: v.capturedAt || '' });
        } else {
          setRunningBalance(null);
        }
      });
    };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'i2c_running_balance' in changes) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [props.ticket.id]);
  return (
    <>
      {props.extraInfo}
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', flexWrap: 'wrap', marginBottom: 'var(--mint-sp-3)' }}>
        <a href={presetUrl} target="_blank" rel="noreferrer" onClick={stagePresetIdentity} style={pillLink('highlight')}>Preset ↗</a>
        <a href={atlasUrl} target="_blank" rel="noreferrer" style={pillLink('positive')}>Atlas ↗</a>
        <a href={i2cUrl} target="_blank" rel="noreferrer" onClick={stageI2cEmail} style={pillLink('warning')}>i2c ↗</a>
      </div>
      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 6 }}>Filter by</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ flex: 1, padding: '6px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-strong)', wordBreak: 'break-all', lineHeight: 1.4 }}>
            {props.ticket.identityId}
          </span>
          <CopyIcon value={props.ticket.identityId} />
        </div>
      </div>

      {/* Running balance captured by the i2c content script after clicking i2c ↗ */}
      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 6 }}>Running balance (from i2c)</div>
        {runningBalance == null ? (
          <div style={{ padding: '6px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            Click i2c ↗ to capture
          </div>
        ) : (() => {
          const amount = props.amount;
          const { matches, diff, nothingOwed } = compareBalance(runningBalance.value, amount, props.compareMode);
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1, padding: '6px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-strong)' }}>
                {runningBalance.valueText}
              </span>
              {nothingOwed ? (
                <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)', fontWeight: 600 }}>⚠ nothing owed</span>
              ) : amount != null ? (
                matches ? (
                  <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ matches</span>
                ) : (
                  <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)', fontWeight: 600 }} title={`Ticket amount: $${amount.toFixed(2)}`}>
                    ⚠ differs by ${diff!.toFixed(2)}
                  </span>
                )
              ) : null}
            </div>
          );
        })()}
      </div>

      {props.showContinue ? (
        <>
          <button onClick={props.onVerify} style={{ ...primaryButton, background: 'var(--mint-positive-fg-graphic)', width: '100%' }}>✓ Verified</button>
          <button onClick={() => props.setAdjustOpen(!props.adjustOpen)} style={{ ...secondaryButton, width: '100%', marginTop: 'var(--mint-sp-2)', color: 'var(--mint-warning-fg-strong)', borderColor: 'var(--mint-warning-fg-graphic)' }}>Balance differs</button>
          {props.adjustOpen ? (
            <InlineEditCard label="Enter the verified balance">
              <span style={{ alignSelf: 'center' }}>$</span>
              <input
                type="number" step="0.01"
                value={props.adjustedAmountInput}
                onChange={(e) => props.setAdjustedAmountInput(e.target.value)}
                placeholder="1000.00"
                style={inlineInput}
              />
              <button onClick={props.applyAdjustedAmount} style={smallPrimaryButton}>Use</button>
            </InlineEditCard>
          ) : null}
        </>
      ) : (
        <div style={reviewNote}>Verified at <strong>{props.fmtAmt}</strong> earlier.</div>
      )}
    </>
  );
}

function InlineEditCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 'var(--mint-sp-2)', padding: 'var(--mint-sp-2) var(--mint-sp-3)', background: 'var(--mint-warning-bg-soft)', borderRadius: 'var(--mint-radius-button)' }}>
      <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-warning-fg-strong)', fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, rowGap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function CopyIcon({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      onClick={() => { if (navigator.clipboard && value) { navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }); } }}
      title="Copy"
      style={{ width: 20, height: 20, padding: 0, background: 'transparent', border: 'none', borderRadius: 4, color: 'var(--mint-fg-soft)', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

// styles copied from OverpaymentTriage.tsx (repo convention: per-file style primitives)

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
const smallPrimaryButton: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-micro)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
};
const secondaryButton: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  cursor: 'pointer',
};
const inlineInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0, // default flex min-width is auto → causes overflow when content > available
  padding: '6px 10px',
  fontFamily: 'var(--mint-font-mono)',
  fontSize: 'var(--mint-text-micro)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};
const reviewNote: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-soft)',
  fontStyle: 'italic',
};
function pillLink(tone: 'highlight' | 'positive' | 'warning'): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: `var(--mint-${tone}-bg-soft)`,
    color: `var(--mint-${tone}-fg-strong)`,
    border: '1px solid currentColor',
    borderRadius: 'var(--mint-radius-button)',
    fontSize: 'var(--mint-text-meta)',
    fontWeight: 600,
    textDecoration: 'none',
    flex: 1,
    textAlign: 'center',
  };
}
