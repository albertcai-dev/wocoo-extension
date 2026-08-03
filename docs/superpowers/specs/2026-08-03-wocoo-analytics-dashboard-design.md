# WOCOO Analytics Dashboard — Design

**Date:** 2026-08-03
**Status:** Approved (design), pending prerequisites
**Deployment target:** `magic.w10e.com/albert.cai/wocoo-analytics`
**Source repo:** `~/projects/wocoo-analytics/` (to be created)

## Purpose

A team-visible dashboard showing how many WOCOO tickets each CXA has completed, over four
rolling windows, with a per-day trend and a work-type drill-down. Read-only; it answers
"who closed what, and when" without anyone having to write JQL.

## Decisions

Every item below was chosen explicitly during brainstorming. Where a cheaper or safer
alternative was rejected, the rejection is recorded so it isn't silently revisited.

| Decision | Choice | Alternatives rejected |
|---|---|---|
| Automation exclusion | By issue type only | Changelog actor check (precise but forces pre-aggregation); label/resolution marker; bot-assignee heuristic |
| Data source | Live JQL on every page load | Scheduled aggregation into `MagicStorage.public`; hybrid cached-history + live-today |
| Fetch structure | Lazy per-tab with cumulative cache | Single year-window fetch on load; count-only queries for tiles |
| Completion definition | Done and Cancelled counted **separately** | Done only; both merged into one number |
| Assignee set | Fixed roster of five | Derived from data; derived plus zero-rows |
| Period layout | Four tabs, one board at a time | All four as table columns; summary tiles + one board |
| Chart | One line per assignee plus total, legend toggles | Total only; window follows the tab |
| Chart window | Own selector: 30 / 90 / 365, default 90 (sets the initial fetch size) | Fixed 90; follows the period tab |
| Drill-down | Inline accordion, multiple rows open at once | Right-hand drawer; fixed detail pane below |
| Default sort | Ranked by count, highest first | Alphabetical with sortable header; configurable |
| Design system | Patchwork tokens extracted from Figma | Reuse extension's `mint-tokens.css`; Figma tokens + hand-rolled components |
| Build | Tested build (modules + Vitest → concatenated single file) | Strictly single-file, hand-verified |

### Stated as decisions, not asked

- **Rolling windows**, not calendar days — "past day" is the last 24 hours, matching JQL's `-1d`.
- **`Other` is a visible row**, so totals reconcile rather than silently dropping non-roster tickets.

## Roster

Config constant at the top of the source:

```js
const ROSTER = ['Albert Cai', 'Esther Liao', 'Ishan Jain', 'Luke Gazmin', 'JC Ulat'];
```

Anyone outside it folds into `Other`. Tickets with no assignee get their own `Unassigned`
row — kept distinct from `Other` so it's visible whether work is going to untracked people
or to nobody.

## Architecture

Single-file Magic site, React via `@babel/standalone@7` (pinned — v8 emits `import`
statements that break `type="text/babel"`). Served with a `.js` extension, since
`magic_file_edit` returns 400 on `.jsx`.

Jira is reached through `MagicTools.call`, not `fetch`, so each viewer queries under their
own Okta identity. This is what makes team-wide visibility safe: nobody sees a ticket they
couldn't already open in Jira.

### Query

```
project = WOCOO AND statusCategory = Done
  AND resolutiondate >= -{N}d
  AND issuetype != "Eligibility Confirmation"
ORDER BY resolutiondate DESC
```

Fields: `resolutiondate`, `assignee`, `issuetype`, `status`. Paged via
`POST /rest/api/3/search/jql` with `nextPageToken` — the old `/rest/api/3/search` was
removed and returns 410.

### Done vs Cancelled

Both sit under `statusCategory = Done`, so the split is client-side on `status.name`:
`Cancelled/ No Action` → cancelled, everything else → done. Mirrors the transition mapping
at `extension/src/api/jira.ts:638`. An unrecognised status name defaults to done and is
covered by a test, so the default is deliberate rather than incidental.

### Cache

`ticketCache` holds `{ oldestDayFetched, issues[] }`. Before any fetch it compares the
requested window to `oldestDayFetched` and requests only the uncovered older slice, then
merges. Tabs and the chart selector both go through it, so each widening pays only its
increment and narrowing is free.

**Initial load fetches 90 days.** This is set by the chart's default window, which is the
widest thing rendered on first paint — fetching only 24 hours would leave the chart empty
until the user touched it. 90 days also makes the Day, 7-day and 30-day tabs instant, so
Year is the only window that ever triggers an on-demand fetch. The trade is a slower first
paint than a 24-hour load would give; it buys three instant tabs and a populated chart.

Mirrored to `sessionStorage` in compact form so a reload within a session is instant.
Deliberately not `localStorage` — numbers shouldn't survive across days and look current.
On a quota error the mirror is skipped and the cache stays in memory only.

### Derivation

Everything downstream is pure functions over the cached array; no further queries. Day
bucketing uses `America/Toronto` via `Intl`, never by adding 86400000ms — otherwise two
days a year mis-bucket tickets resolved near midnight.

## Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `jiraClient` | `fetchResolved(fromDays, toDays)`. Owns pagination, JQL, field selection. Returns `{ resolvedAt, assignee, workType, outcome }[]`. | `MagicTools` |
| `ticketCache` | `ensureRange(days)`. Sole decider of what still needs fetching; merges, mirrors to `sessionStorage`. | `jiraClient` |
| `aggregate` | Pure: `totalsFor`, `byAssignee`, `byWorkType`, `dailySeries`. | nothing |

Nothing above `jiraClient` knows Jira's response shape.

## Components

| Component | Responsibility |
|---|---|
| `App` | Holds selected period, chart window, and expanded row keys (a `Set` — the accordion allows several open). Orchestrates `ticketCache`. |
| `PeriodTabs` | Day / 7 days / 30 days / Year. |
| `SummaryTiles` | Done and cancelled totals for the selected period. |
| `Leaderboard` | Ranked rows plus a Total row, each expandable. No data logic. Ranking covers roster members, `Other` and `Unassigned` alike — they are ordinary rows. The Total row is pinned last and never participates in ranking; it sums every row above it, so the two always reconcile. |
| `WorkTypeBreakdown` | Accordion body. Same component for a person and for Total; only the input differs. |
| `TrendChart` | Multi-series daily lines, legend toggles, 30/90/365 selector. |

### Colour

Six series (five roster plus `Other`) needs a categorical palette. The extension's
`mint-tokens.css` has 43 tokens and no categorical scale, so the palette must come from the
Patchwork extraction — or, failing that, be derived and explicitly flagged as not from
Figma. Each person keeps one colour across the chart legend and their leaderboard row.

The `dataviz` skill is to be run before writing chart code, for palette and axis treatment.

### Loading

The year fetch is the slow path. `ticketCache` reports progress as pages arrive and the
board renders partial results with "showing N of ~M pages" rather than a blank spinner.

## Failure modes

- **Partial fetch.** On mid-pagination failure the cache keeps what it has, flags the range
  incomplete, and the UI shows a retry with rank suppressed. A silently under-counting
  leaderboard is worse than an error.
- **Wrong exclusion string.** `issuetype != "Eligibility Confirmation"` 400s if that isn't
  the exact registered name. Verified as a prerequisite, not at runtime.
- **Missing `resolutiondate`.** A Done ticket without one is invisible to the filter. A
  second query — `project = WOCOO AND statusCategory = Done AND resolutiondate IS EMPTY AND
  issuetype != "Eligibility Confirmation"`, fetching one field — counts them; if non-zero, a
  footnote reports the count. Otherwise the dashboard quietly disagrees with Jira. These
  tickets are never attributed to an assignee or a day, since there's no date to bucket them
  into; the footnote is the whole treatment.
- **`sessionStorage` quota.** Compact form; on quota error, in-memory only.
- **`MagicTools` unavailable.** Explicit "can't reach Jira — check VPN and MCP session"
  state with retry. Never render zeroes on failure; zeroes look like a real answer.

## Testing

Vitest over `aggregate` and `ticketCache` only. Components stay untested — their bugs are
visible; these aren't.

Cases that matter:

- Window boundary: a ticket resolved exactly 7 days ago, `>=` vs `>`.
- Cache merge: 7d → 30d → 7d → year must not double-count. The most likely bug, and the
  hardest to see, because the result is wrong but plausible.
- DST: a ticket resolved near midnight on a transition day.
- Unrecognised status name falls to done.
- `Other` and `Unassigned` classification; totals reconcile with the sum of rows.

Plus one manual check worth more than any of them: for a single window, compare the
dashboard total against the same JQL run directly in Jira. Disagreement means the exclusion
or bucketing logic is wrong.

## Build

```
~/projects/wocoo-analytics/
  src/          jiraClient.js · ticketCache.js · aggregate.js · components.js · tokens.css
  test/         aggregate.test.js · ticketCache.test.js
  build.js      concatenates src/ into dist/wocoo-analytics.js
  dist/
```

`npm test` then `npm run build`, then push `dist/wocoo-analytics.js` to Magic. Files over
50KB are pushed with chunked `magic_file_edit` — single-call `magic_file_write` at that size
has had subagents paraphrase content.

**The deployed file is a build artifact.** Editing it directly on Magic will be overwritten
by the next build. This is the accepted cost of the tested-build approach.

## Prerequisites

All three need MCPLocker, which returned `Session not initialized` on every tool for the
whole design session — VPN was reconnected and it persisted, so the MCP session itself needs
re-establishing.

1. **Confirm the exact issue-type name.** Check WOCOO's registry for `Eligibility
   Confirmation`. A mismatch 400s the query.
2. **Measure the year's volume.** `project = WOCOO AND statusCategory = Done AND
   resolutiondate >= -365d`. This was asked during brainstorming and answered "not sure".
   The decision rule: under ~10,000 the design stands as written; above that, the year tab
   will be a progress bar for a minute or more on every visit and the honest fix is caching
   the year's aggregate — which was explicitly rejected in favour of live. **If the number
   comes back high, raise it rather than quietly building a slow page.**
3. **Extract Patchwork tokens** from the Figma node below, emit `tokens.css`, and show the
   extracted values before building on them.

Figma: `https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/%F0%9F%9F%A0-Mint-DS-Web-1.0--Patchwork-?node-id=4515-3262`

## Out of scope

Ticket-level lists, SLA or cycle-time metrics, per-tier breakdowns, exports, date-range
pickers beyond the four windows, and any write path back to Jira.
