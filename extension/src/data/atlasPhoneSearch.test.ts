import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/atlasPhoneSearch.json';
import { readPhoneSearchHits } from './atlasPhoneSearch';

function resWithPhone(phone: string, over: Record<string, unknown> = {}) {
  return {
    data: {
      searchForUsers: {
        user: {
          hits: [{
            source: {
              fullName: 'Priya Ramanathan', phone, email: 'p@example.com', identityId: 'identity-TESTx', id: 'user-TESTx', ...over,
            },
          }],
        },
      },
    },
  };
}

describe('readPhoneSearchHits', () => {
  it('returns one de-duplicated hit for the matching phone, keeping the first email', () => {
    expect(readPhoneSearchHits(fixture, '4165550142')).toEqual([
      {
        identityId: 'identity-TESTaaaaAAAA1111',
        fullName: 'Priya Ramanathan',
        firstName: 'Priya',
        lastName: 'Ramanathan',
        email: 'priya.test1@example.com',
      },
    ]);
  });

  it('excludes hits whose phone differs (fuzzy search noise)', () => {
    const hits = readPhoneSearchHits(fixture, '4165550142');
    expect(hits.map((h) => h.identityId)).not.toContain('identity-TESTbbbbBBBB2222');
    expect(readPhoneSearchHits(fixture, '4165559999').map((h) => h.identityId)).toEqual(['identity-TESTbbbbBBBB2222']);
  });

  it('splits a multi-word surname into lastName', () => {
    const [hit] = readPhoneSearchHits(fixture, '4165559999');
    expect(hit.fullName).toBe('Sam Example Tester');
    expect(hit.firstName).toBe('Sam');
    expect(hit.lastName).toBe('Example Tester');
  });

  it.each(['(416) 555-0142', '416-555-0142', '+1 416 555 0142', '14165550142'])(
    'matches phone format %s',
    (phone) => {
      expect(readPhoneSearchHits(resWithPhone(phone), '4165550142')).toHaveLength(1);
    },
  );

  it('skips hits without an identity- prefixed identityId', () => {
    expect(readPhoneSearchHits(resWithPhone('(416) 555-0142', { identityId: 'user-TESTx' }), '4165550142')).toEqual([]);
  });

  it('returns null email when none present', () => {
    expect(readPhoneSearchHits(resWithPhone('(416) 555-0142', { email: null }), '4165550142')[0].email).toBeNull();
  });

  it.each([
    {}, { data: {} }, { data: { searchForUsers: {} } },
    { data: { searchForUsers: { user: { hits: 'x' } } } }, null, undefined, 'x',
  ])('returns [] for malformed response %j', (res) => {
    expect(readPhoneSearchHits(res, '4165550142')).toEqual([]);
  });
});
