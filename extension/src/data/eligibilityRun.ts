// Runs the spec's resolution order over a batch: preflight → warehouse → i2c by listed
// email → Atlas phone + name → i2c. All I/O is injected so the order is unit-tested.

import type { AtlasPhoneHit } from './atlasPhoneSearch';
import { mapI2cProgram } from './eligibilityProducts';
import { normalizeName } from './eligibilityParse';
import {
  multipleCandidates, noMatch, preflight, resolveFromI2c, resolveFromWarehouse, type I2cCardInput,
} from './eligibilityResolve';
import { buildEligibilitySql, toWarehouseRows } from './eligibilitySql';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';
import { parseI2cDelinquency } from './i2cCardDetailsParse';

export interface ResolveDeps {
  runSql(sql: string): Promise<Record<string, unknown>[]>;
  i2cCards(email: string, requestId: string): Promise<I2cCardInput[]>;
  atlasByPhone: ((phone: string) => Promise<AtlasPhoneHit[]>) | null;
  atlasEmail(identityId: string, requestId: string): Promise<string>;
  onProgress?(requestId: string, stage: string): void;
}

const i2cDeps = { mapProgram: mapI2cProgram, parseDelinquency: parseI2cDelinquency };

function nameMatches(req: EligibilityRequest, hit: AtlasPhoneHit): boolean {
  if (!req.cardholderName) return false;
  const wantFirst = normalizeName(req.cardholderName.first).split(' ')[0];
  const wantLast = normalizeName(req.cardholderName.last);
  const gotFirst = normalizeName(hit.firstName).split(' ')[0];
  const gotLast = normalizeName(hit.lastName);
  return !!wantFirst && wantFirst === gotFirst && wantLast === gotLast;
}

async function resolveLive(req: EligibilityRequest, deps: ResolveDeps): Promise<Resolution> {
  const errors: string[] = [];

  for (const email of req.emails) {
    deps.onProgress?.(req.messageId, `i2c: ${email}`);
    try {
      const cards = await deps.i2cCards(email, req.messageId);
      const r = resolveFromI2c(req, { email, method: 'i2c_email', identityId: null, cards, ...i2cDeps });
      if (r) return r;
    } catch (e) {
      errors.push(`i2c ${email}: ${(e as Error).message}`);
    }
  }

  if (deps.atlasByPhone && req.phone && req.cardholderName) {
    deps.onProgress?.(req.messageId, 'Atlas: phone search');
    try {
      const hits = (await deps.atlasByPhone(req.phone)).filter((h) => nameMatches(req, h));
      if (hits.length > 1) {
        return multipleCandidates(
          req,
          hits.map((h) => ({ identityId: h.identityId, clientEmail: h.email ?? '', name: `${h.firstName} ${h.lastName}` })),
          `${hits.length} Atlas identities share this phone and name.`,
        );
      }
      if (hits.length === 1) {
        const hit = hits[0];
        const email = hit.email ?? (await deps.atlasEmail(hit.identityId, req.messageId));
        if (email) {
          deps.onProgress?.(req.messageId, `i2c: ${email}`);
          const cards = await deps.i2cCards(email, req.messageId);
          const r = resolveFromI2c(req, { email, method: 'atlas_phone_i2c', identityId: hit.identityId, cards, ...i2cDeps });
          if (r) return r;
        }
      }
    } catch (e) {
      errors.push(`Atlas: ${(e as Error).message}`);
    }
  }

  return errors.length
    ? noMatch(req, 'Lookup errors: ' + errors.join('; '), ['lookup_error'])
    : noMatch(req, 'No client matched on email, name, or phone with this last 4.');
}

export async function resolveBatch(reqs: EligibilityRequest[], deps: ResolveDeps): Promise<Resolution[]> {
  const out = new Map<string, Resolution>();
  const pending: EligibilityRequest[] = [];
  for (const r of reqs) {
    const pre = preflight(r);
    if (pre) out.set(r.messageId, pre);
    else pending.push(r);
  }

  const sql = buildEligibilitySql(pending);
  const rows = sql ? toWarehouseRows(await deps.runSql(sql)) : [];

  for (const r of pending) {
    const wh = resolveFromWarehouse(r, rows);
    out.set(r.messageId, wh ?? (await resolveLive(r, deps)));
  }
  return reqs.map((r) => out.get(r.messageId)!);
}
