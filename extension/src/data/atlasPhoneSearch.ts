// Atlas "User search" by phone (spike S2, 2026-10-05). The same `searchForUsers` query
// Atlas's own search box sends; cookie auth via the shared atlasGraphql() helper.
//
// The search is fuzzy (one phone returned total=60), and the same identity appears in
// several hits (one per user record), so results are filtered to an exact phone match
// and de-duplicated by identityId.

import { atlasGraphql } from './atlasGraphql';

export const ATLAS_PHONE_SEARCH_ENABLED = true;

export interface AtlasPhoneHit {
  identityId: string;
  /** Atlas's full name, trimmed — the only name Atlas gives us. */
  fullName: string;
  /** First whitespace token of `fullName`. */
  firstName: string;
  /** Remaining tokens of `fullName`, joined (may be multi-word). */
  lastName: string;
  email: string | null;
}

// Trimmed to the user index; the argument names match Atlas's own document.
export const SEARCH_FOR_USERS_QUERY = `query searchForUsers($term: String!, $indices: [String!], $perIndexSize: Int, $includeHighlights: Boolean) {
  searchForUsers(term: $term, indices: $indices, perIndexSize: $perIndexSize, includeHighlights: $includeHighlights) {
    user {
      total
      hits {
        source {
          fullName
          phone
          email
          identityId
          id
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Digits only; an 11-digit number with a leading country code 1 is reduced to 10. */
function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** `searchForUsers` → one hit per identity whose phone equals `phone10`. */
export function readPhoneSearchHits(res: unknown, phone10: string): AtlasPhoneHit[] {
  const hits = asRecord(asRecord(asRecord(asRecord(res)?.data)?.searchForUsers)?.user)?.hits;
  if (!Array.isArray(hits)) return [];

  const wanted = phoneDigits(phone10);
  // Never match on a short or empty number: it could pair unrelated clients.
  if (!/^\d{10}$/.test(wanted)) return [];
  const byIdentity = new Map<string, AtlasPhoneHit>();
  for (const hit of hits) {
    const source = asRecord(asRecord(hit)?.source);
    if (!source) continue;
    const identityId = source.identityId;
    if (typeof identityId !== 'string' || !identityId.startsWith('identity-')) continue;
    if (typeof source.phone !== 'string' || phoneDigits(source.phone) !== wanted) continue;
    const email = typeof source.email === 'string' && source.email.trim() ? source.email.trim().toLowerCase() : null;
    const seen = byIdentity.get(identityId);
    if (seen) {
      // First email seen wins, but a later record may supply one the first lacked.
      if (!seen.email) seen.email = email;
      continue;
    }

    const fullName = typeof source.fullName === 'string' ? source.fullName.trim() : '';
    const [firstName = '', ...rest] = fullName.split(/\s+/).filter(Boolean);
    byIdentity.set(identityId, { identityId, fullName, firstName, lastName: rest.join(' '), email });
  }
  return [...byIdentity.values()];
}

export async function searchAtlasByPhone(phone10: string): Promise<AtlasPhoneHit[]> {
  const res = await atlasGraphql('', 'searchForUsers', SEARCH_FOR_USERS_QUERY, {
    term: phone10,
    indices: ['user'],
    // Wide page: a second matching identity ranked past a small page would be missed,
    // letting a single candidate be auto-picked.
    perIndexSize: 100,
    includeHighlights: false,
  });
  return readPhoneSearchHits(res, phone10);
}
