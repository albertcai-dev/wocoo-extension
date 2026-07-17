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
 * REIMB description template modeled byte-for-byte on REIMB-42740's actual description:
 *
 *   Hi team, can we please reimburse this client (identity-XXX) for $211.68? Reference ticket: ␊
 *   ␊
 *   https://wealthsimple.atlassian.net/browse/WOCOO-23296  ␊
 *
 * Note the trailing space after "Reference ticket:" and the two trailing spaces
 * after the URL — both present in the canonical example.
 */
export function buildDescriptionTemplate(identityId: string, amount: number, sourceUrl: string): string {
  return `Hi team, can we please reimburse this client (${identityId}) for $${amount.toFixed(2)}? Reference ticket: \n\n${sourceUrl}  `;
}
