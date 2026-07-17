// OAuth client config for Atlassian 3LO.
//
// Atlassian's OAuth 2.0 (3LO) requires BOTH client_id and client_secret in the token exchange,
// even when PKCE is used (PKCE is additive, not a replacement). For an internal sideloaded
// extension distributed to a handful of teammates, embedding the secret in the bundle is an
// acceptable trade-off — anyone with access to the unpacked extension's files could read it,
// but distribution is limited to internal users we trust.
//
// Values are loaded from Vite env variables at build time (see .env / .env.example).
// The .env file is git-ignored — pull real values from 1Password / share via secure channel.
//
// If this ever becomes a public-facing extension or distributed more broadly, the secret should
// move to a backend proxy (e.g. the existing Apps Script bridge).

export const CLIENT_ID = import.meta.env.VITE_ATLASSIAN_CLIENT_ID as string;
export const CLIENT_SECRET = import.meta.env.VITE_ATLASSIAN_CLIENT_SECRET as string;

if (!CLIENT_ID || !CLIENT_SECRET) {
  // Fail loudly at load time rather than silently 400ing on the first OAuth call.
  throw new Error(
    'Missing Atlassian OAuth config. Create extension/.env with VITE_ATLASSIAN_CLIENT_ID and ' +
    'VITE_ATLASSIAN_CLIENT_SECRET (see .env.example) and rebuild the extension.',
  );
}
