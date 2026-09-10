// Which identity a Preset dashboard gets filtered to.
//
// The side panel stages an identity in chrome.storage.local right before it opens a
// Preset tab, and content/preset.ts reads it back and types it into the
// identity_canonical_id filter. Two things made that staged value leak across tickets:
//
//   1. The fill chain only removed the key after it clicked the "Activity" tab, so on a
//      dashboard without that tab the key survived the run.
//   2. The key was a bare identity string — a leftover looked exactly like a fresh
//      stage, so a Preset page opened by hand later got filtered to whichever ticket
//      last staged an identity.
//
// So a staged identity now carries its ticket key and a timestamp and expires quickly,
// and the panel separately mirrors the ticket it currently has open as the fallback.
// That way a hand-opened Preset page filters to the ticket in the panel, not to history.

export const PRESET_STAGED_KEY = 'pending_preset_identity';
export const PRESET_CURRENT_KEY = 'current_preset_identity';
/** Pre-fix key: a bare identity string with no ticket or timestamp. Purged on read. */
export const PRESET_LEGACY_KEY = 'pending_preset_identity_id';

/** A stage is consumed by the tab the panel just opened, so it only needs to outlive
 *  the page load — Preset's dashboards take a few seconds, not minutes. */
export const STAGED_TTL_MS = 5 * 60_000;
/** The mirror tracks the panel's open ticket, so it stays valid for a working day. */
export const CURRENT_TTL_MS = 12 * 60 * 60_000;
/** Storage timestamps come from a different context's clock than the reader's. */
const CLOCK_SKEW_MS = 60_000;

const IDENTITY_RE = /^identity[-_][A-Za-z0-9_-]+$/;

export type PresetIdentityRecord = {
  identityId: string;
  ticketKey: string | null;
  at: number;
};

export type ResolvedPresetIdentity = {
  identityId: string;
  ticketKey: string | null;
  source: 'staged' | 'current';
};

function asRecord(v: unknown): PresetIdentityRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.identityId !== 'string' || !IDENTITY_RE.test(r.identityId)) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const ticketKey = typeof r.ticketKey === 'string' ? r.ticketKey : null;
  return { identityId: r.identityId, ticketKey, at: r.at };
}

function fresh(rec: PresetIdentityRecord, now: number, ttl: number): boolean {
  const age = now - rec.at;
  return age <= ttl && age >= -CLOCK_SKEW_MS;
}

/** Pure: pick the identity a Preset page should filter to, or null to leave it alone. */
export function resolvePresetIdentity(input: {
  staged?: unknown;
  current?: unknown;
  now: number;
}): ResolvedPresetIdentity | null {
  const staged = asRecord(input.staged);
  if (staged && fresh(staged, input.now, STAGED_TTL_MS)) {
    return { identityId: staged.identityId, ticketKey: staged.ticketKey, source: 'staged' };
  }
  const current = asRecord(input.current);
  if (current && fresh(current, input.now, CURRENT_TTL_MS)) {
    return { identityId: current.identityId, ticketKey: current.ticketKey, source: 'current' };
  }
  return null;
}

// ----- storage helpers (side panel writes, content script reads) -----

/** Stage an identity for the Preset tab that is about to be opened. */
export async function stagePresetIdentity(identityId: string, ticketKey: string | null): Promise<void> {
  const rec: PresetIdentityRecord = { identityId, ticketKey, at: Date.now() };
  await chrome.storage.local.set({ [PRESET_STAGED_KEY]: rec });
}

/** Mirror the ticket the panel currently has open, so a Preset page opened by hand
 *  still filters to that ticket. */
export async function mirrorPresetIdentity(identityId: string, ticketKey: string | null): Promise<void> {
  const rec: PresetIdentityRecord = { identityId, ticketKey, at: Date.now() };
  await chrome.storage.local.set({ [PRESET_CURRENT_KEY]: rec });
}

export async function clearPresetIdentityMirror(): Promise<void> {
  await chrome.storage.local.remove(PRESET_CURRENT_KEY);
}

export async function clearStagedPresetIdentity(): Promise<void> {
  await chrome.storage.local.remove(PRESET_STAGED_KEY);
}

/** Read back whichever identity applies now. Also purges the pre-fix key so an old
 *  leftover can't come back. */
export async function readPresetIdentity(now: number = Date.now()): Promise<ResolvedPresetIdentity | null> {
  const res = await chrome.storage.local.get([PRESET_STAGED_KEY, PRESET_CURRENT_KEY, PRESET_LEGACY_KEY]);
  if (PRESET_LEGACY_KEY in res) {
    await chrome.storage.local.remove(PRESET_LEGACY_KEY);
  }
  return resolvePresetIdentity({
    staged: res[PRESET_STAGED_KEY],
    current: res[PRESET_CURRENT_KEY],
    now,
  });
}
