// Which identity the Atlas Card Issuance Manager tool gets searched for.
//
// The side panel stages an identity in chrome.storage.local right before it opens
// https://atlas.wealthsimple.com/tools/card_issuance_manager, and content/atlas.ts reads
// it back, types it into the tool's Identity ID field and clicks Search.
//
// Same leak hazard as the Preset staging in presetIdentity.ts: a bare identity string
// left in storage looks exactly like a fresh stage, so a tool page opened by hand later
// would get searched for whichever ticket last staged one. So a stage carries its ticket
// key and a timestamp and expires quickly. Unlike Preset there is no "current ticket"
// mirror — this tool is never opened cold expecting an auto-fill, so a missing stage
// means "leave the page alone".

export const CARD_ISSUANCE_STAGED_KEY = 'pending_atlas_card_issuance';

/** A stage is consumed by the tab the panel just opened, so it only needs to outlive the
 *  page load. Atlas tool pages render in a few seconds, not minutes. */
export const CARD_ISSUANCE_TTL_MS = 5 * 60_000;
/** Storage timestamps come from a different context's clock than the reader's. */
const CLOCK_SKEW_MS = 60_000;

const IDENTITY_RE = /^identity[-_][A-Za-z0-9_-]+$/;

export type CardIssuanceStage = {
  identityId: string;
  ticketKey: string | null;
  at: number;
};

export type ResolvedCardIssuanceStage = {
  identityId: string;
  ticketKey: string | null;
};

/** Pure: decide whether a stored stage should drive this page, or null to leave it alone. */
export function resolveCardIssuanceStage(input: { stored?: unknown; now: number }): ResolvedCardIssuanceStage | null {
  const v = input.stored;
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.identityId !== 'string' || !IDENTITY_RE.test(r.identityId)) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const age = input.now - r.at;
  if (age > CARD_ISSUANCE_TTL_MS || age < -CLOCK_SKEW_MS) return null;
  return { identityId: r.identityId, ticketKey: typeof r.ticketKey === 'string' ? r.ticketKey : null };
}

// ----- storage helpers (side panel writes, content script reads) -----

/** Stage an identity for the Card Issuance Manager tab that is about to be opened. */
export async function stageCardIssuanceSearch(identityId: string, ticketKey: string | null): Promise<void> {
  const rec: CardIssuanceStage = { identityId, ticketKey, at: Date.now() };
  await chrome.storage.local.set({ [CARD_ISSUANCE_STAGED_KEY]: rec });
}

/** Read back the stage, if one still applies. */
export async function readCardIssuanceStage(now: number = Date.now()): Promise<ResolvedCardIssuanceStage | null> {
  const res = await chrome.storage.local.get(CARD_ISSUANCE_STAGED_KEY);
  return resolveCardIssuanceStage({ stored: res[CARD_ISSUANCE_STAGED_KEY], now });
}

export async function clearCardIssuanceStage(): Promise<void> {
  await chrome.storage.local.remove(CARD_ISSUANCE_STAGED_KEY);
}
