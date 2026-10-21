// Turns the draft agent's move suggestion into values that seed the Move modal. Pure: it never
// submits anything, the modal still needs the user's confirmation.

import type { CreateMetaField } from '../api/jira';
import type { DraftMove } from './agentDraftTypes';
import {
  BOPSFUND_ISSUE_TYPES, DBO_ISSUE_TYPES, FRAUD_ISSUE_TYPES, PFO_ISSUE_TYPES, PRR_ISSUE_TYPES,
  type MoveDestination, type PrrIssueTypeConfig, type PrrRequiredField,
} from './moveConfig';

export interface MovePrefill {
  destination: MoveDestination;
  issueTypeName?: string;
  /** Field id or field name -> value (an option label or id for option fields). */
  fields?: Record<string, string>;
  reason?: string;
  comment?: string;
}

const MODAL_DESTINATIONS: ReadonlySet<string> = new Set<MoveDestination>(
  ['EOC', 'DBO', 'CRED', 'FRAUD', 'PRR', 'PFO', 'BOPSFUND'],
);

/** null when Sidekick can't do this move (flagged unsupported, or WORS/BOTI): the card then
 *  tells the user to move it by hand. */
export function toMovePrefill(move: DraftMove): MovePrefill | null {
  if (!move.sidekick_supported || !MODAL_DESTINATIONS.has(move.destination)) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(move.fields ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v);
  }
  const out: MovePrefill = { destination: move.destination as MoveDestination };
  if (move.issue_type) out.issueTypeName = move.issue_type;
  if (Object.keys(fields).length) out.fields = fields;
  if (move.reason) out.reason = move.reason;
  if (move.comment) out.comment = move.comment;
  return out;
}

const ISSUE_TYPES: Partial<Record<MoveDestination, PrrIssueTypeConfig[]>> = {
  DBO: DBO_ISSUE_TYPES,
  PRR: PRR_ISSUE_TYPES,
  FRAUD: FRAUD_ISSUE_TYPES,
  PFO: PFO_ISSUE_TYPES,
  BOPSFUND: BOPSFUND_ISSUE_TYPES,
};

/** Whether the destination has an issue-type picker (EOC and CRED don't). */
export function hasIssueTypePicker(dest: MoveDestination): boolean {
  return !!ISSUE_TYPES[dest];
}

const norm = (s: string) => s.trim().toLowerCase();

/** The issue-type id for a destination's picker, matched by name. undefined for EOC/CRED (no
 *  picker) and for names the destination doesn't list. */
export function issueTypeIdFor(dest: MoveDestination, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return ISSUE_TYPES[dest]?.find((t) => norm(t.name) === norm(name))?.id;
}

const optionLabel = (o: { id: string; value?: string; name?: string }) => (o.value ?? o.name ?? o.id).toString();

/** Field values to merge into a dynamic form once createmeta has loaded. Keys match a required
 *  field by id or name (case-insensitive). Option values resolve a label (or id) to the option
 *  id the <select> uses; "Parent > Child" fills a cascading field. Anything unmatched is left
 *  blank, and a field that already has a value (e.g. from the ticket) is never overwritten.
 *  Fields Atlas fills (prefillFrom atlasName/atlasAddress) are skipped. */
export function matchPrefillFields(
  required: PrrRequiredField[],
  meta: CreateMetaField[],
  prefill: Record<string, string> | undefined,
  current: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!prefill) return out;
  for (const f of required) {
    if ((current[f.fieldId] ?? '').trim()) continue;
    // Atlas owns these (the scrape lands after createmeta); an agent value must not pre-empt it.
    if (f.prefillFrom === 'atlasName' || f.prefillFrom === 'atlasAddress') continue;
    const key = Object.keys(prefill).find((k) => norm(k) === norm(f.fieldId) || norm(k) === norm(f.name));
    const raw = key === undefined ? '' : prefill[key].trim();
    if (!raw) continue;

    if (f.type === 'option' || f.type === 'array-option' || f.type === 'option-with-child') {
      const opts = meta.find((m) => m.fieldId === f.fieldId)?.allowedValues ?? [];
      // Labels first: an option whose label equals another option's id must resolve by label.
      const find = (list: typeof opts, v: string) =>
        list.find((o) => norm(optionLabel(o)) === norm(v)) ?? list.find((o) => o.id === v);
      if (f.type === 'option-with-child') {
        const [parentRaw, ...rest] = raw.split(/\s*>\s*/);
        const parent = find(opts, parentRaw);
        if (!parent) continue;
        out[f.fieldId] = parent.id;
        const child = rest.length ? find(parent.children ?? [], rest.join(' > ')) : undefined;
        if (child) out[`${f.fieldId}__child`] = child.id;
      } else {
        const hit = find(opts, raw);
        if (hit) out[f.fieldId] = hit.id;
      }
    } else {
      out[f.fieldId] = raw;
    }
  }
  return out;
}
