// Builds the one-per-batch warehouse query (spec "Step 1 — warehouse") and coerces its rows.
// Every interpolated value is validated against a strict pattern and quote-escaped.

import { normalizeName } from './eligibilityParse';
import type { EligibilityRequest, WarehouseRow } from './eligibilityTypes';

export const CREDIT_PRODUCT_IDS = [
  'ws_visa_infinite_privilege',
  'ws_visa_infinite_plus',
  'ws_visa_infinite_basic',
  'ws_visa_infinite_core',
] as const;

const SAFE_ID = /^[A-Za-z0-9]+$/;
const SAFE_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SAFE_NAME = /^[a-z' -]+$/;
const SAFE_LAST4 = /^\d{4}$/;

function q(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function buildEligibilitySql(reqs: EligibilityRequest[]): string | null {
  const emailRows: string[] = [];
  const nameRows: string[] = [];

  for (const r of reqs) {
    if (!r.last4 || !SAFE_LAST4.test(r.last4) || !SAFE_ID.test(r.messageId)) continue;
    for (const e of r.emails) {
      if (SAFE_EMAIL.test(e)) emailRows.push(`${q(r.messageId)}|${q(e)}|${q(r.last4)}`);
    }
    if (r.cardholderName) {
      const first = normalizeName(r.cardholderName.first);
      const last = normalizeName(r.cardholderName.last);
      if (first && last && SAFE_NAME.test(first) && SAFE_NAME.test(last)) {
        nameRows.push(`${q(r.messageId)}|${q(first)}|${q(last)}|${q(r.last4)}`);
      }
    }
  }
  if (emailRows.length === 0 && nameRows.length === 0) return null;

  const emailCte = emailRows.length
    ? emailRows
        .map((row, i) => {
          const [id, email, last4] = row.split('|');
          return i === 0
            ? `  SELECT ${id} AS request_id, ${email} AS email, ${last4} AS last4`
            : `  UNION ALL SELECT ${id}, ${email}, ${last4}`;
        })
        .join('\n')
    : '  SELECT NULL::varchar AS request_id, NULL::varchar AS email, NULL::varchar AS last4 WHERE FALSE';

  const nameCte = nameRows.length
    ? nameRows
        .map((row, i) => {
          const [id, first, last, last4] = row.split('|');
          return i === 0
            ? `  SELECT ${id} AS request_id, ${first} AS first_norm, ${last} AS last_norm, ${last4} AS last4`
            : `  UNION ALL SELECT ${id}, ${first}, ${last}, ${last4}`;
        })
        .join('\n')
    : '  SELECT NULL::varchar AS request_id, NULL::varchar AS first_norm, NULL::varchar AS last_norm, NULL::varchar AS last4 WHERE FALSE';

  const products = CREDIT_PRODUCT_IDS.map(q).join(', ');

  return `WITH req_email AS (
${emailCte}
),
req_name AS (
${nameCte}
),
open_cards AS (
  SELECT cc.identity_id AS identity_canonical_id, RIGHT(cc.card_number, 4) AS card_last4,
         cc.created_at, cc.card_product_id
  FROM fort_knox.credit_cards cc
  WHERE cc.i2c_card_status = 'open' AND cc.card_product_id IN (${products})
),
latest_delinquency AS (
  SELECT d.identity_canonical_id, d.is_delinquent_account,
         ROW_NUMBER() OVER (PARTITION BY d.identity_canonical_id ORDER BY d.reporting_date DESC) AS rn
  FROM credit.mart_cc_acct_daily_reporting d
),
matched AS (
  SELECT DISTINCT r.request_id, 'email' AS match_rule, ip.identity_canonical_id
  FROM req_email r
  JOIN business_summary.identity_profile ip ON LOWER(ip.email) = r.email
  JOIN open_cards oc ON oc.identity_canonical_id = ip.identity_canonical_id AND oc.card_last4 = r.last4
  UNION
  SELECT DISTINCT r.request_id, 'name' AS match_rule, ip.identity_canonical_id
  FROM req_name r
  JOIN business_summary.identity_profile ip
    ON LOWER(TRIM(ip.first_name)) = r.first_norm AND LOWER(TRIM(ip.last_name)) = r.last_norm
  JOIN open_cards oc ON oc.identity_canonical_id = ip.identity_canonical_id AND oc.card_last4 = r.last4
)
SELECT m.request_id, m.match_rule, m.identity_canonical_id AS identity_id, ip.email AS client_email,
       ip.first_name, ip.last_name, oc.card_last4 AS last4, oc.card_product_id AS card_product,
       TO_CHAR(CONVERT_TIMEZONE('UTC', 'America/New_York', oc.created_at), 'MM/DD/YYYY') AS created_date,
       ld.is_delinquent_account AS is_delinquent
FROM matched m
JOIN business_summary.identity_profile ip ON ip.identity_canonical_id = m.identity_canonical_id
JOIN open_cards oc ON oc.identity_canonical_id = m.identity_canonical_id
LEFT JOIN latest_delinquency ld ON ld.identity_canonical_id = m.identity_canonical_id AND ld.rn = 1
ORDER BY m.request_id, m.match_rule, identity_id, last4`;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const s = str(v).toLowerCase();
  if (s === 'true' || s === 't' || s === '1') return true;
  if (s === 'false' || s === 'f' || s === '0') return false;
  return null;
}

export function toWarehouseRows(rows: Record<string, unknown>[]): WarehouseRow[] {
  return rows.map((r) => ({
    requestId: str(r.request_id),
    matchRule: str(r.match_rule) === 'name' ? 'name' : 'email',
    identityId: str(r.identity_id),
    clientEmail: str(r.client_email).toLowerCase(),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    last4: str(r.last4).padStart(4, '0'),
    cardProduct: str(r.card_product),
    createdDate: str(r.created_date),
    isDelinquent: bool(r.is_delinquent),
  }));
}
