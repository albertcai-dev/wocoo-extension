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
| Automation exclusion | **None needed** — the `resolutiondate` filter already drops them (see Findings) | By issue type (chosen during brainstorming, then invalidated by data); changelog actor check; label/resolution marker; bot-assignee heuristic |
| Data source | Live JQL on every page load | Scheduled aggregation into `MagicStorage.public`; hybrid cached-history + live-today |
| Fetch structure | Lazy per-tab with cumulative cache | Single year-window fetch on load; count-only queries for tiles |
| Completion definition | Done and Cancelled counted **separately** | Done only; both merged into one number |
| Assignee set | Fixed roster of five | Derived from data; derived plus zero-rows |
| Period layout | Four tabs, one board at a time | All four as table columns; summary tiles + one board |
| Chart | One line per assignee plus total, legend toggles | Total only; window follows the tab |
| Chart window | Own selector: 30 / 90 / 365, default 90 (sets the initial fetch size) | Fixed 90; follows the period tab |
| Drill-down | Inline accordion, multiple rows open at once | Right-hand drawer; fixed detail pane below |
| Default sort | Ranked by count, highest first | Alphabetical with sortable header; configurable |
| Design system | Patchwork tokens — greyscale read from Figma, categorical sampled from screenshots (see Findings) | Reuse extension's `mint-tokens.css`; Figma tokens + hand-rolled components |
| Year tab performance | Stays live, with a progress indicator | Cache the year rollup in `MagicStorage.public`; drop the Year tab |
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
  AND summary !~ "Eligibility Confirmation Request"
ORDER BY resolutiondate DESC
```

The `summary !~` clause is belt-and-braces, not the mechanism — see Findings. Automation
tickets already fall out because they carry no `resolutiondate`. The clause exists so that
if automation ever starts stamping one, roughly five phantom tickets a day don't quietly
appear on the board.

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

Patchwork defines a Data Visualization categorical set of exactly six colours, which covers
the six series (five roster plus `Other`) without deriving anything. Values are in Findings §3
— greys authoritative, categorical sampled from a screenshot and flagged as approximate. Each
person keeps one colour across the chart legend and their leaderboard row.

The `dataviz` skill is to be run before writing chart code, for axis treatment and to check
the sampled palette holds up on contrast and colour-blind safety — six hues is where
categorical palettes usually start failing, and these came off an image rather than a
validated scale.

### Loading

The year fetch is the slow path. `ticketCache` reports progress as pages arrive and the
board renders partial results with "showing N of ~M pages" rather than a blank spinner.

## Failure modes

- **Partial fetch.** On mid-pagination failure the cache keeps what it has, flags the range
  incomplete, and the UI shows a retry with rank suppressed. A silently under-counting
  leaderboard is worse than an error.
- **Automation tickets reappearing.** Exclusion rests on these tickets having no
  `resolutiondate` (Findings §1), which is a property of how Workato closes them, not a
  guarantee. If that changes, ~5 phantom tickets a day would land on roster members' counts.
  The `summary !~` clause is the guard; if the automation's summary text ever changes too,
  both defences fail silently. Worth re-checking whenever counts look inflated.
- **Missing `resolutiondate`.** A Done ticket without one is invisible to the filter. The
  footnote query is:

  ```
  project = WOCOO AND statusCategory = Done AND resolutiondate IS EMPTY
    AND summary !~ "Eligibility Confirmation Request"
  ```

  The summary exclusion is **load-bearing here**, unlike in the main query. Without it this
  would count ~1,800 automation tickets a year and report them to the team as a data
  discrepancy — the footnote would be permanently, loudly wrong. It should surface only
  genuine human tickets that somehow reached Done without a resolution date. Those are never
  attributed to an assignee or a day, since there's no date to bucket them into; the footnote
  is the whole treatment.
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

## Findings

The three prerequisites were investigated on 2026-08-03. Two of them changed the design.

### 1. The automation exclusion was built on a false premise — and isn't needed

"Eligibility Confirmation" is **not** an issue type. WOCOO's registry has 37 types and none
is called that. The tickets are:

- `issue_type: "Other"` — a legitimate work type, distinct from `Cash: Other`,
  `Credit Card: Other` and `Prepaid Card: Other`
- `summary: "Eligibility Confirmation Request"`
- `reporter: workato machine account`
- created and closed roughly three seconds apart
- **assigned to roster members** (Albert, Esther and Ishan across a single day's four)

So `issuetype != "Eligibility Confirmation"` would have returned a 400, and the obvious
repair — excluding `Other` — would have silently dropped real work.

No exclusion is required. **These tickets carry no `resolutiondate`.** Evidence:
`summary ~ "Eligibility Confirmation Request" AND resolutiondate >= -30d` returns nothing,
while the same query with `resolutiondate IS EMPTY` returns them. The date filter the design
already needed does the job.

Filtering by reporter was considered and rejected: `reporter = "workato machine account"`
returns empty in JQL — the display name doesn't resolve to an account.

### 2. Volume sits right on the threshold; Year stays live by decision

Earliest ticket created in the trailing 365 days is WOCOO-14823; the newest is WOCOO-26133 —
about **11,300 created per year**. Eligibility confirmations run ~4–6/day (4 in a measured
24-hour window), so roughly 1,500–2,000 drop out, leaving an estimated **9,500–11,000
resolved-with-a-date per year, or 95–110 paged requests** for the Year tab.

This tripped the decision rule written into the previous draft. It was raised rather than
designed around, and the explicit choice was to **keep Year live with a progress indicator**.
The 90-day initial load is ~25 pages and remains comfortable; Day/7d/30d are instant off it.
Year is expected to take on the order of a minute, every session, with no caching between
visits. That is understood and accepted.

### 3. Patchwork tokens: greys are authoritative, categorical is sampled

Figma MCP extraction was blocked — not transiently:

> You've reached the Figma MCP tool call limit for your Collab seat on the Enterprise plan.

Values were instead read from screenshots of the Foundation / Colour and Foundation /
Colour / Data Visualization pages.

**Authoritative** (chip labels match their swatches):

| Token | Light | Dark |
|---|---|---|
| `strong-fg` | `#32302F` | `#F1F0F0` |
| `soft-fg` | `#615E5C` | `#C9C6C4` |
| `inactive-fg` | `#94908D` | `#7A7674` |
| `strong-fg-inverted` | `#F1F0F0` | `#32302F` |
| `outline` | `#000000` @ 8% | `#FFFFFF` @ 12% |
| `app-bg` | `#FCFCFC` | `#181716` |
| `default-bg` | `#FFFFFF` | `#1C1B1B` |
| `soft-bg` | `#F5F4F4` | `#32302F` |
| `inactive-bg` | `#F8F8F8` | `#1C1B1B` |
| `strong-bg` | `#32302F` | `#F1F0F0` |
| `surface/medium-bg` | `#F5F4F4` | `#222120` |
| `control/soft-bg` | `#000000` @ 6% | `#FFFFFF` @ 12% |

**Approximate — sampled from a screenshot, NOT from the design system.** The categorical
row's hex chips in Figma are detached from their swatches: six visibly blue/purple/pink/
yellow/green/orange swatches are labelled `#E7F6D1 · #D5EAB8 · #B3D088 · #99B56E · #7B9B54 ·
#5C8145`, which is a single green ramp. The identical three values reappear under the
Performance row's white/green/red swatches, so it's doc rot, not a misreading. Eyedropped
values, in palette order:

| Series | Sampled |
|---|---|
| categorical 01 | `#6E93E0` |
| categorical 02 | `#B07FE8` |
| categorical 03 | `#EE86CE` |
| categorical 04 | `#EBCB2E` |
| categorical 05 | `#38934F` |
| categorical 06 | `#F09340` |

These are visually faithful and numerically wrong in a way no one will catch by looking.
Replace them with real values whenever the Figma limit clears or someone reads them out of
Dev Mode — and note that the **variable names** are still unknown, so `tokens.css` will have
to invent them.

Six swatches for exactly six series (five roster plus `Other`) is a lucky fit. If the roster
grows past five, the palette is exhausted and someone has to decide what gives.

**Worth reporting upstream:** the detached hex chips are a bug in a shared Wealthsimple
design file. Anyone reading data-viz values off that page today gets greens.

Figma: `https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/%F0%9F%9F%A0-Mint-DS-Web-1.0--Patchwork-?node-id=4515-3262`

## Out of scope

Ticket-level lists, SLA or cycle-time metrics, per-tier breakdowns, exports, date-range
pickers beyond the four windows, and any write path back to Jira.
