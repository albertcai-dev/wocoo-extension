// One-message helpers for the local draft agent on KOHO Admin and Atlas, like the i2c chain
// (i2cAgentChain.ts): the agent posts a window message from its own tab (sessionStorage
// 'wocoo-agent' = '1'), the site's content script runs Sidekick's existing code for it and
// publishes a JSON result on <html> for the agent to poll.

export const AGENT_KOHO_MSG = 'wocoo-agent:koho-open-user';
export const AGENT_KOHO_CHAIN_KEY = 'wocoo-agent-koho-chain';
export const AGENT_KOHO_RESULT_KEY = 'wocoo-agent-koho-result';
export const AGENT_KOHO_RESULT_ATTR = 'data-wocoo-koho-result';
export const AGENT_KOHO_CHAIN_MAX_AGE_MS = 3 * 60_000;
/** The KOHO page the agent reads transactions on (navigation notes: never Transactions Feed). */
export const KOHO_TRANSACTIONS_PAGE = 'CST Transactions (Galileo)';

export const AGENT_ATLAS_LOOKUP_MSG = 'wocoo-agent:atlas-lookup';
export const AGENT_ATLAS_CIM_MSG = 'wocoo-agent:atlas-card-issuance';
export const AGENT_ATLAS_RESULT_ATTR = 'data-wocoo-atlas-result';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDENTITY_RE = /^identity[-_][A-Za-z0-9_-]+$/;

export type KohoStep = 'sso' | 'search' | 'after-search' | 'page' | 'done';

export interface KohoChain {
  email: string;
  /** The user's work email for KOHO's "Continue with SSO" screen (never hardcoded here). */
  ssoEmail?: string;
  startedAt: number;
  step: KohoStep;
  ssoTries?: number;
  /** When the step last changed, for "stuck on this step" timeouts. */
  stepAt?: number;
}

export interface SiteResult {
  state: 'running' | 'done' | 'stopped';
  step?: string;
  reason?: string;
  at: number;
  [k: string]: unknown;
}

function asRecord(d: unknown): Record<string, unknown> | null {
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
}

/** null: not a KOHO agent request; { error }: malformed; else the request. */
export function parseKohoRequest(data: unknown): { email: string; ssoEmail?: string } | { error: string } | null {
  const d = asRecord(data);
  if (!d || d.type !== AGENT_KOHO_MSG) return null;
  const email = typeof d.email === 'string' ? d.email.trim() : '';
  if (!EMAIL_RE.test(email)) return { error: 'bad email' };
  const sso = typeof d.ssoEmail === 'string' ? d.ssoEmail.trim() : '';
  if (sso && !EMAIL_RE.test(sso)) return { error: 'bad ssoEmail' };
  return sso ? { email, ssoEmail: sso } : { email };
}

export function readKohoChain(raw: string | null, now: number): KohoChain | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as KohoChain;
    if (typeof c.email !== 'string' || typeof c.startedAt !== 'number') return null;
    if (now - c.startedAt > AGENT_KOHO_CHAIN_MAX_AGE_MS || now < c.startedAt - 60_000) return null;
    if (!['sso', 'search', 'after-search', 'page', 'done'].includes(c.step)) return null;
    return c;
  } catch {
    return null;
  }
}

/** KOHO user pages live at /user/<id>/…; returns the id, or null off a user page. */
export function kohoUserId(pathname: string): string | null {
  const m = /^\/user\/([^/]+)/.exec(pathname);
  return m ? m[1] : null;
}

/** null: not an Atlas agent request; { error }: malformed; else the identity id. */
export function parseAtlasRequest(data: unknown, type: string): { identityId: string } | { error: string } | null {
  const d = asRecord(data);
  if (!d || d.type !== type) return null;
  const id = typeof d.identityId === 'string' ? d.identityId.trim() : '';
  return IDENTITY_RE.test(id) ? { identityId: id } : { error: 'bad identityId' };
}
