// Shared types for the Insurance Eligibility Confirmation Triage tool.
// Spec: docs/superpowers/specs/2026-10-05-insurance-eligibility-triage-design.md

/** One unread insurer email, as returned by the eligibility bridge's listEligibilityRequests. */
export interface RawEligibilityEmail {
  threadId: string;
  messageId: string;
  /** Raw From header, e.g. `Jane Adjuster <jane@insurer.example>`. */
  from: string;
  /** Lowercased address part of `from`. */
  fromEmail: string;
  subject: string;
  /** ISO timestamp of the latest message. */
  date: string;
  /** Messages in the thread; > 1 means someone already replied. */
  messageCount: number;
  plainBody: string;
}

export interface PersonName {
  /** Everything before the last token, as written. */
  first: string;
  /** The last whitespace-separated token, as written. */
  last: string;
  raw: string;
}

export interface EligibilityRequest {
  threadId: string;
  messageId: string;
  insurerEmail: string;
  insurerName: string;
  subject: string;
  receivedAt: string;
  messageCount: number;
  cardholderName: PersonName | null;
  /** Every non-insurer address found, lowercased, de-duplicated, in order of appearance. */
  emails: string[];
  /** 10 digits, no punctuation, leading country code 1 removed. */
  phone: string | null;
  last4: string | null;
  claimNumber: string | null;
  dateOfLoss: string | null;
  warnings: string[];
}

export interface CardFact {
  last4: string;
  /** card_product_id, e.g. `ws_visa_infinite_privilege`; '' when unknown. */
  product: string;
  /** MM/DD/YYYY; '' when unknown. */
  creationDate: string;
  /** null when unknown. */
  delinquent: boolean | null;
}

export type MatchMethod = 'email_last4' | 'name_last4' | 'i2c_email' | 'atlas_phone_i2c';

export type EligibilityFlag =
  | 'multiple_candidates'
  | 'delinquent'
  | 'vi_1pct'
  | 'no_last4'
  | 'parse_warning'
  | 'already_replied'
  | 'unknown_product'
  | 'i2c_details_incomplete'
  | 'lookup_error'
  | 'name_variant';

export interface Candidate {
  identityId: string;
  clientEmail: string;
  name: string;
}

export interface Resolution {
  /** = EligibilityRequest.messageId */
  requestId: string;
  status: 'matched' | 'needs_review' | 'no_match';
  method: MatchMethod | null;
  clientEmail: string | null;
  identityId: string | null;
  /** Requested last 4 first. Empty unless a single client was identified. */
  cards: CardFact[];
  flags: EligibilityFlag[];
  candidates: Candidate[];
  note: string;
}

/** One row of the batch warehouse query (Task 4), after type coercion. */
export interface WarehouseRow {
  requestId: string;
  matchRule: 'email' | 'name';
  identityId: string;
  clientEmail: string;
  firstName: string;
  lastName: string;
  last4: string;
  cardProduct: string;
  createdDate: string;
  isDelinquent: boolean | null;
}
