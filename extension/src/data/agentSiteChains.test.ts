import { describe, expect, it } from 'vitest';
import {
  AGENT_ATLAS_LOOKUP_MSG, AGENT_KOHO_CHAIN_MAX_AGE_MS, AGENT_KOHO_MSG, kohoUserId, parseAtlasRequest,
  parseKohoRequest, readKohoChain,
} from './agentSiteChains';

describe('parseKohoRequest', () => {
  it('takes the client email and an optional SSO email', () => {
    expect(parseKohoRequest({ type: AGENT_KOHO_MSG, email: 'a@b.co' })).toEqual({ email: 'a@b.co' });
    expect(parseKohoRequest({ type: AGENT_KOHO_MSG, email: 'a@b.co', ssoEmail: 'me@corp.co' }))
      .toEqual({ email: 'a@b.co', ssoEmail: 'me@corp.co' });
  });
  it('ignores other messages and rejects bad emails', () => {
    expect(parseKohoRequest({ type: 'x' })).toBeNull();
    expect(parseKohoRequest({ type: AGENT_KOHO_MSG, email: 'no' })).toEqual({ error: 'bad email' });
    expect(parseKohoRequest({ type: AGENT_KOHO_MSG, email: 'a@b.co', ssoEmail: 'x' })).toEqual({ error: 'bad ssoEmail' });
  });
});

describe('readKohoChain', () => {
  const now = 5_000_000;
  const c = { email: 'a@b.co', startedAt: now - 10, step: 'search' };
  it('reads fresh chains and drops stale or garbled ones', () => {
    expect(readKohoChain(JSON.stringify(c), now)).toEqual(c);
    expect(readKohoChain(JSON.stringify({ ...c, startedAt: now - AGENT_KOHO_CHAIN_MAX_AGE_MS - 1 }), now)).toBeNull();
    expect(readKohoChain('nope', now)).toBeNull();
  });
});

describe('kohoUserId', () => {
  it('reads the user id from a user page path', () => {
    expect(kohoUserId('/user/EuaCg45K/info')).toBe('EuaCg45K');
    expect(kohoUserId('/')).toBeNull();
  });
});

describe('parseAtlasRequest', () => {
  it('needs an identity id', () => {
    expect(parseAtlasRequest({ type: AGENT_ATLAS_LOOKUP_MSG, identityId: 'identity-Ab3_x' }, AGENT_ATLAS_LOOKUP_MSG))
      .toEqual({ identityId: 'identity-Ab3_x' });
    expect(parseAtlasRequest({ type: AGENT_ATLAS_LOOKUP_MSG, identityId: 'x' }, AGENT_ATLAS_LOOKUP_MSG)).toEqual({ error: 'bad identityId' });
    expect(parseAtlasRequest({ type: 'other' }, AGENT_ATLAS_LOOKUP_MSG)).toBeNull();
  });
});
