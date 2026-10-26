import { describe, expect, it } from 'vitest';
import { agentLocalTime, agentModeHelper, agentModeSince, normaliseAgentMode } from './agentMode';

describe('normaliseAgentMode', () => {
  it('passes through running and paused with since', () => {
    expect(normaliseAgentMode({ mode: 'running', since: 1700000000 })).toEqual({ mode: 'running', since: 1700000000 });
    expect(normaliseAgentMode({ mode: 'paused', since: 5.5 })).toEqual({ mode: 'paused', since: 5.5 });
  });

  it('treats an unexpected mode as paused', () => {
    expect(normaliseAgentMode({ mode: 'sleeping' }).mode).toBe('paused');
    expect(normaliseAgentMode({}).mode).toBe('paused');
    expect(normaliseAgentMode({ mode: 1 }).mode).toBe('paused');
  });

  it('nulls a missing or non-numeric since', () => {
    expect(normaliseAgentMode({ mode: 'running' }).since).toBeNull();
    expect(normaliseAgentMode({ mode: 'running', since: null }).since).toBeNull();
    expect(normaliseAgentMode({ mode: 'running', since: '12' }).since).toBeNull();
    expect(normaliseAgentMode({ mode: 'running', since: NaN }).since).toBeNull();
  });
});

describe('agentModeHelper', () => {
  it('describes each mode', () => {
    expect(agentModeHelper('running')).toMatch(/may use i2c on its own/);
    expect(agentModeHelper('paused')).toBe(''); // the label alone says "Sidekick Agent Paused"
  });
});

describe('agentModeSince', () => {
  it('is null when unset', () => {
    expect(agentModeSince(null)).toBeNull();
    expect(agentModeSince(NaN)).toBeNull();
  });

  it('prefixes a formatted local time', () => {
    expect(agentModeSince(1700000000)).toMatch(/^since .+/);
  });
});

describe('agentLocalTime', () => {
  it('is null when unset', () => {
    expect(agentLocalTime(null)).toBeNull();
    expect(agentLocalTime(Infinity)).toBeNull();
  });

  it('is agentModeSince without the prefix', () => {
    expect(agentModeSince(1700000000)).toBe(`since ${agentLocalTime(1700000000)}`);
  });
});
