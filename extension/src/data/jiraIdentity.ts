// Who is signed in to Jira. Sidekick's OAuth scopes don't include user profiles, so
// /rest/api/3/myself answers 401; the Jira page itself carries the signed-in user's accountId in
// a meta tag, which the Jira content script reports on request.

/** Message the side panel sends to a Jira tab's content script. Reply: { accountId: string | null }. */
export const JIRA_WHOAMI_MESSAGE = 'wocoo:jira-whoami' as const;

export interface IdentityDeps {
  /** The REST API (/myself). Throws when the token can't read user profiles. */
  fromApi: () => Promise<string>;
  /** The open Jira page's meta tag; null when no Jira tab can answer. */
  fromPage: () => Promise<string | null>;
}

/** The signed-in user's accountId: the API first, then the open Jira page. Throws only when
 *  neither knows, so callers that must not guess (the already-replied check) still fail safe. */
export async function resolveMyAccountId(deps: IdentityDeps): Promise<string> {
  let apiError: unknown = null;
  try {
    const id = await deps.fromApi();
    if (id) return id;
  } catch (e) {
    apiError = e;
  }
  const fromPage = await deps.fromPage().catch(() => null);
  if (fromPage) return fromPage;
  const why = apiError instanceof Error ? apiError.message : 'no accountId from the API';
  throw new Error(`Couldn't tell who is signed in to Jira (${why}; open the ticket in a Jira tab and try again)`);
}
