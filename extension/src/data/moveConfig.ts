// Configuration for the Move workflow — destinations, per-destination required fields,
// and the EOC Problem Area master list (157 options).

export type MoveDestination = 'EOC' | 'DBO' | 'CRED' | 'FRAUD' | 'PRR';

export interface DestinationConfig {
  key: MoveDestination;
  name: string;          // Short label, e.g. "EOC"
  fullName: string;      // Full label, e.g. "Engineering On-Call"
  apiEnabled: boolean;   // false = UI-only (extension can't move via API; agent uses Jira's native Move)
  boardUrl: string;
  notes?: string;        // Optional UX explainer shown in the modal
}

export const DESTINATIONS: DestinationConfig[] = [
  {
    key: 'EOC',
    name: 'EOC',
    fullName: 'Engineering On-Call',
    apiEnabled: true,
    boardUrl: 'https://wealthsimple.atlassian.net/jira/software/c/projects/EOC/boards/298',
  },
  {
    key: 'DBO',
    name: 'DBO',
    fullName: 'Digital Branch Operations',
    apiEnabled: true,
    boardUrl: 'https://wealthsimple.atlassian.net/jira/software/c/projects/DBO',
    notes: 'Pick an issue type below — required fields render dynamically from Jira.',
  },
  {
    key: 'CRED',
    name: 'CRED',
    fullName: 'Credit Decisioning',
    apiEnabled: true,
    boardUrl: 'https://wealthsimple.atlassian.net/jira/software/c/projects/CRED/boards/800',
    notes: 'No additional fields required — summary copies from source.',
  },
  {
    key: 'FRAUD',
    name: 'FRAUD',
    fullName: 'Fraud Operation',
    apiEnabled: false,
    boardUrl: 'https://wealthsimple.atlassian.net/jira/software/c/projects/FRAUD/boards/292',
    notes: 'API move not wired for FRAUD — use Jira’s native Move dialog from the ticket.',
  },
  {
    key: 'PRR',
    name: 'PRR',
    fullName: 'Promotions, Referrals, Rewards',
    apiEnabled: true,
    boardUrl: 'https://wealthsimple.atlassian.net/jira/software/projects/PRR/boards/1076',
    notes: 'Pick an issue type below — required fields render dynamically from Jira.',
  },
];

// ── PRR (Promotions, Referrals, Rewards) ──────────────────────────────────────
// Every PRR issue type has its own required-field set. Field IDs + shapes are
// derived from jira_get_project_metadata; option labels are fetched at runtime
// from /rest/api/3/issue/createmeta and cached per (project, issueType, field).

export const PRR_PROJECT_KEY = 'PRR';

// `array-option` is Jira's checkbox field type — value serialises as an array of option
// entries. We render it as a single-select on the extension side (agent adds more via
// Jira after the move) and wrap the chosen option in a 1-length array on submit.
export type PrrFieldType = 'string' | 'number' | 'paragraph' | 'date' | 'option' | 'option-with-child' | 'array-option';

export interface PrrRequiredField {
  fieldId: string;
  name: string;
  type: PrrFieldType;
  /** Optional prefill hint from the source WocooTicket. */
  prefillFrom?: 'identityId' | 'ticketUrl';
}

export interface PrrIssueTypeConfig {
  id: string;
  name: string;
  description: string;
  requiredFields: PrrRequiredField[];
}

// Field IDs that appear across multiple issue types — declared once as constants
// to keep the per-issue-type arrays terse and consistent.
const F_USER_IDENTITY_ID     = { fieldId: 'customfield_11458', name: 'User Identity ID',                                     type: 'string' as const, prefillFrom: 'identityId' as const };
const F_LINK_TO_REQUEST      = { fieldId: 'customfield_12418', name: 'Link to the request (ZD / Salesforce)',                type: 'string' as const, prefillFrom: 'ticketUrl' as const };
const F_REPORTER_TEAM        = { fieldId: 'customfield_16579', name: 'Reporter Team',                                        type: 'option' as const };
const F_CAMPAIGN_NAME        = { fieldId: 'customfield_12390', name: 'Campaign Name',                                        type: 'option' as const };
const F_ENROLLMENT_STATUS    = { fieldId: 'customfield_12391', name: 'Current Enrollment Status',                            type: 'option' as const };
const F_EXPECTED_FUNDING     = { fieldId: 'customfield_12394', name: 'Expected Total Eligible Funding Amount',               type: 'number' as const };
const F_INELIGIBLE_TRANSFERS = { fieldId: 'customfield_12396', name: 'List any eligible transfers or deposits missing',      type: 'paragraph' as const };
const F_REFEREE_ATLAS        = { fieldId: 'customfield_12449', name: "Referree's Atlas link",                                type: 'string' as const };

export const PRR_ISSUE_TYPES: PrrIssueTypeConfig[] = [
  {
    id: '12017',
    name: 'Correction - Qualifying Funding',
    description: 'Qualifying Funding is missing eligible transfers/deposits that should count toward the promotion.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_EXPECTED_FUNDING,
      F_INELIGIBLE_TRANSFERS,
      F_REPORTER_TEAM,
      F_CAMPAIGN_NAME,
      F_ENROLLMENT_STATUS,
    ],
  },
  {
    id: '12018',
    name: 'Referral - Boosted Payout Correction',
    description: 'Referrer is confirmed eligible for a Boosted bonus that was not issued.',
    requiredFields: [
      F_LINK_TO_REQUEST,
      F_REPORTER_TEAM,
      { fieldId: 'customfield_12451', name: 'Which client has reached out?',                                             type: 'option' },
      { fieldId: 'customfield_12452', name: 'Have you confirmed that the Referrer has an open cash account?',            type: 'option' },
      { fieldId: 'customfield_12453', name: "Has it been >30 days since the Referee's first account was opened?",        type: 'option' },
      { fieldId: 'customfield_12456', name: 'Have both clients accepted and received their $25 base bonuses?',           type: 'option' },
      { fieldId: 'customfield_12393', name: 'Date the Referee first opened a Wealthsimple account',                      type: 'date' },
      { fieldId: 'customfield_12448', name: "Referrer's Atlas link",                                                     type: 'string' },
      F_REFEREE_ATLAS,
    ],
  },
  {
    id: '12020',
    name: 'Apple Device Issues',
    description: 'Device-specific issues only — use "Correction - Qualifying Funding" for funding-related Apple device claims.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_CAMPAIGN_NAME,
      { fieldId: 'customfield_12462', name: 'What is the primary issue with the Apple device?', type: 'option-with-child' },
      { fieldId: 'customfield_15325', name: 'Updated Shipping Address',                         type: 'paragraph' },
    ],
  },
  {
    id: '12096',
    name: 'Exception - No Enrolment',
    description: 'Client funded accounts without a valid enrolment/registration and is requesting an exception. Subject to Promo Ops approval.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_EXPECTED_FUNDING,
      F_INELIGIBLE_TRANSFERS,
      F_REPORTER_TEAM,
      F_CAMPAIGN_NAME,
      F_ENROLLMENT_STATUS,
    ],
  },
  {
    id: '13433',
    name: 'Exception - Ineligible Funding',
    description: 'Enrolled client requesting exception for funding that is ineligible or outside the enrollment period.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_EXPECTED_FUNDING,
      F_INELIGIBLE_TRANSFERS,
      F_REPORTER_TEAM,
      F_CAMPAIGN_NAME,
      F_ENROLLMENT_STATUS,
    ],
  },
  {
    id: '13862',
    name: 'Referral - Create Relationship (L1 Use)',
    description: 'Client is unable to input their referrer.',
    requiredFields: [
      F_LINK_TO_REQUEST,
      F_REPORTER_TEAM,
      { fieldId: 'customfield_14170', name: "Referrer's Full Name",                                    type: 'string' },
      { fieldId: 'customfield_14171', name: "Referrer's Email address (used for their WS account)",   type: 'string' },
      { fieldId: 'customfield_14173', name: 'Link to ZD ticket with Referee consenting to referral',  type: 'string' },
      { fieldId: 'customfield_14172', name: 'Have we verified the REFEREE?',                           type: 'option' },
      F_REFEREE_ATLAS,
    ],
  },
  {
    id: '15479',
    name: 'Correction - Payout / Available to Withdraw',
    description: "Client's Match Bonus reflects an incorrect amount, or scheduled payout is missing. Use Correction - Qualifying Funding if the captured funding is incorrect.",
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_REPORTER_TEAM,
      F_CAMPAIGN_NAME,
      F_ENROLLMENT_STATUS,
    ],
  },
  {
    id: '15480',
    name: 'Exception - Suppression / Hold / A2W',
    description: 'Request an exception to the existing Hold or Suppression amount. Approval not guaranteed — provide justification.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_REPORTER_TEAM,
      F_CAMPAIGN_NAME,
      F_ENROLLMENT_STATUS,
    ],
  },
  {
    id: '19256',
    name: 'CC Merchant Rewards',
    description: 'Physical Reward issues for CC merchant rewards.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      { fieldId: 'customfield_21838', name: 'Physical Reward',       type: 'option' },
      { fieldId: 'customfield_21839', name: 'Physical Reward Issue', type: 'option' },
    ],
  },
  {
    id: '19289',
    name: 'Correction - Giveaway Entries',
    description: 'Client is missing Home/Gold Giveaway entries.',
    requiredFields: [
      F_USER_IDENTITY_ID,
      F_LINK_TO_REQUEST,
      F_REPORTER_TEAM,
      { fieldId: 'customfield_21872', name: 'Giveaway Name',              type: 'option' },
      { fieldId: 'customfield_21873', name: 'Number of Missing Entries',  type: 'number' },
    ],
  },
];

// EOC bulk-move target identifiers (matches v3's Apps Script bridge)
export const EOC_TARGET = {
  PROJECT_ID: '10188',
  ISSUETYPE_ID: '10002',
} as const;

export const EOC_CLIENT_STATUS_IDS = {
  Core: '17688',
  Premium: '17689',
  Generation: '17690',
} as const;

// User Tier — labels match Jira AND WOCOO ticket.tier values. Still used by REIMB
// ticket creation (reimbConfig re-exports it), so this block stays even though PFO is
// gone.
export const USER_TIER_LABELS = ['Core', 'Premium', 'Generation'] as const;
export type UserTier = (typeof USER_TIER_LABELS)[number];

export function tierToUserTierLabel(tier: string | null | undefined): UserTier {
  if (tier === 'Premium' || tier === 'Generation' || tier === 'Core') return tier;
  return 'Core';
}

// ── DBO (Digital Branch Operations) — replaces PFO as of 2026-07 ──────────────
// DBO has 9 issue types with mixed required-field sets. Structure mirrors PRR: each
// entry lists the extension-required fields (a mix of Jira-required plus a couple
// prefillable ones we surface for convenience). Option labels are resolved at runtime
// via createmeta. Client ID is customfield_21350 on all types EXCEPT Document
// Mailing/Signing, which uses customfield_25721 — that's a Jira quirk, not ours.

export const DBO_PROJECT_KEY = 'DBO';

const F_DBO_CLIENT_ID     = { fieldId: 'customfield_21350', name: 'Client ID', type: 'string' as const, prefillFrom: 'identityId' as const };
const F_DBO_CLIENT_ID_DOC = { fieldId: 'customfield_25721', name: 'Client ID', type: 'string' as const, prefillFrom: 'identityId' as const };

export const DBO_ISSUE_TYPES: PrrIssueTypeConfig[] = [
  {
    id: '19051',
    name: 'Credit Limit Increase',
    description: 'Client is requesting an increase to their credit card limit.',
    requiredFields: [
      F_DBO_CLIENT_ID,
      { fieldId: 'customfield_21349', name: 'Amount of credit limit increase requested', type: 'number' },
    ],
  },
  {
    id: '19053',
    name: 'Credit Limit Decrease',
    description: 'Client is requesting a decrease to their credit card limit.',
    requiredFields: [
      F_DBO_CLIENT_ID,
      { fieldId: 'customfield_21351', name: 'Amount of credit limit decrease requested', type: 'number' },
    ],
  },
  {
    id: '21429',
    name: 'Cheque Delivery',
    description: 'Ship a cheque or bank draft to the client. Address, tracking, and delivery details are filled in Jira after the move.',
    requiredFields: [
      F_DBO_CLIENT_ID,
    ],
  },
  {
    id: '21430',
    name: 'Drafts',
    description: 'Bank draft workflow. Address, tracking, and draft details are filled in Jira after the move.',
    requiredFields: [
      F_DBO_CLIENT_ID,
    ],
  },
  {
    id: '21434',
    name: 'Draft Reversal',
    description: 'Reverse a previously-issued bank draft.',
    requiredFields: [
      F_DBO_CLIENT_ID,
      { fieldId: 'customfield_25696', name: 'Bank Draft Number', type: 'string' },
    ],
  },
  {
    id: '21435',
    name: 'Document Mailing/Signing',
    description: 'Mail or scan a document (agreements, letters, etc.) to/from the client.',
    requiredFields: [
      F_DBO_CLIENT_ID_DOC,
      { fieldId: 'customfield_25719', name: 'Is the document attached?', type: 'option' },
      { fieldId: 'customfield_25716', name: 'For mailed items: Is a signature required?', type: 'option' },
      { fieldId: 'customfield_25717', name: 'Mail / Scan Designation', type: 'array-option' },
    ],
  },
  {
    id: '21436',
    name: 'Cheque: Stop Payment',
    description: 'Stop payment on a previously-issued cheque.',
    requiredFields: [
      F_DBO_CLIENT_ID,
      { fieldId: 'customfield_25722', name: 'Cheque Number', type: 'string' },
    ],
  },
  {
    id: '21437',
    name: 'Chequebook: Delivery Issue',
    description: 'Chequebook was not delivered or has a delivery issue.',
    requiredFields: [
      F_DBO_CLIENT_ID,
    ],
  },
  {
    id: '21438',
    name: 'Dispute Letters',
    description: 'Dispute-related letter workflow.',
    requiredFields: [
      F_DBO_CLIENT_ID,
    ],
  },
];

// EOC Problem Area master list. Order matters — Payment Card group is pinned on top
// (recommended for WOCOO triage flow); other areas are alphabetized below.
export interface ProblemAreaGroup { group: string; options: string[]; }

export const EOC_PROBLEM_AREAS: ProblemAreaGroup[] = [
  {
    group: 'Payment Card (recommended for WOCOO)',
    options: [
      'Payment Card - Issuance & Lifecycle',
      'Payment Card - Purchases and Declines',
      'Payment Card -  Rewards & ATM Fee Reimbursements',
      'Payment Card - Statements & Fees',
      'Payment Card - Uncategorized',
    ],
  },
  {
    group: 'All other areas',
    options: [
      'Account Closure',
      'Account creation',
      'Account Opening Issue',
      'Account ownership',
      'Account status (open, pending, manual review)',
      'Advising',
      'Agreements (Sign, resurface, update, W-8BEN)',
      'Alt Investments - Private Credit',
      'Alt Investments - Private Equity',
      'Alt Investments - Venture Fund',
      'AML Scan',
      'App Signup',
      'Atlas Copilot',
      'Atlas Infrastructure',
      'Atlas Onboarding and Offboarding',
      'Balance Quantity Issue',
      'Bank & Brokerage Linking (Plaid, Flinks, WST)',
      'Banking - Auto-invest your paycheque',
      'BART',
      'Bill Pay',
      'Biometrics/Quick Access',
      'Book Value/Cost Discrepancy',
      'BoR Calc - Big Bang - Book Value Adjustment',
      'BoR Calc - BookValue - App vs Statement Discrepancy',
      'BoR Calc - BookValue - Corporate Action',
      'BoR Calc - BookValue - Institutional Transfer',
      'BoR Calc - BookValue - Internal Transfer',
      'BoR Calc - BookValue - Manual Correction in Ledger',
      'BoR Calc - BookValue - New Holdings Experience',
      'BoR Calc - BookValue - Other',
      'BoR Calc - BookValue - Trade Upgrade/Downgrade',
      'BoR Calc - NetDeposits - Manual Transaction',
      'BoR Calc - NetDeposits - Other',
      'BoR Calc - Positions/Qty - App vs Statement Discrepancy',
      'BoR Calc - Positions/Qty - New Holdings Experience',
      'BoR Calc - Positions/Qty - Other',
      'BoR Kratos Issue',
      'Business Chequing - Bugs',
      'Cash Account - Pre-Authorized Debits (PADs)',
      'Cash account status - Deactivation, suspensions',
      'Cash Interest - Missed/Incorrect payout',
      'Cash onboarding - Bugs, troubleshooting',
      'Cash onboarding - Reopen account',
      'Corporate Actions',
      'Corporate Info',
      'Corporate Ownership',
      'Corporate Save',
      'Corporate Statements',
      'Credit Risk',
      'Currency Conversion',
      'Debit Card Funding',
      'Direct Deposit',
      'Dividend reinvestments',
      'Dividends',
      'Earnings/Returns Discrepancy',
      'EFT',
      'Estate Beneficiaries',
      'E-Transfers',
      'External (Institutional) Account Transfers',
      'Financial Activity Model (FAM)',
      'Financial Metric Related Upgrade/Downgrade Failure',
      'Financial Risk - Restrictions',
      'Financial Risk - Suspicious Transaction',
      'Financial Risk - Transaction Limits (including Instant EFT)',
      'Foreign Asset Reports',
      'FPL/Stock Lending',
      'Fraud Eng - Not listed',
      'Global Activity Feed',
      'Graphs - Account (1D, 1W Only)',
      'Growth Engagement R&D - Push & Email Notifications',
      'Home/Account/Identity Graph Data',
      'Household Money Management',
      'Identity Conflict',
      'Identity Merge / SIN Conflict (plz send to BOAO)',
      'Identity Trust - Device Management',
      'Identity Trust - Identity Fraud',
      'Identity Trust - Identity Restriction',
      'Identity Trust - OTP Reset',
      'Identity Trust - Soft Deleted/Churned Users',
      'Identity Verification (IDV)',
      'IDV - FINTRAC/Comprehensive Status',
      'Impersonation',
      'Inflight Activities',
      'Internal Transfers',
      'International Transfers',
      'Login - Unified App',
      'Login - Web',
      'Managed Investing - Not Listed',
      'Management Fees',
      'Margin',
      'Margin Buying Power',
      'Margin Call',
      'Marketing - Wealthsimple.com - CMS support',
      'Marketing - Wealthsimple.com - Copy updates - High-priority',
      'Marketing - Wealthsimple.com - Copy updates - Nice to have',
      'Marketing - Wealthsimple.com - Data update',
      'Marketing - Wealthsimple.com - Help center',
      'Marketing - Wealthsimple.com - SEO',
      'Marketing - Wealthsimple.com - UI polish - High-priority',
      'Marketing - Wealthsimple.com - UI polish - Nice to have',
      'Marketing - Wealthsimple.com - Vanity URLs',
      'Misc Financial Metric Issue',
      'Missing/Incorrect Transactions in Ledger',
      'Mobile - Accessibility Feature',
      'Mobile Cheque Deposits',
      'Monthly Statements',
      'Net Deposits Discrepancy',
      'NLV/AUM/Hero Number Discrepancy',
      'OAuth Applications',
      'Option Trading',
      'Options Trading AI',
      'Order bank draft, cash or cheques',
      'Order Execution',
      'Order flow',
      'Order Gen',
      'OTP Code not delivering',
      'OTP codes are invalid',
      'P2P',
      'Password Reset',
      'Pending Deposits and Unsettled Trades (Holds)',
      'Personal info (KYC)',
      'Portfolio line of credit (PLOC)',
      'Portfolios - Account Status',
      'Portfolios - Engineering Tasks',
      'Portfolios - Not Listed',
      'Portfolios - Portfolio Questions',
      'Portfolios - Risk Survey/Suitability/Reassessment',
      'Rates - Interest/Margin/Management Fee/Etc',
      'Re-open accounts in Bulk',
      'Recurring Investments',
      'RESP - Agreements',
      'RESP - Beneficiaries',
      'RESP - Grants',
      'Rewards',
      'Rewards - Premium',
      'Risk Survey (portfolio details)',
      'Running Balances',
      'Securities Data - Corporate Actions',
      'Securities Data - KTLO & Maintenance',
      'Securities Data - Market Data',
      'Securities Data - Options',
      'Securities Data - Pricing',
      'Securities Experience - Discover Screen',
      'Securities Experience - Holdings List or Security Holdings Display',
      'Securities Experience - KTLO & Maintenance',
      'Securities Experience - Price Alerts',
      'Securities Experience - SDI Account Graphs Display',
      'Securities Experience - Security Details Page Display',
      'Securities Experience - Security Graphs',
      'Securities Experience - Security Logos',
      'Securities Experience - Security Search',
      'Securities Experience - Watchlist',
      'Security Vulnerability',
      'Shareholder Communications',
      'Signup - Email Confirmation',
      'Tax Slips',
      'Tiers',
      'UK Client Tax Documents',
      'W4W (employees, contributions dates)',
      'Web - Accessibility Feature',
      'Web Signup',
      'Wires',
      'WS Crypto - Not listed',
      'WS Tax - Not listed',
    ],
  },
];

/** Recommended Problem Area for a given ticket category. */
export function recommendedProblemArea(category: string): string | null {
  if (/cc application reset/i.test(category) || /credit card.*application/i.test(category)) {
    return 'Payment Card - Issuance & Lifecycle';
  }
  if (/credit card|prepaid card/i.test(category)) {
    return 'Payment Card - Issuance & Lifecycle';
  }
  return null;
}

