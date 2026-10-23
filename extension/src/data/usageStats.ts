// Sidekick usage stats — pure types + aggregation behind the 📊 Stats view.
//
// Events are recorded locally (see usageStore.ts) from the ticket view's buttons, the
// ticket-transition bus, and the places Sidekick creates Jira tickets. A solved ticket
// is classified by the buttons clicked on it at any point before its outcome:
//   - any workflow button      → "Solved through Sidekick"
//   - only lookup buttons      → "Assisted by Sidekick"
//   - no Sidekick button       → "Unassisted"

import type { TicketTransitionKind } from './ticketLogTypes';

export type UsageButtonKind = 'workflow' | 'lookup';

export const USAGE_BUTTONS = {
  clone_move:          { label: '→ Clone/Move',            kind: 'workflow' },
  triage_overpayment:  { label: '⚡ Triage Overpayment',    kind: 'workflow' },
  done:                { label: '✓ Done',                   kind: 'workflow' },
  verify_eligible_dd:  { label: '📊 Verify Eligible DD',    kind: 'workflow' },
  create_reimb:        { label: '💸 Create REIMB Ticket',   kind: 'workflow' },
  wallet_triage:       { label: '💳 Wallet Triage',         kind: 'workflow' },
  visa_companion:      { label: '🛫 Visa Companion',        kind: 'workflow' },
  investigate_interest:{ label: '🔎 Investigate Interest',  kind: 'workflow' },
  refund_auth_letter:  { label: '✉ Refund Auth Letter',     kind: 'workflow' },
  reverse_fee:         { label: '↗ Reverse Fee',            kind: 'workflow' },
  custom_cc_statement: { label: '🧾 Custom CC Statement',   kind: 'workflow' },
  card_issuance_mgr:   { label: '🪪 Card Issuance Mgr',     kind: 'workflow' },
  atlas:               { label: '↗ Atlas',                  kind: 'lookup' },
  koho:                { label: '↗ Koho',                   kind: 'lookup' },
  i2c:                 { label: '↗ i2c',                    kind: 'lookup' },
  fetch_account:       { label: '↗ Fetch Account Number',   kind: 'lookup' },
} as const satisfies Record<string, { label: string; kind: UsageButtonKind }>;

export type UsageButtonId = keyof typeof USAGE_BUTTONS;

export type UsageEvent =
  | { t: number; type: 'click'; ticketId: string; button: UsageButtonId }
  | { t: number; type: 'outcome'; ticketId: string; outcome: TicketTransitionKind; movedToBoard?: string }
  | { t: number; type: 'created'; ticketId: string; createdKey: string; createdKind: string };

export type UsageRange = 'today' | 'week' | 'all';

export type SolveClass = 'sidekick' | 'assisted' | 'unassisted';

export interface UsageSummary {
  solved: number;
  byClass: Record<SolveClass, number>;
  moved: number;
  created: number;
  createdByKind: Array<{ kind: string; count: number }>;
  buttons: Array<{ id: UsageButtonId; label: string; kind: UsageButtonKind; count: number }>;
}

/** Start of the range in epoch ms (local time). Week starts Monday. */
export function rangeStart(range: UsageRange, now: Date = new Date()): number {
  if (range === 'all') return 0;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function summarizeUsage(events: UsageEvent[], range: UsageRange, now: Date = new Date()): UsageSummary {
  const from = rangeStart(range, now);
  const inRange = (e: UsageEvent) => e.t >= from;

  // A ticket counts once per range, at its latest outcome in that range. Clicks are
  // looked up across all history so a ticket worked yesterday and closed today still
  // classifies by what was used on it.
  const lastOutcome = new Map<string, Extract<UsageEvent, { type: 'outcome' }>>();
  const movedTickets = new Set<string>();
  for (const e of events) {
    if (e.type !== 'outcome' || !inRange(e)) continue;
    const prev = lastOutcome.get(e.ticketId);
    if (!prev || e.t >= prev.t) lastOutcome.set(e.ticketId, e);
    if (e.outcome === 'Moved') movedTickets.add(e.ticketId);
  }

  const byClass: Record<SolveClass, number> = { sidekick: 0, assisted: 0, unassisted: 0 };
  for (const [ticketId, outcome] of lastOutcome) {
    let cls: SolveClass = 'unassisted';
    for (const e of events) {
      if (e.type !== 'click' || e.ticketId !== ticketId || e.t > outcome.t) continue;
      if (USAGE_BUTTONS[e.button]?.kind === 'workflow') { cls = 'sidekick'; break; }
      cls = 'assisted';
    }
    byClass[cls]++;
  }

  const buttonCounts = new Map<UsageButtonId, number>();
  const createdCounts = new Map<string, number>();
  let created = 0;
  for (const e of events) {
    if (!inRange(e)) continue;
    if (e.type === 'click') buttonCounts.set(e.button, (buttonCounts.get(e.button) ?? 0) + 1);
    if (e.type === 'created') {
      created++;
      createdCounts.set(e.createdKind, (createdCounts.get(e.createdKind) ?? 0) + 1);
    }
  }

  const buttons = (Object.keys(USAGE_BUTTONS) as UsageButtonId[])
    .map((id) => ({ id, ...USAGE_BUTTONS[id], count: buttonCounts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    solved: lastOutcome.size,
    byClass,
    moved: movedTickets.size,
    created,
    createdByKind: [...createdCounts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    buttons,
  };
}
