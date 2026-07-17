# Design Brief — WOCOO Triage Chrome Extension (v1)
**For:** claude.ai/design
**Companion to:** `PRD.md` (in this folder) — read PRD first if you want full product context.
**Last updated:** 2026-06-08

---

## How to use this document with claude.ai/design

Paste **Section 1 (Context)** + **Section 4 (Screens)** + **Section 5 (Components)** as your initial prompt. Treat Section 2 (Design System) and Section 6 (Visual Language) as constraints the design output must respect. Sections 7–9 are acceptance criteria. Iterate screen-by-screen rather than asking for everything in one shot.

---

## 1. Context (paste this into claude.ai/design first)

We're designing a Google Chrome extension for the **Wealthsimple Cash & Card Operations (WOCOO)** team — about 4 internal support associates who triage client-initiated credit/prepaid/cash tickets in Jira. The extension lives in three places at once:

1. **A docked side panel** — always-visible vertical column on the right edge of Chrome, shows the current Jira ticket's details and quick actions.
2. **Inline injection on Jira ticket pages** — small action toolbar added directly to `wealthsimple.atlassian.net` tickets so the agent can take action without leaving the page.
3. **A full-page extension tab** — power-user view at `chrome-extension://.../app.html` for batch work.

The single biggest UX win the extension has over the team's current web tool: when an agent opens a Jira ticket, the extension automatically **reads the linked Zendesk call transcript** from the page DOM and surfaces it in the panel. Today they copy-paste it manually.

**v1 scope:**
- Ticket-in-context sidebar (auto-loads current ticket + Zendesk transcript)
- Quick actions (transition status, comment, reassign)
- **Move-to-other-board workflow** (EOC, PFO, CRED, FRAUD) — modal, full port of v3
- **Overpayment Triage workflow** — in-panel 8-step workflow, full port of v3's most complex flow
- Settings / Atlassian OAuth

**v1 does NOT include:** a queue view, LLM features, Notion/Guru grounding, Inquiry Removal letter, Koho email, Parse Transcript LLM, or Ask Guru. Those stay in v3 / are vNext.

**🎯 Focus this design brief on three screens above all others:** Screen 1 (Ticket-in-Context Side Panel), Screen 6 (Move Workflow Modal), and Screen 9 (Overpayment Triage Workflow in Side Panel). These are the v1 differentiators. Everything else (empty/loading/inline/full-page/auth/settings) is supporting design.

The visual feel should match the rest of Wealthsimple's internal employee tools — quiet, dense-but-readable, financial-services serious. **No marketing flourish.** This is a tool people use 8 hours a day.

---

## 2. Design System — Wealthsimple Mint DS Web 1.0 (Patchwork)

**Source file:** https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/%F0%9F%9F%A0-Mint-DS-Web-1.0--Patchwork-?node-id=4515-2949

All visual decisions must come from this library. Confirmed available components and tokens (verified 2026-06-08):

### Components to use directly
- **Button** (component set with variants — primary, secondary, sizes)
- **Button Icon** (icon-only button — for the ⋯ menu, close X, etc.)
- **Text Button with Icon** (a low-emphasis text-only button — for "Open in Jira", "Atlas link", etc.)
- **Selector button** (toggle/segmented selection — for destination picker in Move modal)
- **Menu button** (dropdown menu trigger)
- **Option menu** (dropdown content)
- **Button Key Action Group** (grouped action cluster — *consider for the row of Done/Move/Triage buttons*)
- **Modal** (component set — the Move workflow modal uses this)
- **Navigation Button=Close** / **=Back** (modal headers, side panel close)

### Tokens (semantic variables — use, don't hardcode hex)
**Colors:**
- `Primary/FG UI/strong-fg` — primary text, icons, max contrast
- `Primary/FG UI/subdued-fg-title` — subdued titles, secondary text
- `Primary/FG UI/soft-fg` — labels, meta info
- `Primary/FG UI/inactive-fg` — disabled state
- Semantic palette also includes Positive / Warning / Negative / Highlight families — use these for status badges (Triage = Negative-ish, Back Office = Warning, Pending = Highlight, Done = Positive).

**Effects / Surfaces:**
- `high-card-stroke` (Patchwork Web) — bordered card surface
- `medium-card` / `high-card` (Mobile lib equivalents — match style if Web doesn't ship one for the surface depth needed)

**Spacing & radius:**
- Use Mint DS spacing tokens (the file has a `Spacing & radius` variable collection — `Corner radii/cardDefault` and equivalents).
- Common card corner radius: ~12px (cardDefault).

### Components NOT directly in Mint DS Web — needs design decision
- **Status badge / Tag for ticket status:** Mint DS Web doesn't ship a Tag component at the same maturity as Mint DS Mobile. Two options:
  1. Build a **Status Badge** custom variant: pill, 10–11px text, semantic background tint at ~12% opacity + matching foreground color. Sizes: SM (11px). Variants: `triage`, `back-office`, `pending`, `done`, `cancelled`, `other`. *(Recommended.)*
  2. Reuse Mint DS Mobile's Tag visually but in a web-appropriate scale.
- **Table:** Mint DS Web doesn't ship a Table primitive. v1 doesn't need one (no queue view) — skip for now.

### Components NOT in Mint at all (and what to do)
- **Side-panel chrome itself** (the docked column shell): no Mint primitive. Design as a 320–400px wide vertical surface with a top header bar (close X, ticket key, status badge) and scrollable body. Match Mint's surface treatments — borders/strokes from `outline` semantic colors.
- **Inline-on-Jira action toolbar:** small horizontal pill or row of buttons injected near Jira's title bar. Design to **visually defer to Atlassian's UI** — don't out-compete Jira's primary actions. Subtle stroke, neutral background, only the WOCOO icon to assert the extension.

---

## 3. Audience & Tone

**Users:** Wealthsimple internal Cash & Card Operations associates. 4 people in v1, potentially the wider CXA support org later. They are experts in their workflow. They want **density, clarity, keyboard speed**. They do not want hand-holding, animations, or "delight."

**Tone:** Calm, professional, mostly black-on-white with semantic-color accents where they carry meaning (status badges, danger affirmations, success confirmations). Think Linear or Stripe Dashboard, not a consumer app.

**Accessibility:** Wealthsimple is a financial product, treat WCAG AA contrast as a floor. Use Mint's semantic colors — they're chosen to meet contrast targets.

---

## 4. Screens to design (v1)

Design these as separate frames. Each should be designed at **realistic sizes** (the side panel is genuinely ~360px wide — don't sketch it at 600).

### Screen 1: Side Panel — Ticket-in-Context (primary screen)
**Default size:** 360px wide × full viewport height.
**Resizable:** Yes — Chrome's native side-panel API supports user-drag-to-resize. Design must reflow gracefully across the range **280px (compact) → 520px (comfortable)**. Width persists across sessions automatically (Chrome handles).
- **At ~280px (compact):** drop the "Recent comments" preview; collapse the two-column identity/account block into a single column; reduce horizontal padding to 8px; hide the inline Atlas icon-button next to Identity ID in favor of a single "Atlas" text-button below.
- **At default (~360px):** layout described below — the canonical design.
- **At ~520px (comfortable):** widen the description card; allow comments to show inline (3 lines per comment instead of "View 1 comment" collapsed); keep content in a 480px reading column rather than fully stretched.
**Purpose:** When an agent navigates to a Jira ticket (`wealthsimple.atlassian.net/browse/WOCOO-XXXXX`), the side panel auto-loads and shows that ticket's details + a quick-actions cluster + a Zendesk transcript section.

**Layout (top to bottom):**
- **Header (sticky):** ticket key (`WOCOO-22597`) as link to Jira, status badge, priority badge, close-panel X (top-right).
- **Title:** ticket summary text — 2 lines max, ellipsis after.
- **Meta row:** Assignee · Reporter · Created date — small, `soft-fg`.
- **Identity & account block:** Identity ID + Atlas link (icon-button to open in new tab), Account ID, Tier badge. Two-column layout.
- **Description card:** the Jira ticket description, scrollable internally if long, capped at ~150px height with "Show more" affordance.
- **Quick actions cluster:** A row of 3 primary buttons — `✓ Done`, `→ Move`, `💬 Add Comment`. Use Mint's Button or Button Key Action Group.
- **Recent comments (collapsed by default):** "View 1 comment" expandable, shows latest comment author + timestamp + body when expanded.
- **Zendesk transcript card:** Status header — *"Reading transcript from Zendesk..."* → *"✓ Captured"* with a "Re-read" icon button. Below: transcript text in a scrollable area (max ~200px), or a "Couldn't auto-capture — paste here ↓" fallback with a textarea. *This is the headline feature — design it to feel like a quiet but reliable win.*

### Screen 2: Side Panel — Empty State
**Same dimensions.** Shown when the agent is not on a Jira ticket page. Should communicate: "When you open a WOCOO Jira ticket, its details appear here." Include a small footer link to "Open the full WOCOO Triage app" (the extension's full-page tab).

### Screen 3: Side Panel — Loading State
**Same dimensions.** Shown briefly while the ticket fetches. Use Mint's skeleton-loading conventions if the system ships them; otherwise simple shimmer placeholders for the title, meta row, description, and actions cluster.

### Screen 4: Inline Injection on Jira — Action Toolbar
**Size:** appears injected at the top-right of a Jira ticket page, just below Atlassian's own title bar. Width ~280px, height ~36px. Floating pill or rounded card with 3 icon-buttons + a label.
**Content:** small WOCOO logo/icon · `Done` (icon) · `Move` (icon) · `Open in WOCOO ↗` (text-button — opens the side panel or full-page tab).
**Design constraint:** must visually subordinate to Atlassian's UI. Subtle stroke, soft background, no big shadows. Should NOT look like part of Jira's own toolbar (avoid confusion) but also shouldn't shout.

### Screen 5: Full-Page Tab — App Shell
**Size:** Standard desktop, 1280×800.
**Purpose:** Power-user mode. Used when the agent isn't tied to a Jira page (e.g. starting a fresh triage session, batch-actioning several tickets).
**Layout:** Two-column.
- **Left column (240px):** Vertical nav. Items: "Ticket Lookup" (default), "Open Ticket" (paste a key → loads it), "Settings". Not a queue view — v1 doesn't include the queue.
- **Right column (flex):** Hosts the same Ticket-in-Context content as the side panel, but at desktop width (~640px reading column, centered). All the side-panel sections (Header, Meta, Identity, Description, Quick Actions, Zendesk Transcript) reflow into the wider canvas.

### Screen 6: Move Workflow Modal
**Size:** Centered modal, ~640px wide × auto height.
**Purpose:** Move the current Jira ticket to EOC / PFO / CRED / FRAUD board.
**Sections (top to bottom):**
- **Modal header:** "Move WOCOO-22597" + close X. Use Mint's Modal + Navigation Button=Close.
- **Step 1 — Destination:** Selector button group with 4 options (EOC, PFO, CRED, FRAUD). Each option shows the destination name + an inline `(API ✓)` / `(UI only)` chip indicating whether the move works through the extension or kicks the user to Jira.
- **Step 2 — Source details (read-only):** Summary, Identity ID, Account ID, Tier. Pulled from the ticket — shown as a confirm card so the agent can verify before acting.
- **Step 3 — Destination-specific fields:**
  - EOC: Client Status (Selector button: Core / Premium / Generation), Problem Area (typeahead — 157 options, Payment Card group pinned), Account ID override (text input, monospace, validation chip).
  - PFO: Work Type (dropdown: Credit Card Delivery Issue / Prepaid Card Delivery Issue / Cheques Delivery Issue).
  - CRED: no extra fields — just confirm. Show a quiet "No additional fields required — summary copies from source."
  - FRAUD: UI-only — show a "Use JIRA's native Move" callout + button to open the ticket in Jira.
- **Confirm step:** Amber warning card — "Move WOCOO-22597 to <destination> with these values?" + ✓ Confirm Move + ← Back buttons.
- **Success state:** Green card — "✓ Moved to <destination>" + the resulting fields + "Open in Jira" link.

### Screen 9: Side Panel — Overpayment Triage Workflow (in-panel)
**Size:** same as Screen 1 — 360px default, 280–520px responsive.
**Purpose:** Run the full 8-step overpayment triage flow without leaving the side panel. Triggered from Screen 1's quick-actions cluster ("⚡ Start Overpayment Triage" button — only shown when the current ticket's category is "Credit Card: Overpayment / Negative Balance"). The panel content **transforms** — Screen 1's ticket-in-context view is replaced by this workflow view. A persistent **← Back to ticket** affordance at the top lets the agent exit mid-flow without losing state.

**Layout:**
- **Sticky workflow header:** "← Back to ticket" link · ticket key · workflow title "Overpayment Triage" · progress dots (1•2•3•4•5•6•7•✓).
- **Step cards (vertical scroll):** the active step is expanded; completed steps collapse to a one-line summary with a green ✓; future steps are stubs.

**The 8 steps (each a distinct card):**

1. **📋 Pull Ticket Details** — auto-runs on workflow start. Shows fetched fields in a small grid: Identity ID (monospace, copy button), Amount ($X,XXX.XX in red), Tier badge, Account ID (monospace), Client Email (monospace, copy button), Reporter name. Any missing field shows an inline edit affordance — at compact width these stack vertically; at comfortable width they're 2-column.
2. **✓ Acceptance Criteria** — three checks: Amount ≥ $1,000 (green check or amber warning), Tier (display), Approver (Luke Gazmin if <$5K, Amanda Burke if ≥$5K — show name + override pencil). If Amount < $1,000, surface a "📝 Decline Comment" sub-card with pre-filled comment text + an "Decline & Comment" red button. Otherwise: a "Criteria Met, Continue" primary button.
3. **🔍 Verify Balance** — three quick-link buttons (Preset / Atlas / i2c) in a row. Below: "Filter by: <Identity ID>" with copy. Two outcome buttons: "✓ Verified" (green) or "✏️ Balance Differs" (amber — reveals an inline amount-override input).
4. **🎫 Create REIMB Ticket** — read-only summary of the fields that will be sent (Summary template, Identity, Amount, Approver, Tier with edit pencil, Account ID with override). One green primary button "✓ Create REIMB Ticket." Disabled until Account ID is valid (format check). On success: shows the created REIMB key as a clickable link to the new Jira ticket.
5. **💳 Admin Debit in i2c** — instructional card with numbered steps ("1. Open i2c · 2. Administrative Services tab · 3. Apply Admin Debit of $X,XXX.XX"). One quick-link to i2c. One "✓ Admin Debit Applied" button — manual check-off only.
6. **💬 Post Comment on WOCOO ticket** — pre-filled comment text in a read-only display by default, with an "✏️ Edit" affordance. Below: "Review, Approve" button. On Review, expands to a confirm sub-card with amber background and "✓ Post" / "← Back to Edit" buttons.
7. **➡️ Move WOCOO Ticket to Done** — one green button "✓ Move to Done."
8. **🎉 Triage Complete** — success card. Shows REIMB ticket key (link), confirmation that Admin Debit + Comment + Done all completed. Two buttons: "Close & Return to Ticket Context" (back to Screen 1) and "Close & Reload Dashboard."

**Critical UX details:**
- **Each step must be reversible** until the next step starts. Mistakes happen and the agent needs to back out.
- **Error states per step:** if Create REIMB fails, the step shows a red inline error with the message + a "Retry" button — does NOT advance the workflow.
- **Resuming a partially-completed workflow:** if the agent navigates away mid-flow and comes back, the workflow restores from `chrome.storage.session` at the step they left off. Show a small "Resumed from Step 4" banner on restore.
- **Responsive behavior:**
  - At ~280px (compact): action buttons stack vertically; labels truncate; the field grid in Step 1 becomes single-column.
  - At default ~360px: layout above is canonical.
  - At ~520px (comfortable): Step 6's comment editor gets a roomier textarea; field grid in Step 1 is 2-column; the "Back to ticket" affordance is shown as a button with label rather than just an icon-link.

**Tone for this screen:** functional, almost procedural — this is a checklist the agent is walking down. Use Mint's Positive semantic color sparingly (only for completed steps) so the green ✓ marks feel earned. Avoid celebratory animation on Step 8 — a quiet green success card is enough.

### Screen 7: First-Run / Auth
**Size:** Side panel (360px) OR full page — design one and note it adapts.
**Purpose:** First time the extension opens, the agent hasn't connected Jira yet.
**Content:** "Connect your Jira account" headline, brief explainer ("WOCOO Triage uses your Jira account to load tickets and perform actions on your behalf."), one primary button "Sign in with Atlassian", a smaller "Already signed in? Reload" link.

### Screen 8: Settings (full-page only)
**Size:** Inside the full-page tab's right column.
**Sections:**
- **Connected Accounts:** Atlassian (✓ Connected as Albert Cai · Sign out), placeholders for vNext integrations (Anthropic, Notion, Guru — show as "Not connected yet").
- **Appearance:** Dark mode toggle (Mint should ship a Toggle — verify against the file).
- **About:** version number, link to PRD/docs.

---

## 5. Components — detailed specs

### 5.1 Status Badge (custom, built on Mint tokens)
A small inline pill used everywhere status is shown.

| Variant | Background | Foreground |
|---|---|---|
| `triage` | Negative bg (12% opacity) | Negative fg-strong |
| `back-office` | Warning bg (12% opacity) | Warning fg-strong |
| `pending` | Highlight bg (12% opacity) | Highlight fg-strong |
| `done` | Positive bg (12% opacity) | Positive fg-strong |
| `cancelled` | Neutral / subdued-fg | strong-fg-inverted |
| `other` | Highlight bg (8% opacity) | subdued-fg-title |

11px / 600 weight / 2px horizontal × 1px vertical padding / 9999px border-radius.

### 5.2 Priority Indicator
Text-only label (not a pill). Color-coded foreground only.
- Highest / High → Negative fg-strong
- Medium → Warning fg-strong
- Low → Positive fg-strong
- Lowest → soft-fg
11px / 700 weight.

### 5.3 SLA aging row tint (carry-over from v3)
Rows / cards aging beyond SLA get a tinted background:
- 1–3 days old → Warning bg ~5% opacity
- >3 days old → Negative bg ~5% opacity
- Done/Cancelled → no tint.

### 5.4 Quick Actions Cluster (side panel)
Row of 3 buttons. Use **Button Key Action Group** from Mint DS Web if it works at this size, otherwise standard Buttons.
- **Done** — Positive variant
- **Move** — Primary / Neutral variant
- **Add Comment** — Secondary variant

### 5.5 Transcript Card
**States:**
- `fetching`: indigo banner — "Reading transcript from the Zendesk widget…"
- `success`: green banner — "✓ Captured from Zendesk #13605113" + Re-read icon button + transcript body in monospace scroll area (max 200px).
- `partial`: amber — "Couldn't auto-capture. Paste below:" + textarea fallback.
- `error`: red — "Zendesk widget not found on this page." + paste fallback.

### 5.6 Inline Toolbar (on Jira)
- Pill, 280px × 36px.
- Background: light surface with `high-card-stroke`.
- Content (left to right): WOCOO icon (16px) · ✓ Done (icon button) · → Move (icon button) · "Open in WOCOO" (text button with link-out icon at right).
- On hover: subtle background lift (~4% darker).

### 5.7 Problem Area Typeahead (Move modal — EOC)
- Width 320–360px.
- 157 options, grouped: **Payment Card** (5 options, pinned to top with a "RECOMMENDED FOR WOCOO" section label) then **All other areas** (152 options, alphabetized).
- Input fires filter on each keystroke.
- Keyboard: ↑↓ navigate, Enter selects, Esc closes.
- Empty state: "No matches for "<query>"".

### 5.8 Identity / Account Block
- Two-column micro-layout inside the side panel.
- Left column: "Identity ID" label + code-style monospace value (truncated with copy button).
- Right column: "Account ID" label + monospace value + tier badge below.
- Below: "Atlas link ↗" text button that opens `atlas.wealthsimple.com/identity/<id>/overview/`.

---

## 6. Visual Language — at a glance

| | Spec |
|---|---|
| **Typography** | Mint DS Web's type scale (Inter or Mint's brand stack). Body 12–13px, heading 14–16px, micro labels 10–11px. |
| **Surfaces** | White on white-ish (`high-card-stroke`). Cards with 1px borders, not heavy shadows. |
| **Spacing** | 4 / 8 / 12 / 16 / 20 / 24 grid. Side panel padding 12–16px. Modal padding 14–20px. |
| **Corners** | 8px for buttons, 12px for cards, 9999px for badges. |
| **Iconography** | Mint's Product Icons library. Use existing icons (close, link-out, etc.). Don't invent. |
| **Density** | Higher than consumer apps — this is a workflow tool. Comfortable but not generous. |
| **Motion** | Minimal. Fade-ins (180ms), modal slide-in (220ms with gentle ease-out). No celebratory animations. |

---

## 7. Constraints / don'ts

- ❌ No queue / list-of-tickets view in v1. Don't design one.
- ❌ No LLM features in v1 (no "Ask Guru", no auto-suggested responses, no AI summarize). Don't design AI affordances.
- ❌ No Inquiry Removal, Koho email, REIMB workflow, Parse Transcript LLM screens. Those stay in v3.
- ❌ No celebratory animations, confetti, marketing copy, or "tour" overlays.
- ❌ No light/dark stylistic flourish that competes with Mint's quiet aesthetic.
- ❌ No bespoke palette — semantic colors from Mint only.
- ❌ Don't redesign Atlassian's UI. The inline toolbar must defer to Jira.
- ✅ Do show empty / loading / error states for every screen with network calls.
- ✅ Do design for keyboard users — show focus rings, tab order should be sensible.
- ✅ Do use real-looking ticket data (`WOCOO-22597`, `identity-gJLR...`, etc.) so the team can sanity-check.

---

## 8. Acceptance criteria (how to know the design is done)

For each screen, the design is "done" when:
1. It uses **named Mint DS Web components** wherever Mint ships one. Custom variants are only used for Status Badge / Priority Indicator / SLA aging (where Mint Web doesn't ship a primitive).
2. It uses **semantic color variables**, not hex codes. Foreground colors come from `Primary/FG UI/*`. Background tints come from semantic Positive/Warning/Negative/Highlight families.
3. It shows realistic data (real WOCOO ticket keys, real Identity IDs of the format `identity-XXXX`, real Account IDs of the format `WK292CZ38CAD`, real client tiers).
4. It has Empty, Loading, and Error states designed (for the screens where they apply: Side Panel, Move Modal, Transcript Card).
5. It's annotated with sources (Mint component name) so the developer building it knows which library asset to grab.

---

## 8b. Responsive behavior — side panel widths

The side panel is user-resizable (Chrome native drag-resize, persists across sessions). The design must handle the range **280–520px** gracefully. Three reference layouts to design:

- **Compact (≈280px):** single-column identity block, no inline Atlas icon button, comments preview hidden, transcript card height capped at 140px. Padding 8/12.
- **Default (≈360px):** the canonical Screen 1 design described in §4. Padding 12/16.
- **Comfortable (≈520px):** two-column identity block stays; description card grows; inline 3-line comment previews; transcript card height 240px. Content lives in a max-480px reading column even when the panel is wider — don't stretch full-width.

A single design system can't perfectly cover every width in this range, but designing the three reference layouts (compact, default, comfortable) gives the engineer enough to interpolate between via CSS container queries.

---

## 9. Recommended order to design

The three v1 differentiators come first. Everything else is supporting design — finish those three before moving on.

1. **Screen 1 (Side Panel — Ticket in Context).** The spine; everything derives from it. Design at the **default ~360px width first**, then the compact (~280px) and comfortable (~520px) variants.
2. **Component: Status Badge + Priority Indicator.** Build these once, reuse everywhere — they show up across most screens.
3. **Component: Transcript Card** (all four states: fetching, success, partial, error).
4. **Screen 9 (Overpayment Triage Workflow in Side Panel).** Most complex v1 flow — 8 steps, lots of state, all three widths must work. This is where the in-context UX bet has to pay off.
5. **Screen 6 (Move Workflow Modal).** Second most complex; modal pattern is more familiar.

— v1 differentiators end here. Stop, get sign-off on these five before moving on. —

6. **Screen 4 (Inline Toolbar on Jira).** Quick, but UX-sensitive (must defer to Atlassian's UI).
7. **Screens 2 + 3 (Empty / Loading).** Tells the engineer what to render during transient states.
8. **Screen 5 (Full-Page Tab).** Mostly a reflow of Screen 1's content at desktop width.
9. **Screen 7 (First-Run / Auth)** and **Screen 8 (Settings).**

Iterate on Screen 1 + Status Badge + Transcript Card before locking the rest. They drive the visual feel.

---

## 10. Open questions (flag in the design where they apply)

- **Q1: Does Mint DS Web ship a Toggle primitive?** Needed for Settings dark-mode toggle. If not, use a custom one using semantic tokens.
- **Q2: Mint DS Web's table/listrow story** — relevant for vNext queue view, not v1.
- **Q3: Inline toolbar mounting point on Jira** — exact selector / anchor in the Jira ticket page; design should accommodate `top-right` or `inside-actions-row` placement and note which is preferred.
- **Q4: Status badge — Mint DS Mobile has a Tag**, but the Web counterpart is less mature. Confirm with WS Design whether to extend Mint DS Web with a Status Badge variant or use a per-team utility class.
