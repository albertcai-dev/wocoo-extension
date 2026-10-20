import { describe, expect, it } from 'vitest';
import { AGENT_COMPASS_MSG, MAX_TEXT_LENGTH, doneKey, parseAgentCompassRequest } from './agentCompassPost';

const msg = (over: Record<string, unknown> = {}) => ({
  type: AGENT_COMPASS_MSG,
  jobId: 'PROJ-123',
  text: '@compass /qp list declined authorizations (PROJ-123)',
  ...over,
});

describe('parseAgentCompassRequest', () => {
  it('ignores messages that are not agent requests', () => {
    expect(parseAgentCompassRequest(null)).toBeNull();
    expect(parseAgentCompassRequest('hello')).toBeNull();
    expect(parseAgentCompassRequest({ type: 'something-else', text: '@compass hi' })).toBeNull();
  });

  it('accepts a well-formed request', () => {
    expect(parseAgentCompassRequest(msg())).toEqual({
      jobId: 'PROJ-123',
      text: '@compass /qp list declined authorizations (PROJ-123)',
    });
  });

  it('accepts a job id with a suffix', () => {
    expect(parseAgentCompassRequest(msg({ jobId: 'PROJ-123:2' }))).toMatchObject({ jobId: 'PROJ-123:2' });
  });

  it('rejects a bad job id', () => {
    expect(parseAgentCompassRequest(msg({ jobId: 'proj 123' }))).toEqual({ error: 'bad jobId' });
    expect(parseAgentCompassRequest(msg({ jobId: 42 }))).toEqual({ error: 'bad jobId' });
  });

  it('only allows questions addressed to Compass', () => {
    expect(parseAgentCompassRequest(msg({ text: 'hello team' }))).toHaveProperty('error');
    expect(parseAgentCompassRequest(msg({ text: '@someone @compass hi' }))).toHaveProperty('error');
    expect(parseAgentCompassRequest(msg({ text: '@compassion hi' }))).toHaveProperty('error');
  });

  it('rejects an empty question', () => {
    expect(parseAgentCompassRequest(msg({ text: '@compass    ' }))).toEqual({ error: 'empty question' });
  });

  it('rejects overlong text', () => {
    const text = '@compass ' + 'x'.repeat(MAX_TEXT_LENGTH);
    expect(parseAgentCompassRequest(msg({ text }))).toHaveProperty('error');
  });

  it('rejects non-string text', () => {
    expect(parseAgentCompassRequest(msg({ text: 5 }))).toEqual({ error: 'text must be a string' });
  });
});

describe('doneKey', () => {
  it('prefixes the job id', () => {
    expect(doneKey('PROJ-1')).toBe('wocoo-agent-compass:PROJ-1');
  });
});
