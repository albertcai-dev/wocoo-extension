# BM25 precedent retrieval for the AI verdict card

**Status:** design, not yet approved
**Date:** 2026-09-10
**Supersedes the retrieval half of:** `2026-09-03-jira-precedent-retrieval.md`

## Problem

The AI verdict card can only tell the model *what was done* on a past ticket when that
ticket has a hand-written `resolution_note` in the Ticket Log sheet. Today the Log holds
20 rows, 9 of them with a note, none about credit-card interest. So on a real interest
waiver ticket every precedent candidate renders `intake only`, the model reports "no
confirmed resolution pattern exists", and confidence caps at medium.

Two separate defects produce that:

1. **The resolutions are in Jira and we never read them.** `searchPrecedent` requests
   `summary` and `description` only. Every Done WOCOO ticket already carries closing
   comments written by whoever worked it — thousands of them, retroactively, with no
   behaviour change required from anyone.
2. **Retrieval is recency-only.** `buildPrecedentJql` filters to the same `issuetype`
   and orders by `created DESC`, capped at 40. The 40 newest tickets of a type are not
   the 40 most similar to the one in hand, and precedent filed under a neighbouring work
   type is invisible.

## Goals

- Outcomes sourced from Jira comments, so the feature works without the Ticket Log.
- Candidates ranked by textual similarity to the open ticket, not by recency.
- Card latency no worse than today after a warm cache.
- The Ticket Log stays useful as a higher-quality signal, not a dependency.

## Non-goals

- **Embeddings.** Dropped deliberately in the July Phase 2 redesign and still not
  needed: BM25 over 500 same-domain tickets is sharp enough because the corpus shares
  one vocabulary. The gateway does expose an embeddings endpoint if this proves wrong.
- **Cross-project retrieval.** WOCOO only.
- **Replacing the Ticket Log.** A human "what I actually did" beats an inferred one.

## Architecture

Three units, two of them pure.

### 1. `data/precedentCorpus.ts` — fetch and cache the pool

Fetches 500 recent Done WOCOO tickets once, caches them, and hands out a trimmed
in-memory corpus. Nothing here ranks.

**Query.** `project = WOCOO AND statusCategory = Done ORDER BY created DESC`, with no
`issuetype` filter — BM25 does the narrowing, so restricting the pool by work type would
only re-introduce the blind spot we are trying to remove.

**Pagination.** `/rest/api/3/search/jql` caps at 100 results per request and paginates by
`nextPageToken`, not `startAt`. `searchTickets` currently ignores the token, so it grows
an optional paging mode; five requests fill the pool.

**Fields.** `summary`, `description`, `comment`, `issuetype`, `created`.

**Trimming before storage.** Raw payload for 500 tickets with full comment threads runs
1.5–4 MB, most of it noise. Each ticket reduces to:

```ts
interface CorpusTicket {
  id: string;
  issueType: string;
  createdAt: string;
  summary: string;
  description: string;      // ADF-flattened, capped at 1200 chars
  comments: string[];       // last 4 comments, ADF-flattened, each capped at 600 chars
}
```

`adfToPlainText` in `jira.ts` already does the flattening but is module-private; it gets
exported. Descriptions go through the existing `extractDescription`.

**Cache.** `chrome.storage.local` under `precedent_corpus_v1`, with `fetchedAt` and a
`schemaVersion` so a shape change invalidates rather than mis-parses. Roughly 1.5 MB at
500 tickets with four comments each, comfortably inside `storage.local`.

This is a deliberate departure from `aiTriageCache.ts`, which keeps verdicts in memory
only and says so in a comment. That trade-off does not carry over: re-paging five Jira
requests on every side-panel open would add seconds before the card renders.

**Refresh.** Stale after 24 hours. Two triggers, neither blocking a render:

- Side panel open: if stale, kick off a background refresh and serve the old corpus.
- A daily `chrome.alarms` job, following `chequeValidationScheduler.ts`.

### 2. `data/bm25.ts` — ranking

Pure, no I/O, fully unit-tested.

**Tokenisation.** Lowercase, split on non-alphanumerics, drop English stopwords plus a
WOCOO boilerplate list — `client`, `team`, `please`, `zendesk`, `support`, `tab`,
`comments`, `attachments`, `thanks`. Those appear in nearly every ticket, so leaving them
in makes every document look alike.

**Scoring.** Standard BM25, `k1 = 1.2`, `b = 0.75`, IDF computed over the cached corpus.
The query is the open ticket's summary plus description. Each document is its summary
weighted ×2, plus description, plus comments — summary terms are the best signal of what
a ticket is actually about.

**Output.** Top 25 by score, ties broken by recency. The other 475 never reach the model.

**Corpus depth and prompt depth are decoupled.** The corpus keeps four comments per
ticket because BM25 scores better with more text to match against, but the prompt carries
only the last two. Sending all four would put ~92,000 characters of precedent in front of
the model — roughly 23k tokens — for text that mostly repeats what the final comment
already says. Ranking wants breadth; the model wants the conclusion.

### 3. Wiring: `precedent.ts`, `composePrompt.ts`, `AITriageCard.tsx`

`PrecedentCandidate` gains `resolutionComments: string[]` and `score: number`, and
`source` widens to `'logged' | 'comments' | 'intake-only'`:

- `logged` — a human resolution note exists in the Ticket Log. Preferred; a note written
  deliberately after the fact beats a closing comment written in the moment.
- `comments` — no note, but the ticket has closing comments. Render those as the outcome.
- `intake-only` — neither. Should become rare.

`joinPrecedentOutcomes` keeps its current job and gains the comments fallback.
`composePrompt` renders the outcome from whichever source won, and its instruction about
`intake-only` candidates stays as-is, since that state still occurs.

## Failure handling

The card must never fail because precedent retrieval failed — that principle already
holds in `AITriageCard.tsx`, which tolerates `precedentRows === null`.

| Condition | Behaviour |
|---|---|
| Corpus fetch fails | Fall back to today's `searchPrecedent` path: 40 by recency, same work type |
| Corpus empty or unparseable | Same fallback; discard the cache entry |
| Corpus stale | Use it, refresh in background |
| A page of the five fails | Keep the pages that succeeded; a 300-ticket corpus still ranks |

## Testing

- `bm25.ts` — ranking behaviour: a rare shared term outranks several common ones;
  summary matches outrank description matches; stopword-only overlap scores zero;
  known-ordering fixtures built from real anonymised ticket text.
- Trimming and flattening — pure functions, tested directly.
- `joinPrecedentOutcomes` — the three-way source precedence.
- Network paths stay untested, consistent with the rest of the repo.

## Privacy consequence — needs resolving before build

Two changes here matter, and both contradict statements now published.

1. **Volume to the gateway** rises from one ticket's text to 25 tickets' descriptions and
   comments per verdict. The question of whether `bedrock-claude-sonnet-4-6-global`
   applies WS PII masking is still open with `#ml-platform`. If it masks, this design
   sends 25× more mangled text and the card's quality claim weakens rather than improves.
2. **500 ticket descriptions and comments would sit in `chrome.storage.local`** on each
   analyst's machine. The cache is cleared on sign-out alongside the OAuth tokens, so a
   signed-out account leaves no client text on disk; the cost is that the next sign-in
   re-pages all five requests once. That is new: the privacy page published today states the Ticket Log
   sheet is the only place the extension retains personal data beyond a session. That
   page needs updating, and the cache needs clearing on sign-out alongside the tokens.

Decision: implementation proceeds while the masking question is asked in parallel. If it
turns out ticket text is masked, the design still holds — the quality gain is simply
smaller than hoped, because comments would be mangled the same way descriptions are.

The card's precedent list keeps its current shape. Showing matched terms or BM25 scores
was considered and rejected as noise; if a precedent ever looks irrelevant, the ranking
is reproducible from the cached corpus offline.
