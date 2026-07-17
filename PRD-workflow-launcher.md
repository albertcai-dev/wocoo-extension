# WOCOO Workflow Launcher — Product Requirements Document

**Author:** Albert Cai (with Claude)
**Status:** Draft v0.1 — *the practical v1 of the WOCOO extension*
**Created:** 2026-06-10
**Last updated:** 2026-06-10
**Related:** `PRD.md` (the longer-term sidebar-replacement vision)

---

## 1. TL;DR

A Chrome extension feature that **collapses a 30–60-second tab-opening + login + navigation + form-filling sequence into a single click** when an agent is triaging a WOCOO Jira ticket. The extension reads the ticket's work type and key fields, then opens the right set of tools (Atlas, i2c, KOHO Admin, Preset, Google Doc templates) with the client's context pre-loaded where each tool allows it.

This is the **practical v1** of the WOCOO Chrome extension. It ships first because the value is concrete, the security model is clean (uses each tool's existing SSO — never stores credentials), and it doesn't overlap with what the existing `wocoo-triage-v3` Magic site already does well. The larger sidebar / queue / quick-actions vision in `PRD.md` layers on later.

---

## 2. Background & Motivation

### The friction the agent experiences today

For each WOCOO ticket — many per day, per agent — the workflow looks roughly like this:

1. Open the Jira ticket in `wealthsimple.atlassian.net`.
2. Read the work type and client details.
3. Open Atlas in a new tab. Paste/search the Identity ID.
4. Open i2c in another tab. Log in (or ride SSO), navigate to the relevant section (e.g., Administrative Services → Admin Debit, or the card search), search for the client by card number or identifier.
5. If it's a Prepaid Card ticket, also open KOHO Admin and find the client.
6. For balance-related questions, open Preset and filter the relevant dashboard to the client.
7. Act in the appropriate tool.
8. Return to Jira, comment, transition.

Steps 3–6 are the bulk of "wasted" wall-clock time per ticket — context-switching, copying identifiers between tabs, navigating menus, waiting for filtered views to load. A conservative estimate: **30–60 seconds per ticket on tab orchestration alone**. Across 4 agents × ~30 tickets/day = 1–2 hours/day of pure overhead.

### What the v3 Magic site does and doesn't solve

The v3 Magic site (`magic.w10e.com/albert.cai/wocoo-triage-v3`) provides "Open Atlas / Open Preset / Open i2c" links inside its triage modals — but those links land on the *root* of each tool, not on the client's filtered view. The agent still has to search/navigate manually. The Magic site cannot do better because it can't read DOM or inject scripts into other origins.

### What only a Chrome extension can do

- Open multiple tabs at once with context-aware URLs.
- Pre-fill search forms on destination tools that don't accept URL params (via content-script injection).
- Detect the Jira ticket the agent is currently viewing and use its fields as the source of truth — no manual paste.

### What v1 of this launcher does NOT solve

- Doesn't replace the v3 Magic site (still in active use).
- Doesn't perform write actions in destination tools (extension never clicks "Confirm Debit" for the agent — agent always actions manually).
- Doesn't store passwords or bypass SSO.
- Doesn't handle the LLM, Move, Inquiry Removal, or Koho-email flows (those stay in v3).

---

## 3. Audience & Use Cases

### Primary users
4 Wealthsimple Cash & Card Operations associates. Same as the broader extension PRD.

### Primary use cases

**UC1 — "I just got a Prepaid Card ticket. Get me to the tools."**
Agent opens WOCOO-22597 (Prepaid Card: Transactions, declined code 51). Clicks **Action ticket** in the extension. Three tabs open in parallel:
- Atlas — filtered to this client's identity overview
- i2c — Card search page, with the client's identifier pre-filled and submitted
- KOHO Admin — search page, pre-filled

The agent investigates each tab, returns to Jira, comments, transitions. **Goal: ~10 seconds elapsed instead of ~45.**

**UC2 — "This is a Credit Card overpayment. Different tools needed."**
Agent opens an overpayment ticket. Clicks **Action ticket**. The extension recognizes the work type and opens:
- Atlas (filtered)
- i2c → Administrative Services → Admin Debit page (deep-linked)
- Preset → overpayment dashboard, filtered to this client

**UC3 — "I'm looking up a custom-statement request."**
Credit Card: Statements ticket. Clicks **Action ticket**. Opens:
- Atlas
- The Brian Sinclair statement template Google Doc (read-only — agent makes a copy manually)

**UC4 — "I want to manually pick which tools to open."**
The auto-detected work type is wrong, or the agent wants a non-standard combination. They click a "Customize" affordance and pick from a checklist of available tools, then launch.

### Out of scope use cases

- Bulk-action across multiple tickets in one click.
- Workflow customization per-agent (e.g., "always also open WOCOO Wiki for me"). Could come in vNext if agents diverge in habits.

---

## 4. Goals & Success Metrics

### Primary goal
**Cut wall-clock time spent on tab orchestration per ticket by ≥50%.** Target: median 30+ seconds saved per ticket on tools-opening + form-filling.

### Measurement
Same caveat as the broader PRD — measurement is best-effort and self-reported. v1 instruments locally: each "Action ticket" click logs a timestamp + work type to `chrome.storage.local`, and the agent can see a small "saved ~30 minutes this week" stat in the extension's settings. Honest about not being a controlled experiment.

### Secondary goals
- **Adoption:** all 4 agents use it for ≥80% of relevant tickets within 4 weeks.
- **Reliability:** auto-fill on destination tools succeeds ≥90% of the time (failures fall back to "the tab opened but the search wasn't filled" — not a crash).
- **Maintainability:** new workflow profiles (work type → tools) can be added in a single config file without code changes.

---

## 5. Feature Scope (v1)

### F1 — Action Button (inline injection on Jira ticket pages)
A single primary button appears on every `wealthsimple.atlassian.net/browse/WOCOO-*` page. Label: **🚀 Action this ticket**. Hover: tooltip says "Open the tools needed for this work type."
- Reads work type, Identity ID, Account ID, ticket key from the Jira page DOM.
- On click: dispatches the matching **workflow profile** (see F2).
- Visually defers to Jira's UI — small pill, neutral background, only the WOCOO icon to identify the extension's origin (per the design brief's inline-toolbar constraints).

### F2 — Workflow Profiles (per work type)
A config file ships with v1 mapping work types to tool sets. Each profile is:

```
profile = {
  workType: "Prepaid Card: Transactions",
  tools: [
    { name: "Atlas", url: "https://atlas.wealthsimple.com/identity/{identityId}/overview/?ticketId={ticketKey}" },
    { name: "i2c", url: "https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp", postLoad: { type: "fillAndSubmit", selector: "#searchBox", value: "{identityId}" } },
    { name: "KOHO Admin", url: "...", postLoad: { ... } }
  ]
}
```

Initial profiles for v1 (final list TBD — see §10):
1. **Prepaid Card: Transactions** → Atlas + i2c + KOHO Admin
2. **Credit Card: Transactions** → Atlas + i2c
3. **Credit Card: Overpayment** → Atlas + i2c (Admin Debit deep-link) + Preset (overpayment dashboard)
4. **Credit Card: Statements** → Atlas + Brian Sinclair Doc template
5. **Cash: E-transfers / Bill Payment** → Atlas + Preset
6. **Default fallback** (any unrecognized type) → Atlas only

### F3 — Auth handling (no credentials stored)
- **SSO tools (Atlas, Preset, i2c, KOHO Admin, etc.):** the extension opens the tool's URL in a new tab. Chrome shares the Okta session cookie — the tab loads authenticated.
- **Non-SSO tools (if any):** the extension lands the agent on the tool's login page. The agent uses Chrome's built-in autofill / their password manager. The extension **never** stores, transmits, or sees the credentials.
- **First-run experience:** a one-time "Sign in to each tool" checklist screen. The extension opens each tool in turn so the agent confirms SSO works for each one. No credentials captured.

### F4 — Content-script auto-fill (best-effort)
For destination tools that don't accept URL params (i2c, KOHO Admin):
- Inject a tool-specific content script on first load.
- Wait for the target form field to appear (selector list per tool).
- Fill the value from the launch context (passed via `chrome.storage.session`).
- Submit if safe (search forms — yes; admin-debit forms — never; settings forms — no).
- If selectors don't match (DOM changed), surface a small "Couldn't auto-fill — paste from clipboard ↓" affordance. The Identity ID is already on the agent's clipboard at this point (the extension also copies it on launch).

### F5 — Customize Launch
A small ▾ caret next to **Action this ticket** opens a checklist of the tools in this work type's profile + any extras. Agent unchecks tools they don't need or checks extras. Clicking **Launch** opens the customized set.

### F6 — Settings
- **Workflow profiles** view — read-only in v1, agent can see the work-type → tools map. In vNext, editable.
- **Per-tool selectors and URLs** — list of which tool selectors / URLs the extension uses, so an agent can flag when one is broken.
- **Stats** — count of times Action this ticket was clicked, by work type, and an estimated time saved (clicks × 30s).
- **About** — version, docs link.

### What v1 does NOT include
- No write actions in destination tools.
- No credential storage of any kind.
- No queue/list view (lives in v3).
- No LLM / Ask Guru / Parse Transcript.
- No editing workflow profiles in the UI (config-file only for v1).
- No analytics dashboard / org-wide reporting.

---

## 6. Technical Architecture (sketch)

Lives in the **same Chrome extension codebase** as the larger `PRD.md` vision. v1 only ships the launcher functionality; sidebar / Move / Quick Actions are vNext.

- **Manifest V3.**
- **Permissions:** `storage`, `tabs`, `scripting`. **Host permissions:** `*://wealthsimple.atlassian.net/*` (read Jira DOM), `*://atlas.wealthsimple.com/*`, `*://wealthsimplecs.mycardplace.com/*` (i2c), KOHO Admin host, Preset host. Each new tool we add gets its own host permission.
- **Content scripts:**
  - One on `wealthsimple.atlassian.net/browse/*` — injects the Action button, reads ticket fields.
  - One per destination tool — runs on its origin, listens for an auto-fill instruction in `chrome.storage.session`, performs the fill.
- **Service worker:** routes "Action this ticket" → opens tabs → seeds storage.
- **No external service / API calls in v1** (no Anthropic, Notion, Guru, Apps Script bridge for this feature).
- **Workflow profiles** live in `src/profiles.json` (or `.ts`) — single file, easy to edit.

---

## 7. Security & Privacy

- **No credentials stored.** Ever. The extension does not have a settings field for usernames or passwords for any tool.
- **No client PII transmitted off-device.** Identity IDs, card numbers, etc. flow only between tabs the agent already has access to.
- **Host permissions are scoped** to the tools the launcher actually uses — not `<all_urls>`.
- **Read-only on Jira.** v1 does not write to Jira. (Write actions are vNext.)
- **Defensive against DOM drift.** Each destination tool's selectors are wrapped in a `try/catch` with a fallback UI — the worst-case failure is "the tab opened but the form didn't fill," which is no worse than today's manual flow.
- **Audit-friendly.** Every tab opened is initiated by an explicit agent click. The extension does not pre-fetch, pre-load, or scrape destination tools in the background.

---

## 8. Risks & Open Questions

### High risk
1. **i2c / KOHO Admin selector brittleness.** These are third-party tools we don't control. If they redesign, content-script auto-fill breaks. Mitigation: defensive selectors + graceful fallback to "tab opened, paste yourself" + a one-day fix turnaround when it does break.
2. **Some tools may have an iframe-of-iframes architecture** that blocks content-script fills (e.g., i2c is a legacy app — possible). Mitigation: validate during a 1-week spike before locking the v1 profiles list.

### Medium risk
3. **Workflow-profile drift.** Work types evolve, tools get added/removed. v1 has the profile in a config file but no UI to edit; agents have to flag issues and someone re-deploys. Acceptable for 4 agents; revisit at scale.
4. **Tab-opening UX.** Opening 3 tabs at once will switch focus to whichever opens last. Need to handle this — possibly open them in the background and only switch the agent to the first relevant one.

### Open questions (to resolve during a 1-week spike)
- **Q1: SSO truth.** For each of the destination tools (Atlas, i2c, KOHO Admin, Preset, others), is the agent's Okta session automatically valid when the URL opens in a new tab? Confirm by manual test on each.
- **Q2: URL parameter support.** For each tool, can client-identifier filtering be done via URL params? If yes, that's preferred over content-script fills. List per tool.
- **Q3: Content-script-friendly selectors.** For tools without URL params, what's the most stable selector for the search field? (e.g., does i2c have `id="searchBox"` or is it `class="dynamic-12345"`?) — gather during spike.
- **Q4: Workflow profile authority.** Who owns the canonical mapping of work type → tools? Albert? Team? Does the list need WS Ops Manager sign-off?

---

## 9. v1 Release Plan (rough)

| Phase | Week | Deliverable |
|---|---|---|
| **Spike** | Week 1 | Verify SSO for each target tool. Test URL-param filtering per tool. Identify auto-fill selectors. Lock the initial 5 workflow profiles. |
| **Scaffold** | Week 2 | Vite/TS/React extension skeleton. Manifest V3. Content script on Jira reads ticket fields. Action button injected. |
| **Profiles + launching** | Week 3 | Workflow-profile engine. Tab-opening with URL params. Content-script auto-fill for top 2 tools (i2c, KOHO Admin or whichever needs it most). |
| **Polish & sideload** | Week 4 | Customize Launch picker. Settings page. ZIP + Loom. Install with 2 teammates. |
| **Iterate** | Week 5 | Feedback. Add 2 more workflow profiles. Broader 4-person install. |

Real elapsed time depends on Albert's available ops-free hours.

---

## 10. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-10 | Workflow launcher ships first as the practical v1. | Concrete value, smaller scope, doesn't compete with v3, lower security surface. |
| 2026-06-10 | Single Chrome extension, two features (launcher + future sidebar). | Same audience, same OAuth setup, same install. Two extensions = double maintenance. |
| 2026-06-10 | **No credential storage. Ever.** | Storing passwords for i2c / KOHO Admin would violate WS Security policy and create personal risk. Use SSO + Chrome autofill instead. |
| 2026-06-10 | Workflow profiles in a config file for v1; no in-UI editing. | YAGNI for 4 agents; revisit when scaling. |
| 2026-06-10 | First-run is a "verify SSO on each tool" walkthrough, not a credential-capture flow. | Reinforces the security posture and onboards correctly. |
| 2026-06-10 | v1 covers 5 initial workflow profiles (Prepaid Tx, Credit Tx, Overpayment, Statements, Cash). | Cover the highest-frequency work types; expand from there. |

---

## 11. Relationship to `PRD.md` (the bigger sidebar plan)

`PRD.md` describes a longer-term, larger v1 of the extension: side panel, inline buttons, full-page tab, Move workflow, Quick Actions. This launcher PRD describes the **first ship** — a single inline button on Jira that solves one of the highest-frequency frictions in the daily workflow.

Both share:
- The same Chrome extension codebase.
- Manifest V3, Vite/TS/React scaffold.
- Per-user Atlassian OAuth (when the bigger PRD's Jira-write actions ship in vNext).
- Sideloaded distribution.

**Order of ship:**
1. **v1 (this PRD):** Workflow launcher only.
2. **v1.5:** Add inline Done / Move icon-buttons next to the launcher (small additions from the sidebar PRD).
3. **v2:** Ticket-in-context side panel + full Move workflow (from `PRD.md`).
4. **vNext:** LLM features, queue view, broader org rollout.

The design brief (`design-brief.md`) already specifies the inline toolbar's visual language. The launcher button is the first occupant of that toolbar.
