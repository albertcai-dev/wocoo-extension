// Atlassian Jira REST client. Uses the per-user OAuth access token from src/auth/oauth.ts.
// All calls go through the Atlassian Cloud gateway: https://api.atlassian.com/ex/jira/<cloudId>/...

import { getValidAccessToken } from '../auth/oauth';
import type { WocooTicket } from '../data/mockTicket';

const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// Custom field IDs from the v3 Magic site / Apps Script bridge.
// These are the ones the side panel needs to render the Ticket-in-Context view.
const FIELD_IDENTITY_ID = 'customfield_11458';
const FIELD_TIER = 'customfield_11416';
const FIELD_ACCOUNT_ID_PRIMARY = 'customfield_14401';
const FIELD_ACCOUNT_ID_FALLBACK = 'customfield_10082';
const FIELD_CLIENT_EMAIL = 'customfield_24357';
const FIELD_TOTAL_REIMB_AMOUNT = 'customfield_24151';

let cachedCloudId: string | null = null;

/** Look up the Wealthsimple Atlassian cloud ID; cached after first call. */
export async function getCloudId(): Promise<string> {
  if (cachedCloudId) return cachedCloudId;
  const token = await getValidAccessToken();
  const resp = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error('Failed to fetch accessible-resources (HTTP ' + resp.status + ')');
  const resources = (await resp.json()) as Array<{ id: string; url: string }>;
  const ws = resources.find((r) => (r.url || '').includes('wealthsimple.atlassian.net'));
  if (!ws) throw new Error('No accessible Wealthsimple Atlassian site found in OAuth grant.');
  cachedCloudId = ws.id;
  return ws.id;
}

/** Internal helper — wraps a fetch with the active token + cloudId. */
async function jiraFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  return fetch(`https://api.atlassian.com/ex/jira/${cloudId}${path}`, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(init?.headers || {}) },
  });
}

/** Resolve a project's numeric ID + an issue type's ID by their human names. */
export async function lookupProjectAndIssueType(projectKey: string, issueTypeName: string): Promise<{ projectId: string; issueTypeId: string }> {
  const resp = await jiraFetch(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  if (!resp.ok) throw new Error('Failed to fetch project ' + projectKey + ' (HTTP ' + resp.status + ')');
  const data = await resp.json();
  if (!data.id) throw new Error('Project ' + projectKey + ' has no numeric id.');
  const target = issueTypeName.toLowerCase().trim();
  const match = (data.issueTypes || []).find((t: any) => (t.name || '').toLowerCase() === target);
  if (!match) throw new Error('Issue type "' + issueTypeName + '" not found in project ' + projectKey);
  return { projectId: data.id, issueTypeId: match.id };
}

/**
 * Fetch the full field list (including allowed values with real labels) for a
 * given project + issue type from Jira's createmeta endpoint. Paginated + cached
 * in chrome.storage.local with a 24h TTL so option lists (e.g. Campaign Name)
 * pick up drift without paying a network round-trip on every open.
 */
export interface CreateMetaAllowedValue {
  id: string;
  value?: string;
  name?: string;
  disabled?: boolean;
  children?: CreateMetaAllowedValue[]; // present for option-with-child (cascading)
}

export interface CreateMetaField {
  fieldId: string;
  name: string;
  required: boolean;
  schema?: { type?: string; custom?: string };
  allowedValues?: CreateMetaAllowedValue[];
}

const CREATEMETA_CACHE_KEY = 'jira_createmeta_cache';
const CREATEMETA_TTL_MS = 24 * 60 * 60 * 1000; // 24h

type CreateMetaCache = Record<string, { fetchedAt: number; fields: CreateMetaField[] }>;

function createMetaCacheKey(projectKey: string, issueTypeId: string): string {
  return `${projectKey}:${issueTypeId}`;
}

export async function fetchCreateMetaFields(projectKey: string, issueTypeId: string): Promise<CreateMetaField[]> {
  const cacheKey = createMetaCacheKey(projectKey, issueTypeId);
  const stored = (await chrome.storage.local.get(CREATEMETA_CACHE_KEY))[CREATEMETA_CACHE_KEY] as CreateMetaCache | undefined;
  const cached = stored?.[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < CREATEMETA_TTL_MS) {
    return cached.fields;
  }

  let allFields: CreateMetaField[] = [];
  let startAt = 0;
  for (let safety = 0; safety < 10; safety++) {
    const resp = await jiraFetch(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?startAt=${startAt}&maxResults=100`);
    if (!resp.ok) throw new Error(`Failed to fetch createmeta for ${projectKey}/${issueTypeId} (HTTP ${resp.status})`);
    const data = await resp.json();
    const fields = (data.fields || []) as CreateMetaField[];
    allFields = allFields.concat(fields);
    if (data.isLast !== false || fields.length === 0) break;
    startAt += fields.length;
  }

  const next: CreateMetaCache = { ...(stored || {}) };
  next[cacheKey] = { fetchedAt: Date.now(), fields: allFields };
  await chrome.storage.local.set({ [CREATEMETA_CACHE_KEY]: next });

  return allFields;
}

/**
 * Resolve a Jira custom-field option ID by its human label, given project + issue
 * type context. Uses the cached createmeta field list.
 */
export async function resolveOptionId(
  projectKey: string,
  issueTypeId: string,
  fieldId: string,
  label: string,
): Promise<string> {
  const target = label.toLowerCase().trim();
  const fields = await fetchCreateMetaFields(projectKey, issueTypeId);
  const field = fields.find((f) => f.fieldId === fieldId);
  if (!field?.allowedValues) throw new Error(`Field ${fieldId} not found in ${projectKey}/${issueTypeId} metadata`);
  const match = field.allowedValues.find((v) => {
    const val = (v.value ?? v.name ?? '').toString().toLowerCase();
    return val === target;
  });
  if (!match) throw new Error(`Option "${label}" not found for ${projectKey}/${issueTypeId} field ${fieldId}`);
  return match.id;
}

// Backward-compatible wrapper — EOC Problem Area resolution still uses the
// same field-and-issue-type tuple it always has.
export async function resolveEocProblemAreaId(label: string): Promise<string> {
  return resolveOptionId('EOC', '10002', 'customfield_10334', label);
}

/** Common move target field shape used by the bulk-issues-move endpoint.
 *  Two variants match Atlassian's OpenAPI schema:
 *    • MandatoryFieldValue        → type='raw', value is a list of strings
 *    • MandatoryFieldValueForADF  → type='adf', value is a SINGLE ADF doc (not an array)
 *  Sending a raw string to an ADF-only field returns
 *  "Because <fieldId> is a rich text field, you must set the input type to ADF."
 *  Sending an array-wrapped ADF returns "You must provide a valid ADF object for
 *  field <fieldId>." */
type AdfDoc = { type: 'doc'; version: 1; content: unknown[] };
export type MoveField =
  | { retain: false; type: 'raw'; value: string[] }
  | { retain: false; type: 'adf'; value: AdfDoc };

/** Pull the human messages out of a bulk-move error body:
 *  {"errors":[{"message":"For issue WOCOO-1 To Account is required."}, ...]} */
function parseMoveErrorMessages(body: string): string[] {
  try {
    const errors = (JSON.parse(body) as any)?.errors;
    if (!Array.isArray(errors)) return [];
    return errors.map((e: any) => String(e?.message ?? e).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Field names from "For issue <KEY> <Field Name> is required." messages, deduped.
 *  Returns [] if any message is a different kind of error — a missing-mandatory-field
 *  retry only makes sense when that's ALL Jira complained about. */
function missingMandatoryFieldNames(messages: string[]): string[] {
  if (messages.length === 0) return [];
  const names: string[] = [];
  for (const msg of messages) {
    const m = /^For issue \S+ (.+?) is required\.?$/.exec(msg);
    if (!m) return [];
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Every field on the instance, by lowercased name. `/rest/api/3/field` needs no admin
 *  rights, unlike the field-context/options endpoints. Cached for the session. */
let cachedFieldIndex: Map<string, { id: string; name: string; schemaType?: string }> | null = null;

async function fieldIndexByName(): Promise<Map<string, { id: string; name: string; schemaType?: string }>> {
  if (cachedFieldIndex) return cachedFieldIndex;
  const resp = await jiraFetch('/rest/api/3/field');
  if (!resp.ok) throw new Error(`Failed to list Jira fields (HTTP ${resp.status})`);
  const all = (await resp.json()) as Array<{ id: string; name: string; schema?: { type?: string } }>;
  const index = new Map<string, { id: string; name: string; schemaType?: string }>();
  for (const f of all) {
    const key = (f.name || '').toLowerCase().trim();
    // First definition wins — duplicate display names exist and either resolves the same way.
    if (key && !index.has(key)) index.set(key, { id: f.id, name: f.name, schemaType: f.schema?.type });
  }
  cachedFieldIndex = index;
  return index;
}

/** "N/A" filler for a destination field the panel can't collect, shaped by the field's type.
 *  Option/user/array fields can't be filled blind — a valid option ID is required and reading
 *  a field's options needs Jira admin — so those come back as unsatisfiable. */
function placeholderFor(schemaType: string | undefined): MoveField | null {
  switch (schemaType) {
    case 'string':
      return { retain: false, type: 'raw', value: ['N/A'] };
    case 'number':
      return { retain: false, type: 'raw', value: ['0'] };
    case 'date':
      return { retain: false, type: 'raw', value: [new Date().toISOString().slice(0, 10)] };
    case 'datetime':
      return { retain: false, type: 'raw', value: [new Date().toISOString()] };
    case 'doc':
      return {
        retain: false,
        type: 'adf',
        value: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'N/A' }] }] },
      };
    default:
      return null;
  }
}

/**
 * Turn Jira's "<Field Name> is required." complaints into fillable placeholder values.
 * `alreadySent` guards against re-sending something we provided (Jira only complains about
 * fields we omitted, but a field we sent being echoed back would mean a value problem, not a
 * missing one, and a placeholder would make it worse).
 */
async function placeholdersForRequiredFields(
  names: string[],
  alreadySent: Set<string>,
): Promise<{ fields: Record<string, MoveField>; filled: string[]; unsatisfiable: string[] }> {
  const index = await fieldIndexByName();
  const fields: Record<string, MoveField> = {};
  const filled: string[] = [];
  const unsatisfiable: string[] = [];

  for (const name of names) {
    const meta = index.get(name.toLowerCase().trim());
    if (!meta || alreadySent.has(meta.id)) {
      unsatisfiable.push(name);
      continue;
    }
    const placeholder = placeholderFor(meta.schemaType);
    if (!placeholder) {
      unsatisfiable.push(`${name} (${meta.schemaType || 'unknown'} field — needs a real option)`);
      continue;
    }
    fields[meta.id] = placeholder;
    filled.push(name);
  }
  return { fields, filled, unsatisfiable };
}

/**
 * Perform a Jira bulk-issues-move from a WOCOO ticket to another project.
 * Returns the optional taskId Jira gives back for tracking the async move.
 *
 * Two-attempt shape, because the bulk-move API validates required fields against the
 * DESTINATION PROJECT'S FIELD CONFIGURATION, while createmeta (what moveConfig.ts and the
 * modal's field pickers are built from) only reports fields on the destination's create
 * screen. Fields that are field-config-required but off-screen are therefore invisible to
 * us and can't be collected from the user — EOC currently has five of them
 * ("To Account", "Transfer Canonical ID", ...). Ticket creation in EOC is unaffected,
 * which is why this surfaces as moves-only breakage.
 *
 * Attempt 1 sends just the values the panel collected. If Jira rejects the move ONLY for
 * missing mandatory fields, attempt 2 re-sends the same payload plus an "N/A" placeholder for
 * each field Jira named, with the field IDs and types resolved from /rest/api/3/field at
 * runtime (nothing hardcoded — the next field an admin makes required is handled too).
 * A rejected bulk-move request applies nothing, so the retry is safe.
 *
 * `inferFieldDefaults: true` is NOT a way out of this: it's mutually exclusive with
 * targetMandatoryFields ("Target mandatory fields mapping cannot be present when
 * inferFieldDefaults is true"), and tried on its own against EOC it defaulted nothing —
 * it came back demanding all eight fields, including the ones the panel had been supplying.
 */
export async function moveTicket(args: {
  sourceKey: string;
  destProjectId: string;
  destIssueTypeId: string;
  mandatoryFields: Record<string, MoveField>;
}): Promise<{
  taskId: string | null;
  /** Human names of off-screen destination fields we had to fill with "N/A" to get the move through. */
  placeholderedFields: string[];
}> {
  const attempt = async (extraFields?: Record<string, MoveField>): Promise<Response> => {
    const fields = extraFields ? { ...args.mandatoryFields, ...extraFields } : args.mandatoryFields;
    return jiraFetch('/rest/api/3/bulk/issues/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sendBulkNotification: false,
        targetToSourcesMapping: {
          [args.destProjectId + ',' + args.destIssueTypeId]: {
            inferClassificationDefaults: true,
            inferFieldDefaults: false,
            inferStatusDefaults: true,
            inferSubtaskTypeDefault: true,
            issueIdsOrKeys: [args.sourceKey],
            targetMandatoryFields: [{ fields }],
          },
        },
      }),
    });
  };

  let resp = await attempt();
  let placeholderedFields: string[] = [];

  if (!resp.ok) {
    const firstBody = await resp.text();
    const missing = missingMandatoryFieldNames(parseMoveErrorMessages(firstBody));
    if (missing.length === 0) {
      throw new Error('Jira bulk-move failed (HTTP ' + resp.status + '): ' + firstBody);
    }

    const { fields, filled, unsatisfiable } = await placeholdersForRequiredFields(
      missing,
      new Set(Object.keys(args.mandatoryFields)),
    );
    if (unsatisfiable.length > 0) {
      throw new Error(
        `Jira won't accept the move: the destination requires ${unsatisfiable.join(', ')} — ` +
        `field(s) that aren't on its create screen, so the panel can't collect them, and that ` +
        `can't be filled blind. A Jira admin needs to un-require them in the destination's field ` +
        `configuration. Until then, move this one by hand (ticket ⋯ menu → Move) — the Jira UI ` +
        `doesn't enforce off-screen required fields.`,
      );
    }

    resp = await attempt(fields);
    if (!resp.ok) {
      const secondBody = await resp.text();
      throw new Error(
        `Jira won't accept the move even with placeholder values for ${filled.join(', ')}. ` +
        `Move this one by hand (ticket ⋯ menu → Move) and ask a Jira admin to un-require those ` +
        `fields in the destination's field configuration. Raw response: ${secondBody}`,
      );
    }
    placeholderedFields = filled;
  }

  const data = await resp.json().catch(() => ({}));
  return { taskId: (data as any).taskId || null, placeholderedFields };
}

export const MOVE_FIELDS = {
  SUMMARY: 'summary',
  IDENTITY_ID: 'customfield_11458',
  ACCOUNT_ID: 'customfield_14401',
  CLIENT_STATUS: 'customfield_11752',
  PROBLEM_AREA: 'customfield_10334',
} as const;

// ============ REIMB ticket creation (Overpayment Triage step 4) ============
// Constants mirror v3's Apps Script bridge so the REIMB tickets created from the extension
// look identical to the ones v3 creates.

export const REIMB_TIER_IDS = {
  Premium: '13704',
  Core: '13705',
  Generation: '18270',
} as const;

export const REIMB_APPROVERS = {
  luke:   { name: 'Luke Gazmin',  accountId: '712020:9afdb43a-362c-4a1e-a2bd-99df2619b105' },
  amanda: { name: 'Amanda Burke', accountId: '62006b10ed02400069a11d5a' },
} as const;

export interface CreateReimbArgs {
  wocooTicketId: string;
  identityId: string;
  amount: number;
  accountId: string;
  approver: keyof typeof REIMB_APPROVERS;
  tier: keyof typeof REIMB_TIER_IDS;
  summary?: string;
}

/** Create a REIMB ticket. Returns the new key (e.g. "REIMB-12345"). */
export async function createReimbTicket(args: CreateReimbArgs): Promise<{ key: string; url: string }> {
  const tierId = REIMB_TIER_IDS[args.tier];
  if (!tierId) throw new Error(`Unknown tier: ${args.tier}`);
  const approverInfo = REIMB_APPROVERS[args.approver];
  if (!approverInfo) throw new Error(`Unknown approver: ${args.approver}`);

  const description = `Hi team, can we please reimburse this client (${args.identityId}) for $${args.amount.toFixed(2)}? Reference: https://wealthsimple.atlassian.net/browse/${args.wocooTicketId}`;

  const payload = {
    fields: {
      project: { key: 'REIMB' },
      issuetype: { name: 'Reimbursement' },
      summary: args.summary ?? `Credit card overpayment reimbursement for ${args.wocooTicketId}`,
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] },
      priority: { name: 'Medium' },
      customfield_10082: args.accountId.toUpperCase(),
      customfield_10213: { id: '10340' },
      customfield_10285: args.amount,
      customfield_10287: { id: '13731' },
      customfield_10288: { id: '27321' },
      customfield_10315: { accountId: approverInfo.accountId },
      customfield_11416: { id: tierId },
      customfield_11458: args.identityId,
      customfield_12419: { id: '19303' },
    },
  };

  const resp = await jiraFetch('/rest/api/3/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`REIMB creation failed (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  if (!data.key) throw new Error('Jira returned no ticket key from REIMB creation.');
  return { key: data.key, url: `https://wealthsimple.atlassian.net/browse/${data.key}` };
}

// ============ Generic REIMB creation (Create REIMB Ticket modal) ============
// Parallel to createReimbTicket above. Kept separate so OverpaymentTriage's
// hardcoded fast-path and the new agent-filled modal can evolve independently.

export interface CreateReimbFromFormArgs {
  identityId: string;
  amount: number;
  accountId: string;
  tier: 'Core' | 'Premium' | 'Generation';
  approverAccountId: string;
  summary: string;
  description: string;
  currencyId: string;
  requestorTeamId: string;
  reimbursementReasonId: string;
  incidentRelatedId: string;
}

/** Create a REIMB ticket from explicit form values. Returns the new key + url. */
export async function createReimbTicketFromForm(args: CreateReimbFromFormArgs): Promise<{ key: string; url: string }> {
  const tierId = REIMB_TIER_IDS[args.tier];
  if (!tierId) throw new Error(`Unknown tier: ${args.tier}`);

  const payload = {
    fields: {
      project: { key: 'REIMB' },
      issuetype: { name: 'Reimbursement' },
      summary: args.summary,
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description }] }],
      },
      priority: { name: 'Medium' },
      customfield_10082: args.accountId.toUpperCase(),
      customfield_10213: { id: args.currencyId },
      customfield_10285: args.amount,
      customfield_10287: { id: args.requestorTeamId },
      customfield_10288: { id: args.reimbursementReasonId },
      customfield_10315: { accountId: args.approverAccountId },
      customfield_11416: { id: tierId },
      customfield_11458: args.identityId,
      customfield_12419: { id: args.incidentRelatedId },
    },
  };

  const resp = await jiraFetch('/rest/api/3/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`REIMB creation failed (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  if (!data.key) throw new Error('Jira returned no ticket key from REIMB creation.');
  return { key: data.key, url: `https://wealthsimple.atlassian.net/browse/${data.key}` };
}

// ============ Jira user search (for the REIMB modal's Approver "Other" picker) ============

export interface JiraUserSearchResult {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
}

/**
 * Search for Jira users via /rest/api/3/user/picker. Returns up to 10 matches.
 * Empty/whitespace query returns []. Caller is expected to debounce.
 */
export async function searchJiraUsers(query: string): Promise<JiraUserSearchResult[]> {
  if (!query.trim()) return [];
  const url = `/rest/api/3/user/picker?query=${encodeURIComponent(query)}&maxResults=10`;
  const resp = await jiraFetch(url);
  if (!resp.ok) throw new Error(`User search failed (HTTP ${resp.status})`);
  const data = await resp.json();
  return (data.users || []).map((u: any) => ({
    accountId: u.accountId,
    displayName: u.displayName,
    emailAddress: u.emailAddress,
    avatarUrl: u.avatarUrls?.['24x24'] ?? u.avatarUrl,
  }));
}

// ============ Comment posting (with @mention support) ============
// Used by Overpayment Triage step 6 to post a structured comment on the WOCOO ticket
// after the REIMB is created. Builds ADF (Atlassian Document Format) so @mentions render
// as real, clickable mentions and the REIMB key becomes a clickable link.

export interface CommentSegment {
  type: 'text' | 'mention' | 'link' | 'smartcard';
  text: string;
  /** For mention: the mentioned user's accountId. */
  accountId?: string;
  /** For link and smartcard: the URL. */
  href?: string;
}

/**
 * Post a comment to a Jira issue, with optional @mention, link, and smartcard segments.
 *
 * Inline segments (text / mention / link) are grouped into a single paragraph.
 * A `smartcard` segment is emitted as its own `blockCard` ADF block — Jira auto-fetches
 * the URL's metadata and renders it as a rich unfurled card (title, favicon, description)
 * instead of a plain hyperlink. Prefer this for cross-system links (i2c JSM, Confluence,
 * etc.) where the smart card gives more context than the raw URL.
 */
export async function postComment(ticketKey: string, segments: CommentSegment[]): Promise<void> {
  const blocks: unknown[] = [];
  let currentParagraph: unknown[] = [];
  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      blocks.push({ type: 'paragraph', content: currentParagraph });
      currentParagraph = [];
    }
  };
  for (const s of segments) {
    if (s.type === 'smartcard' && s.href) {
      flushParagraph();
      blocks.push({ type: 'blockCard', attrs: { url: s.href } });
    } else if (s.type === 'mention' && s.accountId) {
      currentParagraph.push({ type: 'mention', attrs: { id: s.accountId, text: s.text } });
    } else if (s.type === 'link' && s.href) {
      currentParagraph.push({ type: 'text', text: s.text, marks: [{ type: 'link', attrs: { href: s.href } }] });
    } else {
      currentParagraph.push({ type: 'text', text: s.text });
    }
  }
  flushParagraph();
  if (blocks.length === 0) blocks.push({ type: 'paragraph', content: [] });

  const payload = {
    body: { type: 'doc', version: 1, content: blocks },
  };
  const resp = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Comment post failed (HTTP ${resp.status}): ${txt}`);
  }
}

/** Build a MoveField from a single string value, the shape bulk-issues-move expects. */
export function rawField(value: string): MoveField {
  return { retain: false, type: 'raw', value: [value] };
}

/** Build a MoveField for a rich-text (ADF-only) custom field. Wraps the plain
 *  string in a minimal ADF document — one paragraph, one text run. Use for
 *  Jira paragraph-type custom fields that reject `raw` input.
 *  An empty value produces a paragraph node with no text (Jira accepts this).
 *  Note: `value` is the ADF doc directly (not wrapped in an array) — this is
 *  the MandatoryFieldValueForADF shape from Atlassian's OpenAPI schema. */
export function adfField(value: string): MoveField {
  const trimmed = value.trim();
  const content = trimmed
    ? [{ type: 'paragraph', content: [{ type: 'text', text: value }] }]
    : [{ type: 'paragraph' }];
  return {
    retain: false,
    type: 'adf',
    value: { type: 'doc', version: 1, content },
  };
}

/**
 * Transition a Jira issue to a new state by transition ID.
 * Common transition IDs in WOCOO:
 *   - 251: Move to Done
 *   - 201: Cancel request → status "Cancelled/ No Action"
 * Returns void on success (Jira returns 204 No Content).
 *
 * On success this ALSO emits a ticketTransition event so the Phase 1 Capture flow
 * can log a row. The transition ID → kind mapping is intentionally minimal:
 * ID '251' -> 'Done'; anything else -> 'Cancelled' by default. If more transitions
 * are ever wired through this function that are NOT terminal (e.g. re-open), the
 * caller must guard the emit itself; today all callers use terminal transitions.
 */
export async function transitionTicket(ticketKey: string, transitionId: string): Promise<void> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Transition failed (HTTP ' + resp.status + '): ' + txt);
  }
  // Emit for the Phase 1 Capture flow. Lazy-import to avoid a hard dependency from
  // the API layer into the sidepanel layer — the sidepanel-only bus is a no-op in
  // any hypothetical non-sidepanel caller.
  //
  // Gate on WOCOO- prefix so incidental transitions on non-WOCOO tickets (e.g. the
  // Clone/Move flow transitions its own CRED/DBO/EOC clone to Done — that's not a
  // resolution the log should capture) don't create noise rows. The source WOCOO
  // ticket's Move is logged separately via emitMoveTransition from MoveModal.
  if (ticketKey.startsWith('WOCOO-')) {
    try {
      const { emitTicketTransition } = await import('../sidepanel/ticketLogEvents');
      const kind = transitionId === '251' ? 'Done' : 'Cancelled';
      emitTicketTransition({ ticketId: ticketKey, kind, source: 'sidepanel' });
    } catch (e) {
      console.debug('[jira.transitionTicket] event emit failed (non-fatal):', e);
    }
  }
}

/** Walk a ticket through a chain of intermediate status names, firing whatever
 *  transition is available at each step to reach the next status. Useful when the
 *  desired end state isn't reachable in a single hop from the current state (Jira
 *  workflows often force intermediates — e.g. Triage → Back Office → External Review).
 *
 *  Each entry in `path` is the DESTINATION status you want to reach next; the actual
 *  transition name can differ (e.g. "Request reviewed" → Back Office). We match by
 *  destination-status name via transitionTicketByName. A short delay between hops lets
 *  Jira reflect the new state before we re-query the available transitions. */
export async function transitionTicketThroughPath(ticketKey: string, ...path: string[]): Promise<void> {
  for (let i = 0; i < path.length; i++) {
    // Skip a hop if the ticket is already sitting at that destination status — makes
    // the chain idempotent so a retry from a partially-transitioned state works.
    const { status: currentStatus } = await getIssueStatusAndComments(ticketKey);
    if (currentStatus && currentStatus.toLowerCase() === path[i].toLowerCase()) {
      continue;
    }
    await transitionTicketByName(ticketKey, path[i]);
    if (i < path.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Transition a ticket by matching the transition's name (case-insensitive) or the
 *  destination status name. Useful when we don't have the transition ID hardcoded —
 *  IDs vary across Jira instances and can be renumbered, but names are stable. */
export async function transitionTicketByName(ticketKey: string, transitionName: string): Promise<void> {
  const cloudId = await getCloudId();
  const token = await getValidAccessToken();
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`;
  const listResp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!listResp.ok) {
    const txt = await listResp.text();
    throw new Error(`Failed to list transitions for ${ticketKey} (HTTP ${listResp.status}): ${txt}`);
  }
  const data = await listResp.json().catch(() => ({} as any));
  const transitions: Array<{ id: string; name?: string; to?: { name?: string } }> = Array.isArray((data as any).transitions) ? (data as any).transitions : [];
  const needle = transitionName.toLowerCase();
  const found = transitions.find((t) =>
    (t.name || '').toLowerCase() === needle
    || (t.to?.name || '').toLowerCase() === needle,
  );
  if (!found) {
    const available = transitions.map((t) => `"${t.name}"→${t.to?.name || '?'}`).join(', ');
    throw new Error(`Transition "${transitionName}" not available for ${ticketKey}. Available: ${available || '(none)'}`);
  }
  await transitionTicket(ticketKey, found.id);
}

// ============ Clone + issue-link helpers (used by Clone/Move flow) ============
// Jira REST has no first-class "clone" endpoint — the UI's Clone action just creates a
// new issue copying summary/description/issuetype/priority/labels and adds a Cloners link.
// We mirror that.

/**
 * Clone a Jira issue: create a new issue in the same project copying the key fields,
 * with assignee=null and summary prefixed with "CLONE - ". Reporter is copied from source.
 * Returns the new key + URL.
 */
export async function cloneTicket(sourceKey: string): Promise<{ key: string; url: string }> {
  const cloudId = await getCloudId();
  const token = await getValidAccessToken();
  const srcUrl = new URL(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(sourceKey)}`);
  // WOCOO project has mandatory custom fields (Identity ID + Client Email + Tier); pull
  // those alongside the standard fields so the clone passes create validation.
  srcUrl.searchParams.set(
    'fields',
    [
      'project', 'issuetype', 'summary', 'description', 'priority', 'labels',
      FIELD_IDENTITY_ID, FIELD_CLIENT_EMAIL, FIELD_TIER,
      FIELD_ACCOUNT_ID_PRIMARY, FIELD_ACCOUNT_ID_FALLBACK,
    ].join(','),
  );
  const srcResp = await fetch(srcUrl.toString(), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!srcResp.ok) {
    const txt = await srcResp.text();
    throw new Error(`Clone source fetch failed (HTTP ${srcResp.status}): ${txt}`);
  }
  const src = await srcResp.json();
  const f = src.fields ?? {};

  const fields: Record<string, unknown> = {
    project: { key: f.project?.key },
    issuetype: { id: f.issuetype?.id },
    summary: `CLONE - ${f.summary ?? ''}`,
    assignee: null,
  };
  if (f.description) {
    // Flatten the source description's ADF to plain text and re-wrap in a minimal doc.
    // Copying the ADF verbatim breaks when the source description embeds attachments or
    // media nodes — Jira rejects the create call with "We don't recognise the format of
    // a file you added or the data in it" because the media IDs don't exist in the
    // clone's context. Plain text is safer than trying to sanitize the ADF tree, and a
    // clone's description doesn't need rich formatting.
    const text = adfToPlainText(f.description);
    if (text) {
      fields.description = {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      };
    }
  }
  if (f.priority?.id) fields.priority = { id: f.priority.id };
  if (Array.isArray(f.labels) && f.labels.length) fields.labels = f.labels;
  // Required custom fields — copy through verbatim if present on source.
  if (f[FIELD_IDENTITY_ID]) fields[FIELD_IDENTITY_ID] = f[FIELD_IDENTITY_ID];
  if (f[FIELD_CLIENT_EMAIL]) fields[FIELD_CLIENT_EMAIL] = f[FIELD_CLIENT_EMAIL];
  if (f[FIELD_TIER]) {
    // Tier is an option field — copy id/value as Jira returns it.
    const tier = f[FIELD_TIER];
    fields[FIELD_TIER] = typeof tier === 'object' && tier !== null ? { id: tier.id, value: tier.value } : tier;
  }
  if (f[FIELD_ACCOUNT_ID_PRIMARY]) fields[FIELD_ACCOUNT_ID_PRIMARY] = f[FIELD_ACCOUNT_ID_PRIMARY];
  if (f[FIELD_ACCOUNT_ID_FALLBACK]) fields[FIELD_ACCOUNT_ID_FALLBACK] = f[FIELD_ACCOUNT_ID_FALLBACK];

  const resp = await jiraFetch('/rest/api/3/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Clone creation failed (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  if (!data.key) throw new Error('Jira returned no key for clone.');
  return { key: data.key, url: `https://wealthsimple.atlassian.net/browse/${data.key}` };
}

/**
 * Link two issues via a named link type (e.g. "Cloners", "Blocks", "Relates").
 * Per Jira semantics: outwardIssue --[type.outward]--> inwardIssue.
 * For Cloners: type.outward = "clones", type.inward = "is cloned by".
 *   To express "clone clones original": outwardIssue = clone, inwardIssue = original.
 */
export async function linkIssues(outwardKey: string, inwardKey: string, linkTypeName: string): Promise<void> {
  const resp = await jiraFetch('/rest/api/3/issueLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: { name: linkTypeName },
      outwardIssue: { key: outwardKey },
      inwardIssue: { key: inwardKey },
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Issue link failed (HTTP ${resp.status}): ${txt}`);
  }
}

// Cache the resolved clone-link-type name for the session. The name varies by Jira
// instance ("Cloners", "Clones", or just "Clone") and can be renamed by admins, so we
// discover it at runtime instead of hardcoding.
let cachedCloneLinkTypeName: string | null = null;

async function discoverCloneLinkTypeName(): Promise<string> {
  if (cachedCloneLinkTypeName) return cachedCloneLinkTypeName;
  const resp = await jiraFetch('/rest/api/3/issueLinkType', { method: 'GET' });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Failed to list issue link types (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json().catch(() => ({} as any));
  const types: Array<{ name?: string }> = Array.isArray((data as any).issueLinkTypes) ? (data as any).issueLinkTypes : [];
  // Preferred names in priority order. If none match exactly, fall back to any type
  // whose name contains "clone".
  for (const pref of ['Cloners', 'Clones', 'Clone']) {
    const found = types.find((t) => (t.name || '').toLowerCase() === pref.toLowerCase());
    if (found?.name) { cachedCloneLinkTypeName = found.name; return found.name; }
  }
  const anyClone = types.find((t) => /clone/i.test(t.name || ''));
  if (anyClone?.name) { cachedCloneLinkTypeName = anyClone.name; return anyClone.name; }
  throw new Error("No 'clone'-family issue link type found on this Jira instance.");
}

/** Link `cloneKey` to `originalKey` with whatever clone-family link type the Jira
 *  instance has (Cloners / Clones / Clone). Discovers the name once per session. */
export async function linkAsClone(cloneKey: string, originalKey: string): Promise<void> {
  const name = await discoverCloneLinkTypeName();
  await linkIssues(cloneKey, originalKey, name);
}

/**
 * Find a clone the Clone/Move flow already created for `originalKey`: a same-project issue
 * on the other end of one of its links, summarised "CLONE - …". Lets a retry after a failed
 * move reuse that clone instead of leaving a second reporting artifact on the board — which
 * matters most across panel sessions, where the modal's in-memory handle is gone.
 *
 * Best-effort: any failure returns null and the caller clones fresh.
 */
export async function findExistingClone(
  originalKey: string,
): Promise<{ key: string; url: string; done: boolean } | null> {
  try {
    const resp = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(originalKey)}?fields=issuelinks`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const links: any[] = data?.fields?.issuelinks ?? [];
    const projectPrefix = originalKey.split('-')[0] + '-';
    for (const link of links) {
      const other = link?.outwardIssue ?? link?.inwardIssue;
      const key: string | undefined = other?.key;
      if (!key || !key.startsWith(projectPrefix)) continue;
      if (!/^CLONE - /.test(other?.fields?.summary ?? '')) continue;
      return {
        key,
        url: `https://wealthsimple.atlassian.net/browse/${key}`,
        done: (other?.fields?.status?.statusCategory?.key ?? '') === 'done',
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Minimal shape for the Home view ticket list — full WocooTicket is overkill for a list row.
export interface TicketRow {
  id: string;
  summary: string;
  issueType: string;
  status: string;
  priority: WocooTicket['priority'];
  tier: WocooTicket['tier'];
  updated: string;
  // ISO timestamp of the last status-category transition (Triage → Back Office → Done).
  // Used by Home to show "Nd" — days sitting in the current swimlane.
  statusCategoryChangedAt: string;
}

/**
 * Run a JQL search; returns up to `maxResults` ticket rows. Defaults to 50.
 *
 * Uses the new `/rest/api/3/search/jql` endpoint — the old `/rest/api/3/search` was
 * removed (HTTP 410) per Atlassian CHANGE-2046. The new endpoint is POST-only and uses
 * token-based pagination (`nextPageToken`) instead of `startAt`.
 */
export async function searchTickets(jql: string, maxResults = 50): Promise<TicketRow[]> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jql,
      maxResults,
      fields: ['summary', 'status', 'priority', 'issuetype', 'updated', 'statuscategorychangedate', FIELD_TIER],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Jira search failed (HTTP ' + resp.status + '): ' + txt);
  }
  const data = await resp.json();
  return (data.issues || []).map((issue: any) => {
    const f = issue.fields || {};
    const tierField = f[FIELD_TIER];
    const tier: WocooTicket['tier'] =
      typeof tierField === 'string'
        ? (tierField as WocooTicket['tier']) || 'Core'
        : (tierField?.value as WocooTicket['tier']) || 'Core';
    const priorityName = (f.priority?.name || 'Medium') as WocooTicket['priority'];
    return {
      id: issue.key,
      summary: f.summary || '',
      issueType: f.issuetype?.name || 'Other',
      status: f.status?.name || 'Unknown',
      priority: ['Highest', 'High', 'Medium', 'Low', 'Lowest'].includes(priorityName) ? priorityName : 'Medium',
      tier,
      updated: f.updated || new Date().toISOString(),
      // Falls back to `created` when a ticket has never transitioned categories.
      statusCategoryChangedAt: f.statuscategorychangedate || f.created || f.updated || new Date().toISOString(),
    };
  });
}

/**
 * Fetch all comments on a Jira issue as plain text. Used by the Wires Pending Posting
 * assistant to scan for a "complete" marker on hyperlinked Atlassian rows.
 */
export async function getIssueComments(ticketKey: string): Promise<string[]> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`,
  );
  url.searchParams.set('maxResults', '100');
  const resp = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`getIssueComments failed (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  const comments = (data.comments || []) as Array<{ body: unknown }>;
  return comments.map((c) => adfToPlainText(c.body));
}

/**
 * Fetch issue status name + all comments in a single round trip. Used by the
 * Wires Pending Posting flow where we want to mark a row posted if the BOSM
 * ticket is Done OR has a "complete" comment.
 */
export async function getIssueStatusAndComments(ticketKey: string): Promise<{ status: string; comments: string[] }> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}`,
  );
  url.searchParams.set('fields', 'status,comment');
  const resp = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`getIssueStatusAndComments failed (HTTP ${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  const status = data.fields?.status?.name || '';
  const rawComments = (data.fields?.comment?.comments || []) as Array<{ body: unknown }>;
  const comments = rawComments.map((c) => adfToPlainText(c.body));
  return { status, comments };
}

/** Flatten ADF (Atlassian Document Format) or a plain string into a single text blob. */
function adfToPlainText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return '';
  const parts: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(body);
  return parts.join(' ');
}

/** Extract a WOCOO/etc Jira issue key from a wealthsimple.atlassian.net URL. */
export function extractJiraKeyFromUrl(url: string): string | null {
  const m = url.match(/wealthsimple\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

interface JiraMyself { accountId: string; displayName: string; emailAddress?: string }
let cachedMyself: JiraMyself | null = null;

/** Fetch + cache the current Atlassian user's profile. Used for fields like the move-log
 *  operatorName so the sheet records who performed the action. */
export async function getMyself(): Promise<JiraMyself> {
  if (cachedMyself) return cachedMyself;
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const resp = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error('getMyself failed (HTTP ' + resp.status + ')');
  cachedMyself = await resp.json();
  return cachedMyself!;
}

/** Fetch a Jira issue and map it into the WocooTicket shape the panel expects. */
export async function getTicket(ticketKey: string): Promise<WocooTicket> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}`,
  );
  url.searchParams.set(
    'fields',
    [
      'summary',
      'description',
      'status',
      'priority',
      'issuetype',
      'created',
      'reporter',
      'assignee',
      'comment',
      'attachment',
      FIELD_IDENTITY_ID,
      FIELD_TIER,
      FIELD_ACCOUNT_ID_PRIMARY,
      FIELD_ACCOUNT_ID_FALLBACK,
      FIELD_CLIENT_EMAIL,
      FIELD_TOTAL_REIMB_AMOUNT,
    ].join(','),
  );

  const resp = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Jira getTicket failed (HTTP ' + resp.status + '): ' + txt);
  }
  const data = await resp.json();
  return mapJiraIssue(ticketKey, data);
}

function mapJiraIssue(key: string, data: any): WocooTicket {
  const f = data.fields ?? {};
  const statusName = (f.status?.statusCategory?.name || f.status?.name || '').toLowerCase();
  const priorityName = (f.priority?.name || 'Medium') as WocooTicket['priority'];

  let status: WocooTicket['status'] = 'Other';
  if (/triage|to do|new/i.test(f.status?.name || '')) status = 'Triage';
  else if (/back office/i.test(f.status?.name || '')) status = 'Back Office';
  else if (/pending/i.test(f.status?.name || '') || statusName === 'in progress') status = 'Pending';
  else if (statusName === 'done') status = 'Done';
  else if (/cancel/i.test(f.status?.name || '')) status = 'Cancelled';

  const description = extractDescription(f.description) || '';

  const accountId = (f[FIELD_ACCOUNT_ID_PRIMARY] || f[FIELD_ACCOUNT_ID_FALLBACK] || '').toString().trim();
  const identityId = (f[FIELD_IDENTITY_ID] || '').toString().trim();
  const tierField = f[FIELD_TIER];
  const tier: WocooTicket['tier'] =
    typeof tierField === 'string'
      ? (tierField as WocooTicket['tier']) || 'Core'
      : (tierField?.value as WocooTicket['tier']) || 'Core';
  const clientEmail = (f[FIELD_CLIENT_EMAIL] || '').toString();

  const recentComments = (f.comment?.comments ?? []).slice(-3).map((c: any) => ({
    author: c.author?.displayName || 'Unknown',
    timestamp: c.created || c.updated || new Date().toISOString(),
    body: extractDescription(c.body) || '',
  }));

  // Total Reimbursement Amount is usually stored as a negative number on overpayment
  // tickets (it mirrors the credit balance on the card), so normalise to a magnitude.
  const rawAmount = f[FIELD_TOTAL_REIMB_AMOUNT];
  let totalReimbursementAmount: number | null = null;
  if (typeof rawAmount === 'number' && isFinite(rawAmount) && rawAmount !== 0) {
    totalReimbursementAmount = Math.abs(rawAmount);
  } else if (typeof rawAmount === 'string') {
    const n = parseFloat(rawAmount.replace(/[$,\s]/g, ''));
    if (isFinite(n) && n !== 0) totalReimbursementAmount = Math.abs(n);
  }

  return {
    id: key,
    summary: f.summary || '',
    description,
    status,
    priority: ['Highest', 'High', 'Medium', 'Low', 'Lowest'].includes(priorityName) ? priorityName : 'Medium',
    workType: f.issuetype?.name || 'Other',
    category: f.issuetype?.name || 'Other',
    identityId,
    accountId,
    clientEmail,
    tier,
    totalReimbursementAmount,
    attachmentCount: Array.isArray(f.attachment) ? f.attachment.length : 0,
    reporter: f.reporter?.displayName || 'Unknown',
    reporterAccountId: f.reporter?.accountId,
    assignee: f.assignee?.displayName || 'Unassigned',
    created: f.created || new Date().toISOString(),
    recentComments,
    zendeskTranscript: {
      // Phase B-1 doesn't include Zendesk scraping; the panel will fall back to a
      // "couldn't auto-capture" state once the transcript card is wired to live data.
      state: 'partial',
    },
  };
}

/** Convert Atlassian's ADF (Atlassian Document Format) JSON to plain text, best-effort. */
function extractDescription(adfOrString: any): string {
  if (!adfOrString) return '';
  if (typeof adfOrString === 'string') return adfOrString;
  // ADF: walk content nodes and pull text. Lossy but adequate for triage UI.
  const parts: string[] = [];
  function walk(node: any) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (node.type === 'text' && typeof node.text === 'string') {
        parts.push(node.text);
      } else if (node.type === 'hardBreak') {
        parts.push('\n');
      } else if (node.content) {
        walk(node.content);
        if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') {
          parts.push('\n');
        }
      }
    }
  }
  walk(adfOrString);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Attach a file to a Jira issue. Jira's attachment endpoint needs multipart/form-data
 * plus the `X-Atlassian-Token: no-check` XSRF opt-out, and the Content-Type boundary
 * must be set by fetch (so don't pass Content-Type explicitly).
 */
export async function addAttachment(ticketKey: string, fileName: string, blob: Blob): Promise<void> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const form = new FormData();
  form.append('file', blob, fileName);
  const resp = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/attachments`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: form,
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Attachment upload failed (HTTP ${resp.status})${body ? ': ' + body.slice(0, 200) : ''}`);
  }
}

/** base64 (as returned by the GAS bridge) → Blob, for addAttachment. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
