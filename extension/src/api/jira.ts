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

/** Common move target field shape used by the bulk-issues-move endpoint. */
type MoveField = { retain: false; type: 'raw'; value: string[] };

/**
 * Perform a Jira bulk-issues-move from a WOCOO ticket to another project.
 * Returns the optional taskId Jira gives back for tracking the async move.
 */
export async function moveTicket(args: {
  sourceKey: string;
  destProjectId: string;
  destIssueTypeId: string;
  mandatoryFields: Record<string, MoveField>;
}): Promise<{ taskId: string | null }> {
  const mapping: Record<string, any> = {};
  mapping[args.destProjectId + ',' + args.destIssueTypeId] = {
    inferClassificationDefaults: true,
    inferFieldDefaults: false,
    inferStatusDefaults: true,
    inferSubtaskTypeDefault: true,
    issueIdsOrKeys: [args.sourceKey],
    targetMandatoryFields: [{ fields: args.mandatoryFields }],
  };
  const resp = await jiraFetch('/rest/api/3/bulk/issues/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sendBulkNotification: false, targetToSourcesMapping: mapping }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Jira bulk-move failed (HTTP ' + resp.status + '): ' + txt);
  }
  const data = await resp.json().catch(() => ({}));
  return { taskId: (data as any).taskId || null };
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

/**
 * Transition a Jira issue to a new state by transition ID.
 * Common transition IDs in WOCOO:
 *   - 251: Move to Done
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

  const rawAmount = f[FIELD_TOTAL_REIMB_AMOUNT];
  let totalReimbursementAmount: number | null = null;
  if (typeof rawAmount === 'number' && isFinite(rawAmount) && rawAmount > 0) {
    totalReimbursementAmount = rawAmount;
  } else if (typeof rawAmount === 'string') {
    const n = parseFloat(rawAmount);
    if (isFinite(n) && n > 0) totalReimbursementAmount = n;
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
