// Settings view — full page reached by clicking the ⚙ button in any header.
// Houses Sign Out, credential storage (i2c CS + admin, LLM Gateway), and a placeholder for more.

import { useEffect, useState } from 'react';
import { clearI2cCredentials, getI2cCredentials, setI2cCredentials,
  clearI2cAdminCredentials, getI2cAdminCredentials, setI2cAdminCredentials,
  type I2cCredentials,
  clearLlmGatewayKey, getLlmGatewayKey, setLlmGatewayKey } from '../auth/credentials';
import { pingLlmGateway } from '../api/llmGateway';
import { getAgentMode, isDraftStoreNotSetUp, setAgentMode } from '../api/draftStore';
import { agentModeHelper, agentModeSince, type AgentModeState } from '../data/agentMode';
import { checkAgentLogins } from '../api/loginCheck';
import { loginSummary, type LoginSite, type LoginStatus } from '../data/loginCheck';
import { AgentProgress } from './AgentProgress';
import { useAgentStatus } from './useAgentStatus';

export function SettingsView({ onBack, onSignOut }: { onBack: () => void; onSignOut: () => void }) {
  return (
    <div style={{ minWidth: 280, padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)' }}>
        <button
          onClick={onBack}
          title="Back"
          aria-label="Back"
          style={{
            width: 32, height: 32, borderRadius: 8,
            border: 'var(--mint-card-stroke)',
            background: 'var(--mint-bg-card)',
            color: 'var(--mint-fg-subdued-title)',
            cursor: 'pointer',
            fontSize: 14,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          ←
        </button>
        <span style={{ fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Settings</span>
      </header>

      <h1 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Settings</h1>

      <Section title="Account">
        <Row
          label="Signed in via Atlassian OAuth"
          right={
            <button
              onClick={onSignOut}
              style={{
                padding: '6px 14px',
                background: 'var(--mint-negative-bg-soft)',
                color: 'var(--mint-negative-fg-strong)',
                border: '1px solid var(--mint-negative-fg-graphic)',
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-micro)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ⎋ Sign out
            </button>
          }
        />
      </Section>

      <Section title="Credentials">
        <I2cCredentialsRow
          title="i2c (MCP Call Center)"
          placeholder="e.g. cs000acai"
          pageName="i2c login page"
          load={getI2cCredentials}
          save={setI2cCredentials}
          clear={clearI2cCredentials}
        />
        <I2cCredentialsRow
          title="i2c Admin (wealthsimpleadmin)"
          placeholder="Admin portal user ID"
          pageName="i2c admin login page"
          load={getI2cAdminCredentials}
          save={setI2cAdminCredentials}
          clear={clearI2cAdminCredentials}
        />
        <LlmGatewayRow />
      </Section>

      <DraftAgentSection />

      <Section title="Preferences">
        <Row label="More tooling coming soon." right={null} muted />
      </Section>
    </div>
  );
}

// One card per i2c portal; each portal keeps its own login under its own storage key.
function I2cCredentialsRow({ title, placeholder, pageName, load, save: saveCreds, clear: clearCreds }: {
  title: string;
  placeholder: string;
  pageName: string;
  load: () => Promise<I2cCredentials | null>;
  save: (creds: I2cCredentials) => Promise<void>;
  clear: () => Promise<void>;
}) {
  const [loaded, setLoaded] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    load().then((c) => {
      if (c) {
        setHasSaved(true);
        setUsername(c.username);
        setPassword(c.password);
        setAutoSubmit(c.autoSubmit);
      }
      setLoaded(true);
    });
  }, []);

  async function save() {
    if (!username.trim() || !password) { setStatus('Username and password are required.'); return; }
    await saveCreds({ username: username.trim(), password, autoSubmit });
    setHasSaved(true);
    setStatus('Saved.');
    setTimeout(() => setStatus(null), 2000);
  }

  async function clear() {
    await clearCreds();
    setHasSaved(false);
    setUsername('');
    setPassword('');
    setStatus('Cleared.');
    setTimeout(() => setStatus(null), 2000);
  }

  if (!loaded) return null;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--mint-sp-2)' }}>
        <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{title}</span>
        {hasSaved ? (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ Saved</span>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Not set</span>
        )}
      </div>

      <label style={labelStyle}>Username</label>
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={inputStyle}
      />

      <label style={{ ...labelStyle, marginTop: 8 }}>Password</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={hasSaved ? '••••••••' : 'Enter password'}
          autoComplete="off"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          title={showPassword ? 'Hide password' : 'Show password'}
          style={{ ...secondaryBtn, padding: '6px 10px' }}
        >
          {showPassword ? '🙈' : '👁'}
        </button>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={autoSubmit}
          onChange={(e) => setAutoSubmit(e.target.checked)}
        />
        Auto-click Sign-in after filling
      </label>

      <div style={{ display: 'flex', gap: 6, marginTop: 'var(--mint-sp-2)' }}>
        <button onClick={save} style={primaryBtn}>{hasSaved ? 'Update' : 'Save'}</button>
        {hasSaved ? <button onClick={clear} style={secondaryBtn}>Clear</button> : null}
      </div>

      {status ? (
        <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)' }}>{status}</div>
      ) : null}

      <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
        Stored locally on this device only. When you open the {pageName}, the extension fills these in.
      </div>
    </div>
  );
}

function LlmGatewayRow() {
  const [loaded, setLoaded] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusOk, setStatusOk] = useState(true);

  useEffect(() => {
    getLlmGatewayKey().then((k) => {
      if (k) { setHasSaved(true); setKey(k); }
      setLoaded(true);
    });
  }, []);

  async function save() {
    if (!key.trim()) { setStatusOk(false); setStatus('A key is required.'); return; }
    await setLlmGatewayKey(key);
    setHasSaved(true);
    setChecking(true);
    setStatusOk(true);
    setStatus('Checking\u2026');
    const res = await pingLlmGateway(key.trim());
    setChecking(false);
    setStatusOk(res.ok);
    setStatus(res.ok ? 'Saved. Key works.' : `Saved, but the check failed. ${res.error}`);
  }

  async function clear() {
    await clearLlmGatewayKey();
    setHasSaved(false);
    setKey('');
    setStatusOk(true);
    setStatus('Cleared.');
    setTimeout(() => setStatus(null), 2000);
  }

  if (!loaded) return null;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--mint-sp-2)' }}>
        <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>LLM Gateway</span>
        {hasSaved ? (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ Saved</span>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Not set</span>
        )}
      </div>

      <label style={labelStyle}>Developer key</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type={showKey ? 'text' : 'password'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-…"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button onClick={() => setShowKey((v) => !v)} style={secondaryBtn}>{showKey ? 'Hide' : 'Show'}</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 'var(--mint-sp-2)' }}>
        <button onClick={save} disabled={checking} style={primaryBtn}>{hasSaved ? 'Update' : 'Save'}</button>
        {hasSaved ? <button onClick={clear} style={secondaryBtn}>Clear</button> : null}
      </div>

      {status ? (
        <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', lineHeight: 1.4, color: statusOk ? 'var(--mint-positive-fg-strong)' : 'var(--mint-negative-fg-strong)' }}>{status}</div>
      ) : null}

      <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
        Personal LiteLLM developer key, stored locally on this device. The gateway is only
        reachable on the WS VPN.
      </div>
    </div>
  );
}

// Run/pause toggle for the local draft agent. Renders nothing on machines without the agent.
function DraftAgentSection() {
  const [state, setState] = useState<AgentModeState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [logins, setLogins] = useState<Partial<Record<LoginSite, LoginStatus | 'checking' | 'error'>>>({});
  const progress = useAgentStatus();

  // Switching the agent on: make sure the Okta-backed sites it reads are signed in. Signed-in
  // probe tabs close by themselves; any that need the user stay open, the first one in front.
  async function checkLogins() {
    await checkAgentLogins((site, status) => setLogins((prev) => ({ ...prev, [site]: status })));
  }

  useEffect(() => {
    getAgentMode()
      .then(setState)
      .catch((e) => {
        if (isDraftStoreNotSetUp(e)) setHidden(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoaded(true));
  }, []);

  async function toggle() {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await setAgentMode(state.mode === 'running' ? 'paused' : 'running');
      setState(next);
      progress.refresh();
      if (next.mode === 'running') void checkLogins();
      else setLogins({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (hidden || !loaded) return null;

  const running = state?.mode === 'running';
  const since = state ? agentModeSince(state.since) : null;

  return (
    <Section title="Sidekick Agent">
      <div style={cardStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)', cursor: state && !busy ? 'pointer' : 'default' }}>
          <input
            type="checkbox"
            checked={running}
            disabled={!state || busy}
            onChange={toggle}
          />
          {running ? 'Sidekick Agent running' : 'Sidekick Agent Paused'}
          {since ? (
            <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontWeight: 400 }}>{since}</span>
          ) : null}
        </label>

        {state && agentModeHelper(state.mode) ? (
          <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
            {agentModeHelper(state.mode)}
          </div>
        ) : null}

        {Object.keys(logins).length > 0 ? (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', lineHeight: 1.4, color: 'var(--mint-fg-strong)' }}>
            Logins: {loginSummary(logins)}
          </div>
        ) : null}

        {error ? (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', lineHeight: 1.4, color: 'var(--mint-negative-fg-strong)' }}>{error}</div>
        ) : null}

        {progress.view ? <AgentProgress view={progress.view} now={progress.now} /> : null}

        {progress.failed ? (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', lineHeight: 1.4, color: 'var(--mint-fg-soft)' }}>
            Couldn't refresh agent status.
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
      <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{title}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </section>
  );
}

function Row({ label, right, muted }: { label: string; right: React.ReactNode; muted?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--mint-sp-2)',
      padding: 'var(--mint-sp-2) var(--mint-sp-3)',
      background: muted ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
      border: 'var(--mint-card-stroke)',
      borderRadius: 'var(--mint-radius-card)',
    }}>
      <span style={{ fontSize: 'var(--mint-text-meta)', color: muted ? 'var(--mint-fg-soft)' : 'var(--mint-fg-strong)', fontStyle: muted ? 'italic' : 'normal' }}>{label}</span>
      {right}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
};

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--mint-fg-soft)',
  fontWeight: 700,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-micro)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
  width: '100%',
};

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  border: 'none',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-micro)',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-micro)',
  fontWeight: 600,
  cursor: 'pointer',
};
