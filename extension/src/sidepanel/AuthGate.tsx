// Sign-in screen shown when no Atlassian OAuth token is stored.
// Calls signIn() which launches chrome.identity.launchWebAuthFlow.

import { useState } from 'react';
import { signIn } from '../auth/oauth';

export function AuthGate({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      onSignedIn();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 'var(--mint-sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)', maxWidth: 480, margin: '0 auto', paddingTop: 'var(--mint-sp-6)' }}>
      <h1 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 600 }}>Connect to Jira</h1>
      <p style={{ margin: 0, color: 'var(--mint-fg-subdued-title)', fontSize: 'var(--mint-text-meta)', lineHeight: 1.6 }}>
        WOCOO Triager uses your Atlassian account to load WOCOO tickets and (later) take actions on your behalf.
        Sign in once; your token stays on this device.
      </p>
      {error ? (
        <div
          role="alert"
          style={{
            background: 'var(--mint-negative-bg-soft)',
            color: 'var(--mint-negative-fg-strong)',
            border: 'var(--mint-card-stroke)',
            borderColor: 'var(--mint-negative-fg-graphic)',
            borderRadius: 'var(--mint-radius-button)',
            padding: 'var(--mint-sp-2) var(--mint-sp-3)',
            fontSize: 'var(--mint-text-micro)',
          }}
        >
          Sign-in failed: {error}
        </div>
      ) : null}
      <button
        onClick={handleSignIn}
        disabled={busy}
        style={{
          padding: '10px 16px',
          background: busy ? 'var(--mint-fg-inactive)' : 'var(--mint-fg-strong)',
          color: 'var(--mint-fg-inverted)',
          border: 'none',
          borderRadius: 'var(--mint-radius-button)',
          fontWeight: 600,
          fontSize: 'var(--mint-text-body)',
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Opening Atlassian sign-in…' : 'Sign in with Atlassian'}
      </button>
      <p style={{ margin: 0, color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-nano)' }}>
        Permissions requested: read &amp; write Jira tickets, refresh token (offline_access).
      </p>
    </div>
  );
}
