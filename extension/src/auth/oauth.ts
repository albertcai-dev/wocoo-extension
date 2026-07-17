// Atlassian OAuth 2.0 (3LO) flow with PKCE for the Chrome extension.
// Public-client pattern — no client secret. Standard for browser/native apps.
//
// Flow:
//   1. Generate PKCE verifier + challenge.
//   2. chrome.identity.launchWebAuthFlow → user signs in at auth.atlassian.com.
//   3. Atlassian redirects back to `https://<ext-id>.chromiumapp.org/?code=...`.
//   4. We exchange code + verifier for access_token + refresh_token.
//   5. Store tokens in chrome.storage.local.

import { CLIENT_ID, CLIENT_SECRET } from './config';

const AUTH_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const AUDIENCE = 'api.atlassian.com';
const SCOPES = ['read:jira-work', 'write:jira-work', 'offline_access'].join(' ');

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const STORAGE_KEY = 'atlassian_tokens';

export async function getStoredTokens(): Promise<TokenSet | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? null;
}

async function storeTokens(tokens: TokenSet): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: tokens });
}

export async function clearTokens(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/** Launch the interactive OAuth flow. Returns the token set on success. */
export async function signIn(): Promise<TokenSet> {
  if (!CLIENT_ID) {
    throw new Error('CLIENT_ID not configured. Edit src/auth/config.ts.');
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const codeVerifier = randomString(64);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const state = randomString(16);

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('audience', AUDIENCE);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const redirected = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirected) throw new Error('OAuth flow cancelled or returned no redirect URL.');

  const url = new URL(redirected);
  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) throw new Error('Atlassian OAuth error: ' + error);
  if (!code) throw new Error('No authorization code in redirect URL.');
  if (returnedState !== state) throw new Error('OAuth state mismatch — possible replay.');

  return exchangeCodeForTokens(code, codeVerifier, redirectUri);
}

async function exchangeCodeForTokens(code: string, codeVerifier: string, redirectUri: string): Promise<TokenSet> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Token exchange failed (' + resp.status + '): ' + txt);
  }
  const data = await resp.json();
  const tokens: TokenSet = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  await storeTokens(tokens);
  return tokens;
}

async function refreshTokens(): Promise<TokenSet> {
  const existing = await getStoredTokens();
  if (!existing?.refreshToken) throw new Error('No refresh token; need to sign in again.');

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: existing.refreshToken,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    await clearTokens(); // refresh failed — force re-sign-in
    throw new Error('Token refresh failed (' + resp.status + '): ' + txt);
  }
  const data = await resp.json();
  const next: TokenSet = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? existing.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  await storeTokens(next);
  return next;
}

/** Get a valid access token, refreshing if it's expired or near-expired. Throws if not signed in. */
export async function getValidAccessToken(): Promise<string> {
  const stored = await getStoredTokens();
  if (!stored) throw new Error('Not signed in.');
  // Refresh 60s before expiry to avoid race conditions
  if (Date.now() >= stored.expiresAt - 60_000) {
    const fresh = await refreshTokens();
    return fresh.accessToken;
  }
  return stored.accessToken;
}

// ---------- PKCE helpers ----------

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
