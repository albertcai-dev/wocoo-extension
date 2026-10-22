// The local draft agent opens a client in i2c the way Sidekick's i2c button does: email into
// Customer Search, that section's Search, the right card on Product Search Result, the
// account's Select box, Continue with this Customer. It starts the chain with one window
// message from its own tab; content/i2c.ts runs the steps, carrying the chain across page
// loads in that tab's sessionStorage (never chrome.storage, which every i2c tab would see).

import type { CardProduct } from './i2cProductSelect';

export const AGENT_I2C_MSG = 'wocoo-agent:i2c-open-customer';
/** sessionStorage: the chain in progress, and the last result (re-published on each load). */
export const AGENT_I2C_CHAIN_KEY = 'wocoo-agent-i2c-chain';
export const AGENT_I2C_RESULT_KEY = 'wocoo-agent-i2c-result';
/** Attribute on <html> carrying the JSON result for the agent to read. */
export const AGENT_I2C_RESULT_ATTR = 'data-wocoo-i2c-result';

/** A chain older than this is abandoned (closed tab, i2c hang). */
export const AGENT_I2C_CHAIN_MAX_AGE_MS = 3 * 60_000; // login + search + card + page

export type AgentI2cStep = 'search' | 'after-search' | 'continue' | 'done' | 'page';

/** The pages the user reads; the chain opens one of them after Continue with this Customer. */
export const AGENT_I2C_PAGES = ['Account Transactions', 'Declined Transactions', 'Manage Card Tokens'] as const;
export type AgentI2cPage = typeof AGENT_I2C_PAGES[number];

/** Logins the chain may do on its own before giving up. */
export const AGENT_I2C_MAX_LOGINS = 2;

export interface AgentI2cChain {
  email: string;
  product: CardProduct;
  page?: AgentI2cPage;
  startedAt: number;
  step: AgentI2cStep;
  logins?: number;
}

export interface AgentI2cResult {
  state: 'running' | 'done' | 'stopped';
  step?: AgentI2cStep;
  reason?: string;
  /** On a stop at Product Search Result: the rows, for the agent to choose by hand. */
  products?: Array<{ program: string; category: string; status: string; card: string }>;
  at: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** null: not an agent i2c request; { error }: malformed; else the request. */
export function parseAgentI2cRequest(data: unknown): { email: string; product: CardProduct; page?: AgentI2cPage } | { error: string } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== AGENT_I2C_MSG) return null;
  const email = typeof d.email === 'string' ? d.email.trim() : '';
  if (!EMAIL_RE.test(email)) return { error: 'bad email' };
  if (d.product !== 'credit' && d.product !== 'prepaid') return { error: 'product must be credit or prepaid' };
  if (d.page !== undefined && !(AGENT_I2C_PAGES as readonly unknown[]).includes(d.page)) {
    return { error: `page must be one of ${AGENT_I2C_PAGES.join(', ')}` };
  }
  return d.page ? { email, product: d.product, page: d.page as AgentI2cPage } : { email, product: d.product };
}

/** i2c pages that mean "no usable session here": the chain goes to the Wealthsimple login. */
export function isSessionErrorPage(bodyText: string): boolean {
  return /Invalid Session|session has expired|You are not logged in|Instance Not Configured|another tab has been opened|do not have enough privileges/i.test(bodyText);
}

/** i2c's "another session is signed in" page (Kill All / Kill Session). Not just any page
 *  mentioning "Manage Sessions": the redesigned sidebar links to it on every page, which made
 *  the agent chain wait on Customer Search for a Kill All that never came (2026-10-21). */
export function isManageSessionsPage(bodyText: string): boolean {
  return /Manage Sessions/i.test(bodyText) && /another user[\s\S]*?logged in/i.test(bodyText);
}

/** The stored chain if it is well-formed and fresh, else null. */
export function readChain(raw: string | null, now: number): AgentI2cChain | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as AgentI2cChain;
    if (typeof c.email !== 'string' || (c.product !== 'credit' && c.product !== 'prepaid')) return null;
    if (typeof c.startedAt !== 'number' || now - c.startedAt > AGENT_I2C_CHAIN_MAX_AGE_MS || now < c.startedAt - 60_000) return null;
    if (!['search', 'after-search', 'continue', 'done', 'page'].includes(c.step)) return null;
    return c;
  } catch {
    return null;
  }
}
