// When the user switches the Sidekick Agent on, Sidekick checks that the Okta-backed sites the
// agent reads (KOHO Admin, Atlas) are signed in, and leaves a tab open on any that is not, for
// the user to sign in. These helpers decide, from what a tab shows, whether it is signed in.

export type LoginSite = 'atlas' | 'koho';
export type LoginStatus = 'in' | 'out' | 'unknown';

export const LOGIN_SITE_URLS: Record<LoginSite, string> = {
  atlas: 'https://atlas.wealthsimple.com/',
  koho: 'https://admin.koho.ca/',
};

export const LOGIN_SITE_NAMES: Record<LoginSite, string> = { atlas: 'Atlas', koho: 'KOHO' };

/** What a probe tab shows. `text` and `hasKohoSearch` are only readable on the site's own host. */
export interface LoginProbe {
  url: string;
  text?: string;
  hasKohoSearch?: boolean;
}

function host(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Signed in, signed out (a sign-in page is showing), or can't tell yet. */
export function classifyLogin(site: LoginSite, probe: LoginProbe): LoginStatus {
  const h = host(probe.url);
  if (/(^|\.)okta(preview)?\.com$/.test(h)) return 'out'; // Okta wants a password / MFA
  const text = (probe.text ?? '').replace(/\s+/g, ' ');
  if (site === 'atlas') {
    if (h !== 'atlas.wealthsimple.com') return 'unknown';
    let path = '';
    try { path = new URL(probe.url).pathname; } catch { /* keep '' */ }
    if (/^\/login(\/|$)/.test(path) || /login with okta/i.test(text)) return 'out';
    return text.trim().length > 0 ? 'in' : 'unknown';
  }
  if (h !== 'admin.koho.ca') return 'unknown';
  if (probe.hasKohoSearch) return 'in';
  if (/continue with sso|use email\/password|sign in to/i.test(text)) return 'out';
  return 'unknown';
}

/** One line for Settings, e.g. "Atlas ✓ · KOHO: sign-in needed (tab opened)". */
export function loginSummary(results: Partial<Record<LoginSite, LoginStatus | 'checking' | 'error'>>): string {
  return (Object.keys(LOGIN_SITE_NAMES) as LoginSite[])
    .filter((s) => results[s] !== undefined)
    .map((s) => {
      const name = LOGIN_SITE_NAMES[s];
      switch (results[s]) {
        case 'checking': return `${name}: checking…`;
        case 'in': return `${name} ✓`;
        case 'out': return `${name}: sign-in needed (tab opened)`;
        case 'error': return `${name}: couldn't check`;
        default: return `${name}: check the tab that opened`;
      }
    })
    .join(' · ');
}
