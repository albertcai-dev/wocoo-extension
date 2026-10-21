import { describe, expect, it } from 'vitest';
import { resolveMyAccountId } from './jiraIdentity';

describe('resolveMyAccountId', () => {
  it('uses the API when it answers', async () => {
    await expect(resolveMyAccountId({ fromApi: async () => 'api-id', fromPage: async () => 'page-id' })).resolves.toBe('api-id');
  });

  it('falls back to the page when the API is refused', async () => {
    const fromApi = async () => { throw new Error('getMyself failed (HTTP 401)'); };
    await expect(resolveMyAccountId({ fromApi, fromPage: async () => 'page-id' })).resolves.toBe('page-id');
  });

  it('throws when neither knows, naming the API error', async () => {
    const fromApi = async () => { throw new Error('getMyself failed (HTTP 401)'); };
    await expect(resolveMyAccountId({ fromApi, fromPage: async () => null })).rejects.toThrow(/HTTP 401/);
  });

  it('treats a page lookup that throws as unknown', async () => {
    const fromPage = async (): Promise<string | null> => { throw new Error('no tab'); };
    await expect(resolveMyAccountId({ fromApi: async () => '', fromPage })).rejects.toThrow(/signed in/);
  });
});
