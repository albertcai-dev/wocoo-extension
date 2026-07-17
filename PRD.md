# WOCOO Triage Extension — Product Requirements Document

**Author:** Albert Cai (with Claude)
**Status:** Draft v0.1
**Created:** 2026-06-08
**Last updated:** 2026-06-08

---

## 1. TL;DR

A Google Chrome extension that augments the Wealthsimple Cash & Card Operations (WOCOO) Jira triage workflow with a docked sidebar, an inline-on-Jira UI, and a power-user tab. **v1 covers the most-used triage actions in-context:** a ticket-in-context sidebar that activates on WOCOO Jira pages, exposing ticket details and the live Zendesk transcript (scraped from the embedded widget DOM), plus the most-used write actions (transition, comment, assign), the full **Move-to-other-board workflow** (EOC/PFO/CRED/FRAUD), and the full **Overpayment Triage workflow** rendered inside the side panel. The eventual goal is **full replacement** of the existing `wocoo-triage-v3` Magic site as the team's daily triage tool — but v1 ships the workflows that benefit most from in-context UX, leaving Inquiry Removal / Koho email / Parse Transcript / Ask Guru in v3 for now.

---

## 2. Background & Motivation

### Today's tool: `wocoo-triage-v3` Magic site
WOCOO associates currently triage tickets through a single-page Magic-hosted React app at `magic.w10e.com/albert.cai/wocoo-triage-v3`. It hosts every workflow built in the last several months: ticket queue view, the Move modal (EOC/PFO/CRED/FRAUD), Overpayment Triage, Inquiry Removal (TransUnion letter + email), Koho email, i2c copy-paste card, Parse Transcript (re-diarize a Zendesk call), and Ask Guru (LLM grounded in WOCOO Notion board + Guru cards). It is the team's primary triage interface.

The Magic site works. This PRD is **not** about replacing it because it's broken — it's about reaching capabilities the Magic site fundamentally cannot have.

### The structural limit the Magic site hit
The Magic site is constrained by browser security: it cannot read the DOM of `wealthsimple.atlassian.net` or any other site. This blocks the single highest-leverage feature an "in-context" triage tool could have:
- **Auto-reading the Zendesk-for-Jira widget transcript** lives in the Jira page's DOM. We tried two routes to reach it from the Magic site — (a) the MCPLocker Zendesk MCP, which is write-only (`add_private_comment` + `get_current_user`), and (b) an Apps Script bridge using a Zendesk API token, which couldn't proceed because the team can't obtain a Zendesk API key. We are out of ways to get that transcript text without DOM access.

A Chrome extension *can* read that DOM via a content script. It is, structurally, the only way to close the gap.

### Secondary motivations
- **Spatial co-location.** A docked sidebar sits next to Jira/Zendesk so the agent doesn't context-switch tabs. This is the canonical Chrome-extension UX win.
- **Inline action surfacing.** Buttons on the Jira ticket page itself ("Move", "Triage", "Done") put workflows where the work happens.
- **Long-term auth model improvements.** v3 leans heavily on per-viewer Magic-runtime MCP (MagicTools, MagicAI, MagicStorage). An extension can use direct per-user OAuth flows where appropriate, which is cleaner for audit and works for users outside the Magic runtime.

### What we are explicitly *not* solving in v1
- Building a queue view (v3 already does this fine).
- Replacing every v3 workflow (Inquiry Removal, Koho email, Parse Transcript LLM, Ask Guru, Overpayment Triage). These come in later phases. v3 stays available for them.
- Scaling beyond the immediate ~4-person Cash & Cards team.

---

## 3. Audience & Use Cases

### Primary users (v1)
**Wealthsimple Cash & Card Operations associates** — approximately 4 people today. They spend most of their workday in the WOCOO Jira board triaging client-initiated credit/prepaid/cash tickets, communicating internally with CX, and actioning issues across systems (Atlas, Preset, i2c, KOHO Admin, Gmail, etc.).

### Future audience (vNext)
**Wider Wealthsimple CXA / support agents** who triage in Jira boards beyond WOCOO. The architecture should not preclude this, but v1 does not actively serve them.

### Primary use cases (v1)
1. **"I just opened a Jira ticket — what's the context?"**
   Agent navigates to a WOCOO ticket in Jira. The extension's sidebar (or inline panel) auto-shows the ticket's relevant fields, identity link, the linked Zendesk ticket's transcript (DOM-scraped, no API needed), and a concise summary.
2. **"I need to action this ticket."**
   From the sidebar, the agent transitions status (e.g. Done), adds a comment, reassigns, or starts the Move workflow — without leaving the Jira page.
3. **"This ticket needs to go to another board (EOC/PFO/CRED/FRAUD)."**
   Agent clicks Move. The same field-driven workflow as v3's modal, ported to the extension, calling Jira's REST API directly via per-user OAuth.
4. **"This is a credit card overpayment — run the full Triage workflow."**
   Agent clicks "Start Overpayment Triage" from the side panel's quick-actions cluster. The panel transforms into an 8-step workflow (pull ticket details → acceptance criteria → verify balance → create REIMB ticket → admin debit reminder → post comment → transition to done → complete). All v3 functionality preserved; the side panel is the new home.

### Use cases v1 does *not* serve
- Looking at the queue without being on a specific ticket. (Stay in v3 or use Jira itself.)
- Running Inquiry Removal / Koho email / Parse Transcript / Ask Guru workflows. (Stay in v3 for these — they have their own complexity and aren't the highest-frequency triage actions.)

---

## 4. Goals & Success Metrics

### Primary goal
Cut median triage time per ticket — measured as time from ticket open (assignee starts engaging) to first-touch action (comment, transition, or move).

### Why this metric
It's the single most direct measure of whether the extension's "in-context" claim is real. If the sidebar truly removes context-switches, the time-per-ticket drops. If it doesn't, the form factor wasn't the bottleneck.

### How we'll measure
- **Baseline:** week of usage logs from the existing v3 site (if available via the moves/errors sheets we already write to) plus a week of self-reported timing from associates.
- **v1 measurement:** the extension instruments its own actions with timestamps (locally — no telemetry pipeline) and shows the associate their median time on a private dashboard. Honest about not being a controlled experiment.

### Secondary goals (tracked, not gating)
- **Adoption:** all 4 associates use the extension as their default triage entry point within 4 weeks of v1 release.
- **Coverage:** % of WOCOO tickets where the agent's first action originated from the extension (vs. going directly to Jira).

### Out-of-scope goals for v1
- Reducing escalations or improving ticket-resolution accuracy (different problem).
- Improving the *quality* of agent responses (that's the Ask Guru work, not here).
- Org-wide rollout metrics.

---

## 5. v1 Feature Scope

### 5.1 Mode-based form factors (all three ship in v1)

The user explicitly asked for all three. Each has a distinct primary use case.

| Mode | Primary use | When to reach for it |
|---|---|---|
| **Side panel (docked sidebar)** | Always-visible ticket-in-context | While working in Jira / Zendesk — sticks around as you tab — user-resizable 280–520px, width persists |
| **Inline injection on Jira pages** | One-click action buttons added to Jira's UI itself | Click Move/Done/Comment without leaving the ticket page |
| **Full-page tab** | Power-user mode for batch actions | Working through several tickets in a row, full screen |

The three share a single React app surface (one component tree), rendered into three different host shells. All three sync state through `chrome.storage.session` so opening a ticket in one mode reflects in the others.

### 5.2 Core features (v1)

#### F1 — Ticket-in-Context Sidebar
- Listens for navigation to `wealthsimple.atlassian.net/browse/WOCOO-*` (and similar Jira URLs).
- Reads ticket key from URL.
- Calls Jira REST `GET /rest/api/3/issue/{key}` with per-user OAuth to populate: summary, description, status, priority, assignee, reporter, key custom fields (Identity ID, Account ID, Tier, Client Email).
- Renders the ticket details vertically: header (key, summary, badges), identity link to Atlas, key custom fields, description, recent comments.
- Cached locally so the panel doesn't re-fetch on every navigation tick.

#### F2 — Zendesk Transcript Auto-Capture (DOM scrape)
- Content script on `wealthsimple.atlassian.net` waits for the Zendesk-for-Jira widget to render.
- Locates the transcript text within the widget DOM (selector to be confirmed by inspecting the widget — likely a `.message-body` or `.comment-text` within the Zendesk iframe).
- *If* the Zendesk widget is itself a cross-origin iframe (likely is), the scrape can only work if either (a) Atlassian Forge / the widget posts the transcript text out via `postMessage` (unlikely), or (b) the extension's content script is granted permission on the Zendesk iframe origin too (`*.zendesk.com` and `*.atlassian.net`). Add Zendesk hosts to `host_permissions`.
- Pushes captured transcript text to the sidebar's "Transcript" tab.
- "Re-diarize" / "Summarize" actions in v1 just route the text to v3's `Parse Transcript` tool in a new tab pre-populated (since v1 doesn't include LLM yet). vNext brings LLM into the extension itself.

> **Risk:** the Zendesk widget's DOM structure can change. v1 should treat the scrape as best-effort with a "couldn't find transcript — paste here" fallback.

#### F3 — Quick Actions (Jira write API)
The minimum write actions an associate uses constantly:
- **Transition status** (specifically: Move to Done — `transition_id: 251` per v3 conventions). Surface common transitions as buttons; show full transition list as a fallback.
- **Add comment** — plain text input + post via `POST /rest/api/3/issue/{key}/comment`. Mentions / formatting deferred to vNext.
- **Reassign** — assignee picker. Defaults to the four WOCOO associates.

#### F4 — Overpayment Triage Workflow (in-panel)
Full port of v3's most complex workflow. Rendered inside the side panel (not as a modal) — the panel content transforms from "ticket context" into a step-by-step workflow view, with a "← Back to ticket" affordance at the top.

Steps (mirrors v3 exactly):
1. **Pull ticket details** — auto-fetched on workflow start. Surfaces Identity ID, Amount, Tier, Account ID, Client Email, Reporter. All editable; missing fields can be filled manually.
2. **Acceptance Criteria** — Amount ≥ $1,000 check, Tier display, Approver assignment (Luke if <$5K, Amanda if ≥$5K). If criteria not met, surfaces the Decline & Comment flow.
3. **Verify Balance** — quick-links to Preset / Atlas / i2c with Identity ID pre-filled on clipboard. "Verified" / "Balance differs" branches.
4. **Create REIMB ticket** — all required fields shown and editable. Creates via per-user Jira OAuth (replacing the bridge call v3 uses).
5. **Admin Debit in i2c** — opens i2c link, shows the exact amount. Manual check-off (extension never clicks Confirm in i2c).
6. **Post Comment on WOCOO ticket** — pre-filled comment text, editable. Review then Post via Jira API.
7. **Move WOCOO ticket to Done** — transition button.
8. **Complete** — success state with summary; option to return to ticket-in-context view or close.

At default width (~360px) the steps fit comfortably. At ~280px, action buttons stack and labels truncate. At ~520px, comment editing is roomier. Same container-query pattern as the rest of the side panel.

#### F5 — Move Ticket Workflow (EOC / PFO / CRED / FRAUD)
Port of the v3 Move modal:
- Destination picker (EOC, PFO, CRED, FRAUD).
- Source ticket detail loader (reuses F1's ticket fetch).
- Per-destination required fields:
  - EOC: Client Status (Core/Premium/Generation), Problem Area (157-option typeahead, Payment Card group pinned), Account ID, Identity ID.
  - PFO: Work Type (Credit Card: Delivery Issue / Prepaid Card: Delivery Issue / Cheques: Delivery Issue — API-supported subset), Identity ID.
  - CRED: Task issue type (no extra fields — pulls from source summary). Includes the issue-type fix from earlier session.
  - FRAUD: UI-only (extension links out to Jira, no API call).
- Confirm step.
- Calls `POST /rest/api/3/bulk/issues/move` with the per-user OAuth token (same endpoint v3 uses via the Apps Script bridge — but here called directly from the extension).
- Logs to the existing Errors/Moves sheet via a small `/exec` call to the existing Apps Script bridge (lowest friction reuse).

#### F6 — Settings & Auth
- One-time Atlassian OAuth flow on first install.
- "Sign in to Jira" button kicks off OAuth, stores the refresh token in `chrome.storage.local` (per-user, per-device).
- Minimal "About / Connected Accounts" page.

### 5.3 What v1 explicitly does NOT include

| Feature | Why deferred |
|---|---|
| Queue / "All Tickets" table | v3 already does it fine. Adds significant scope. |
| LLM (Ask Guru / Parse Transcript re-diarization / summarization) | Big auth + cost question (Anthropic key). Defer until v1 validates the core form factor. |
| Notion / Guru grounding | Same as LLM — needs API keys / OAuth flows we don't have yet. |
| Inquiry Removal letter | Reuse v3 for this; no extension advantage. |
| Koho email | Reuse v3; needs Apps Script bridge for Gmail send. |
| Slack daily summary | Magic site / Apps Script already does this. |
| Preset queries | New capability — defer to a future phase with its own design. |

---

## 6. Technical Architecture (high-level)

This is a PRD, not a tech design. The full tech-design doc will be its own artifact. But a few choices materially shape v1 scope:

### Manifest version
**Manifest V3** (required by Chrome for new extensions). Implications:
- No `eval` / Babel-in-the-browser. JSX must be pre-compiled — requires a build step (Vite recommended). The Magic site's instant-edit workflow does not carry over.
- Background work runs in a service worker (no long-lived background page).
- Strict Content Security Policy.

### Component tree
- One React app (Vite + TypeScript).
- Three host shells: side-panel HTML, content-script-injected DOM in the Jira page, full-page extension tab.
- Shared state via `chrome.storage.session`.
- **Side panel sizing:** Chrome's native side-panel API supports user-drag-to-resize out of the box; Chrome persists the width across sessions. The extension declares `default_width: 360` in the manifest and the side-panel HTML uses CSS container queries to reflow between **280px (compact) and 520px (comfortable)** — see `design-brief.md` §8b for the three reference layouts.

### Permissions
- `host_permissions`: `*://wealthsimple.atlassian.net/*`, `*://*.zendesk.com/*`, `*://id.atlassian.com/*`, `*://auth.atlassian.com/*`.
- `permissions`: `storage`, `sidePanel`, `tabs`, `scripting`, `identity` (for OAuth).
- `content_scripts`: one entry for `wealthsimple.atlassian.net/*`.

### Auth
- Atlassian OAuth via Chrome's `chrome.identity.launchWebAuthFlow`.
- Refresh token stored in `chrome.storage.local`.
- Reuse the existing OAuth app credentials from the Apps Script bridge if possible (saves IT-engagement work). Risks: redirect URI may not be reusable across two clients — may need a new Atlassian OAuth app.

### Bridge reuse
- The existing Apps Script bridge stays running. The extension calls its `/exec` endpoint for the Move-sheet logging only (low-friction reuse). Everything else is direct Jira REST.

### Distribution (v1)
- **Unpacked sideload.** Per the user's choice. We ship a ZIP and Loom video for each teammate to install via `chrome://extensions` → Developer Mode → Load Unpacked.
- **Risk:** Wealthsimple-managed Chrome may block Developer Mode. If so, fall back to private Web Store listing.
- vNext: Workspace-managed deployment via IT.

### Build & release
- Repo at `~/projects/wocoo-extension` (created today).
- Vite + TypeScript + React.
- GitHub repo, CI for `npm run build` producing a `dist/` directory.
- Versioning: semver. Each release tagged, ZIP attached.

---

## 7. Risks & Open Questions

### High risk
1. **Zendesk widget DOM may not be scrapable.** The Zendesk-for-Jira app likely renders inside a cross-origin iframe. If true, the content script cannot reach into it without permission on the Zendesk origin AND a cooperative `postMessage` channel. v1 must include a "couldn't capture — paste here" fallback so the tool degrades gracefully. Will confirm in spike during week 1 of dev.
2. **WS-managed Chrome may block sideload (Developer Mode).** If true, distribution falls back to private Chrome Web Store ($5 dev account, review process), which adds 1-2 weeks of process.
3. **Atlassian OAuth app reuse.** May not be able to share the existing Apps Script bridge's OAuth client — need to confirm redirect URI handling. If we need a new app, that's a security review with WS IT.

### Medium risk
4. **DOM scrape brittleness.** Atlassian periodically updates Jira's UI. The content script must be defensive — selectors with fallbacks, "couldn't find" UI rather than silent failure.
5. **Inline-injection UX.** Adding buttons into Atlassian's own UI without breaking accessibility / Atlassian Forge / future Jira layout changes is a known headache. v1 may ship only the side panel and full-page tab if inline injection proves brittle.
6. **State sync across modes.** `chrome.storage.session` works but isn't instant — there may be visible lag between mode switches. May need to fall back to message passing.

### Low risk (worth naming)
7. **No telemetry pipeline.** v1's success-metric measurement is local-only. We rely on associates self-reporting.

### Open questions to resolve before tech-design
- Q1: Does the Zendesk widget expose its transcript text in a content-script-reachable location?
- Q2: Can we reuse the Apps Script bridge's Atlassian OAuth client, or do we need a new app?
- Q3: Does WS-managed Chrome allow Developer Mode sideloading on associate devices?
- Q4: What's the right cadence to update the extension during v1 — weekly auto-updated ZIP? Manual on demand?

---

## 8. v1 Release Plan (rough)

| Phase | Week | Deliverable |
|---|---|---|
| **Spike** | Week 1 | Validate Zendesk widget scrape. Validate Jira OAuth flow. Decide on side-panel-only vs all-three-modes for v1. |
| **Foundation** | Week 2 | Vite/React scaffold. OAuth working. Jira fetch + render in side panel. F1 (Ticket-in-Context). |
| **Actions** | Week 3 | F3 (Quick Actions) + F2 (Transcript scrape, with paste fallback). |
| **Move workflow** | Week 4 | F5 (Move modal port). |
| **Overpayment Triage** | Week 5 | F4 (in-panel 8-step workflow port — REIMB create via OAuth, all v3 steps). |
| **Polish + sideload** | Week 6 | Build ZIP, Loom, install with two teammates. |
| **Iterate** | Week 7 | Feedback round, fixes, broader team install. |

Calendar caveat: dev work is fit around existing operational duties. Real-time is likely longer than the week-by-week above suggests.

---

## 9. Future Phases (vNext, vNext+1)

### vNext
Bring the LLM workflows from v3 into the extension natively:
- Ask Guru (with Notion / Guru API direct integration via per-user OAuth).
- Parse Transcript re-diarization (Anthropic API direct, replacing MagicAI).
- Overpayment Triage flow.
- Inquiry Removal — keep the Apps Script bridge as the doc-creator/emailer; the extension is the front-end.
- Koho email — same pattern.

### vNext+1
- Queue / "All Tickets" view (replacing the v3 home screen).
- Slack notification integration.
- Telemetry pipeline so success-metric measurement isn't local-only.
- Workspace-managed distribution via WS IT.
- Broader CXA org rollout.

---

## 10. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-08 | Full replacement of v3 is the long-term goal, but v1 is narrow. | Validate the form-factor hypothesis with the smallest possible bet before reimplementing v3's surface area. |
| 2026-06-08 | All three form factors (side panel + inline + tab) in v1. | User chose ambitious form factor. Mitigated by the small v1 feature set. |
| 2026-06-08 | v1 integrations limited to Jira read/write. | Defers Anthropic / Notion / Guru / Gmail re-auth work until v1 proves the form factor. |
| 2026-06-08 | Distribution: sideloaded developer-mode for v1. | Zero IT engagement needed to test with 4-person team. Workspace deployment is a vNext concern. |
| 2026-06-08 | Success metric: median triage time per ticket. | Most direct measure of whether in-context UX is real. Other metrics tracked but not gating. |
| 2026-06-08 | No queue view in v1. | v3 already does this well; extension's unique value is in-context, not list-view. |
