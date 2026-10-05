// Matching rules from the spec's "Matching outcomes" table. Pure: callers do all I/O.

import type {
  CardFact, Candidate, EligibilityFlag, EligibilityRequest, MatchMethod, Resolution, WarehouseRow,
} from './eligibilityTypes';

/** Products whose replies need no manual coverage note. Anything else is flagged vi_1pct. */
export const REVIEW_FREE_PRODUCTS = ['ws_visa_infinite_privilege', 'ws_visa_infinite_plus'] as const;

/** Flags that are acceptable for drafting. Others (parse_warning, unknown_product, etc.) block drafting. */
const TICKABLE_FLAGS: readonly EligibilityFlag[] = ['delinquent', 'vi_1pct'];

/** The i2c card shape this module needs (I2cCard from i2cCardLookup.ts satisfies it). */
export interface I2cCardInput {
  last4: string;
  status: string;
  closed: boolean;
  program?: string;
  delinquencyStatus?: string;
  creationDate?: string;
}

function base(req: EligibilityRequest): Resolution {
  return {
    requestId: req.messageId, status: 'no_match', method: null, clientEmail: null, identityId: null,
    cards: [], flags: [], candidates: [], note: '',
  };
}

export function noMatch(req: EligibilityRequest, note: string, extraFlags: EligibilityFlag[] = []): Resolution {
  return { ...base(req), status: extraFlags.length ? 'needs_review' : 'no_match', flags: extraFlags, note };
}

export function multipleCandidates(req: EligibilityRequest, candidates: Candidate[], note: string): Resolution {
  return { ...base(req), status: 'needs_review', flags: ['multiple_candidates'], candidates, note };
}

export function preflight(req: EligibilityRequest): Resolution | null {
  if (req.messageCount > 1) return noMatch(req, 'Thread already has a reply.', ['already_replied']);
  if (!req.last4) return noMatch(req, 'No card last 4 in the email — will not match on name alone.', ['no_last4']);
  return null;
}

function sortRequestedFirst(cards: CardFact[], last4: string): CardFact[] {
  return [...cards.filter((c) => c.last4 === last4), ...cards.filter((c) => c.last4 !== last4)];
}

function matched(
  req: EligibilityRequest, method: MatchMethod, identityId: string | null, clientEmail: string, cards: CardFact[], note: string,
): Resolution {
  const flags: EligibilityFlag[] = [];
  if (req.warnings.length) flags.push('parse_warning');
  if (cards.some((c) => c.delinquent === true)) flags.push('delinquent');
  if (cards.some((c) => c.product && !(REVIEW_FREE_PRODUCTS as readonly string[]).includes(c.product))) flags.push('vi_1pct');
  if (cards.some((c) => !c.product)) flags.push('unknown_product');
  if (cards.some((c) => !c.creationDate || c.delinquent === null)) flags.push('i2c_details_incomplete');
  return {
    requestId: req.messageId,
    status: flags.length ? 'needs_review' : 'matched',
    method, identityId, clientEmail,
    cards: sortRequestedFirst(cards, req.last4 ?? ''),
    flags, candidates: [], note,
  };
}

export function resolveFromWarehouse(req: EligibilityRequest, rows: WarehouseRow[]): Resolution | null {
  const mine = rows.filter((r) => r.requestId === req.messageId);
  for (const rule of ['email', 'name'] as const) {
    const ids = [...new Set(mine.filter((r) => r.matchRule === rule).map((r) => r.identityId))];
    if (ids.length === 0) continue;
    if (ids.length > 1) {
      const candidates = ids.map((id) => {
        const r = mine.find((x) => x.identityId === id)!;
        return { identityId: id, clientEmail: r.clientEmail, name: `${r.firstName} ${r.lastName}`.trim() };
      });
      return multipleCandidates(req, candidates, `${ids.length} clients match on ${rule} + last 4.`);
    }
    const id = ids[0];
    const own = mine.filter((r) => r.identityId === id);
    const byLast4 = new Map<string, CardFact>();
    for (const r of own) {
      if (!byLast4.has(r.last4)) {
        byLast4.set(r.last4, { last4: r.last4, product: r.cardProduct, creationDate: r.createdDate, delinquent: r.isDelinquent });
      }
    }
    const method: MatchMethod = rule === 'email' ? 'email_last4' : 'name_last4';
    return matched(req, method, id, own[0].clientEmail, [...byLast4.values()], `Warehouse: ${rule} + last 4.`);
  }
  return null;
}

export function resolveFromI2c(
  req: EligibilityRequest,
  args: {
    email: string;
    method: 'i2c_email' | 'atlas_phone_i2c';
    identityId: string | null;
    cards: I2cCardInput[];
    mapProgram: (p: string | undefined) => string | null;
    parseDelinquency: (s: string | undefined) => boolean | null;
  },
): Resolution | null {
  const open = args.cards.filter((c) => !c.closed);
  if (!open.some((c) => c.last4 === req.last4)) return null;
  const cards: CardFact[] = open.map((c) => ({
    last4: c.last4,
    product: args.mapProgram(c.program) ?? '',
    creationDate: c.creationDate ?? '',
    delinquent: args.parseDelinquency(c.delinquencyStatus),
  }));
  const how = args.method === 'i2c_email' ? 'i2c: listed email + last 4.' : 'Atlas phone + name → i2c last 4.';
  return matched(req, args.method, args.identityId, args.email, cards, how);
}

export function isDraftable(res: Resolution): boolean {
  return (
    res.method != null &&
    res.cards.length > 0 &&
    res.cards.every((c) => c.delinquent !== null && !!c.creationDate && !!c.product) &&
    res.flags.every((f) => TICKABLE_FLAGS.includes(f))
  );
}
