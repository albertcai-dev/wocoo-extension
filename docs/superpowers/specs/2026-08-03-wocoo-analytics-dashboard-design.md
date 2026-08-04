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
| Completion timestamp | `statusCategoryChangedDate`, as a **query bound only** (Findings §4) | `resolutiondate` (chosen first, then found dead in WOCOO); `updated` (drifts when closed tickets are commented on) |
| Automation exclusion | `summary !~ "Eligibility Confirmation Request"` — load-bearing | By issue type (invalidated: not an issue type); by reporter (display name doesn't resolve in JQL); none needed (only true under `resolutiondate`) |
| Data source | Live JQL on every page load | Scheduled aggregation into `MagicStorage.public`; hybrid cached-history + live-today |
| Fetch structure | One query per calendar day; windows are unions of days | Single window query per tab; single year fetch on load; count-only queries for tiles |
| Chart bucketing | One query per day, day carried by the query | Weekly buckets for long windows; drop the chart |
| Completion definition | Done and Cancelled counted **separately** | Done only; both merged into one number |
| Assignee set | Fixed roster of five | Derived from data; derived plus zero-rows |
| Period layout | Four tabs, one board at a time | All four as table columns; summary tiles + one board |
| Chart | One line per assignee plus total, legend toggles | Total only; window follows the tab |
| Chart window | Own selector: 30 / 90 / 365, default 30 (sets the initial fetch size) | Default 90 (dropped once a day costs a request); fixed 90; follows the period tab |
| Drill-down | Inline accordion, multiple rows open at once | Right-hand drawer; fixed detail pane below |
| Default sort | Ranked by count, highest first | Alphabetical with sortable header; configurable |
| Design system | Patchwork tokens — greyscale read from Figma, categorical sampled from screenshots (see Findings) | Reuse extension's `mint-tokens.css`; Figma tokens + hand-rolled components |
| Year tab performance | Stays live, with a progress indicator | Cache the year rollup in `MagicStorage.public`; drop the Year tab |
| Build | Tested build (modules + Vitest → concatenated single file) | Strictly single-file, hand-verified |

### Stated as decisions, not asked

- **Calendar days**, not rolling windows. The earlier draft specified rolling 24-hour windows
  to match JQL's `-1d`; Findings §4 replaced that with per-day queries, so "past day" now means
  today so far, and "past 7 days" means the last 7 calendar days including today. Boundaries
  are Jira's, in the viewer's Jira timezone.
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

Single-file Magic site (`index.html`), React via `@babel/standalone@7` (pinned — v8 emits
`import` statements that break `type="text/babel"`). Tailwind v4 and the Wealthsimple token
set are auto-injected by Magic and must not be bundled.

Jira is reached through `MagicTools.call`, not `fetch`, so each viewer queries under their
own Okta identity. This is what makes team-wide visibility safe: nobody sees a ticket they
couldn't already open in Jira.

### Query

One query per calendar day. The date is carried by the query, not read from the ticket —
see Findings §4, which explains why no per-ticket completion timestamp is available.

```
project = WOCOO AND statusCategory = Done
  AND statusCategoryChangedDate >= "{YYYY-MM-DD}"
  AND statusCategoryChangedDate <  "{YYYY-MM-DD + 1}"
  AND summary !~ "Eligibility Confirmation Request"
```

The `summary !~` clause is **load-bearing**, not defensive. Automation tickets have no
`resolutiondate` but they do have a status-category change date, so without this clause
roughly five phantom tickets a day would land on roster members' counts. Verified: the same
query with `summary ~` returns WOCOO-26133, 26129 and 26118, assigned to Albert, Esther and
Ishan.

Issued through `MagicTools.call('jira_search_tickets', …)` — the MCP tool, not raw REST,
since a Magic site can only reach Jira via MagicTools:

```js
await window.MagicTools.call('jira_search_tickets', {
  jql,
  fields: 'assignee,status,issuetype',
  max_results: 100,
  next_page_token: token,   // omit on the first page
});
```

Bare `YYYY-MM-DD` bounds are interpreted in the viewer's own Jira timezone, so Jira does the
calendar-day bucketing. This removes the DST hazard the earlier draft had to guard against —
there is no client-side date arithmetic left to get wrong.

A measured day (2026-07-30) returned 47 tickets in a single page, so most days need one
request; the pagination loop exists for outliers.

### Done vs Cancelled

Both sit under `statusCategory = Done`, so the split is client-side on `status.name`:
`Cancelled/ No Action` → cancelled, everything else → done. Mirrors the transition mapping
at `extension/src/api/jira.ts:638`. An unrecognised status name defaults to done and is
covered by a test, so the default is deliberate rather than incidental.

### Cache

`dayCache` is a `Map<'YYYY-MM-DD', Row[]>`. `ensureDays(dates)` fetches only the dates not
already present, in parallel with a small concurrency limit, and stores each day's rows under
its date.

Every window is the union of its days, so the cumulative behaviour the design wanted survives
the loss of per-ticket dates — just keyed by day instead. Loading 30 days makes the Day and
7-day tabs free; the chart at 30 days is already paid for. Only widening costs anything, and
only for the days not yet held.

**Initial load fetches 30 days** — the chart's default window and the widest thing on first
paint, at ~30 requests. 90 and 365 are explicit on-demand choices. The Year tab is ~365
requests and is expected to take on the order of a minute; that was raised and accepted.

Mirrored to `sessionStorage` in compact form so a reload within a session is instant.
Deliberately not `localStorage` — numbers shouldn't survive across days and look current.
On a quota error the mirror is skipped and the cache stays in memory only.

### Derivation

Everything downstream is pure functions over the cached day-map; no further queries. There is
no client-side date arithmetic at all — Jira buckets by calendar day via the query bounds, so
the earlier DST hazard is designed out rather than guarded against.

## Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `jiraClient` | `fetchDay(date)`. Owns the JQL, `MagicTools.call`, pagination and field selection for one calendar day. Returns `{ assignee, workType, outcome }[]`. | `MagicTools` |
| `dayCache` | `ensureDays(dates, onProgress)`. Sole decider of what still needs fetching; holds `Map<date, Row[]>`, mirrors to `sessionStorage`. | `jiraClient` |
| `aggregate` | Pure: `totalsFor`, `byAssignee`, `byWorkType`, `dailySeries`. Operates on a day-map. | nothing |
| `dates` | Pure: `lastNDates(n, today)` → `['YYYY-MM-DD', …]`, and `nextDate(d)`. | nothing |

Nothing above `jiraClient` knows Jira's response shape. Rows carry no timestamp — the day is
the map key.

## Components

| Component | Responsibility |
|---|---|
| `App` | Holds selected period, chart window, and expanded row keys (a `Set` — the accordion allows several open). Orchestrates `dayCache`. |
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

The year fetch is the slow path — ~365 day-queries. `dayCache` reports progress as days
resolve and the board renders partial results with "loaded N of M days" rather than a blank
spinner. Days are fetched newest-first so the chart fills from the right and the most
relevant numbers appear soonest.

## Failure modes

- **Partial fetch.** A day whose fetch fails is marked missing rather than treated as zero.
  The chart shows a gap at that date, the board shows a retry with rank suppressed, and the
  other days stay cached. A silently under-counting leaderboard is worse than an error, and a
  failed day rendering as 0 is exactly that failure.
- **Automation tickets reappearing.** The `summary !~` clause is the **only** thing excluding
  them now — verified present under `statusCategoryChangedDate`. If Workato ever changes the
  summary text, ~5 phantom tickets a day silently join roster members' counts. Re-check
  whenever a number looks inflated.
- **Reopened and re-closed tickets.** `statusCategoryChangedDate` reflects the *most recent*
  category change, so a ticket closed in June, reopened, and closed again in August counts
  under August and is absent from June. Historical days can therefore change retroactively.
  This is inherent to the only available field; it is not a bug to fix but a caveat to state
  on the page.
- **`sessionStorage` quota.** Compact form; on quota error, in-memory only.
- **`MagicTools` unavailable.** Explicit "can't reach Jira — check VPN and MCP session"
  state with retry. Never render zeroes on failure; zeroes look like a real answer.

## Testing

Vitest over `aggregate`, `dayCache` and `dates` only. Components stay untested — their bugs
are visible; these aren't.

Cases that matter:

- `lastNDates` boundary: 7 days means 7 date strings, and the newest is today.
- Cache reuse: `ensureDays` for 30 days then 7 days issues **zero** further fetches, and the
  7-day window returns a strict subset. This replaces the old double-count test — the failure
  mode is now redundant refetching rather than double-counting, since days are keyed.
- Partial failure: one day's fetch rejecting leaves the other days cached and marks that date
  missing, rather than poisoning the whole range.
- Unrecognised status name falls to done.
- `Other` and `Unassigned` classification; totals reconcile with the sum of rows.

No DST test — there is no client-side date arithmetic left to get wrong. Jira does the
bucketing via the query bounds.

Plus one manual check worth more than any of them: for a single window, compare the
dashboard total against the same JQL run directly in Jira. Disagreement means the exclusion
or bucketing logic is wrong.

## Build

```
~/projects/wocoo-analytics/
  src/          dates.js · jiraClient.js · dayCache.js · aggregate.js · components.js · tokens.css
  test/         dates.test.js · aggregate.test.js · dayCache.test.js
  build.js      assembles src/ into dist/index.html
  dist/
```

`npm test` then `npm run build`, then deploy `dist/index.html` with `magic_site_upload`.
Tailwind v4 with Wealthsimple tokens is auto-injected by Magic — do **not** bundle it. React
and `@babel/standalone@7` still come from CDN script tags; they are not injected.

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

**These tickets carry no `resolutiondate`** — `summary ~ "Eligibility Confirmation Request"
AND resolutiondate >= -30d` returns nothing, while `resolutiondate IS EMPTY` returns them.
That briefly looked like it made exclusion unnecessary. **Finding §4 overturned that**:
`resolutiondate` is unusable project-wide, and under `statusCategoryChangedDate` these
tickets are plainly visible. The `summary !~` clause is the exclusion mechanism.

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
grows past five, the palette is exhausted and someone has to decide what gives. Note this is
already tight: `Unassigned` is a seventh row on the board, so it takes a neutral grey rather
than a categorical colour and is excluded from the chart.

### 4. There is no per-ticket completion timestamp — the architecture changed

Found while writing the implementation plan, before any code was written.

`resolutiondate` is **dead in WOCOO**. `project = WOCOO AND resolutiondate >= -365d` returns
exactly one ticket in the entire year (WOCOO-18062, December 2025), while five tickets entered
Done in the last seven days carrying no resolution date at all. The workflow never sets one.
Every query in the previous draft would have returned nothing, and the dashboard would have
rendered all zeroes — which the spec itself warns is the dangerous failure, because zeroes
look like a real answer.

The replacement is `statusCategoryChangedDate`, which filters correctly. But the MCP tool
`jira_search_tickets` maps a fixed set of output keys and **has no key for it** — requesting
it in `fields` returns nothing, while `created` and `updated` populate normally. So the field
is filterable but not readable.

`updated` was rejected as a substitute: WOCOO-26104 was created 1 Aug and updated 3 Aug
because someone commented after it closed, so day-bucketing on `updated` drifts later with no
way to detect which tickets are affected.

Hence one query per calendar day, with the day carried by the query. The tiles, leaderboard
and drill-down never needed a timestamp — their window is the query — and making the chart
day-keyed lets every board window be the union of its days, which restores the cumulative
caching the original design wanted.

**Volume revised upward.** A measured day (2026-07-30) held 47 tickets, so ~17,000 category
changes a year — higher than §2's estimate because a day's query also catches old tickets
being closed (WOCOO-23338 is months old). The Year tab is ~365 requests.

**Worth reporting upstream:** the detached hex chips are a bug in a shared Wealthsimple
design file. Anyone reading data-viz values off that page today gets greens.

Figma: `https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/%F0%9F%9F%A0-Mint-DS-Web-1.0--Patchwork-?node-id=4515-3262`

## Out of scope

Ticket-level lists, SLA or cycle-time metrics, per-tier breakdowns, exports, date-range
pickers beyond the four windows, and any write path back to Jira.
