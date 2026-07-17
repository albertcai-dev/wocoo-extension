# claude.ai/design — Paste-Ready Prompts

These are the prompts to paste into claude.ai/design **in order**. Each one targets one specific design artifact. Don't paste them all at once — iterate on each until it feels right before moving to the next.

**How to read this file:** Each section starts with a header (which screen / component the prompt is for), context on when to use it, and then a fenced `prompt` block. Copy everything between the triple-backticks into claude.ai/design as a single prompt.

**Common rule for all prompts:** the design system is **Wealthsimple Mint DS Web 1.0 (Patchwork)** — Figma file: `https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/`. The output should use named Mint components wherever Mint ships one, and use Mint's semantic color variables (`Primary/FG UI/strong-fg`, `subdued-fg-title`, `soft-fg`, `inactive-fg`, plus Positive / Warning / Negative / Highlight semantic families) rather than hardcoded hex.

---

## 🟢 Prompt 1 — Side Panel: Ticket-in-Context (default ~360px)

**Use this first.** This screen sets the visual feel for the entire extension. Iterate on it until it feels right before designing anything else.

```
Design a Chrome extension's docked side panel for an internal Wealthsimple Cash & Card Operations (WOCOO) triage tool. The side panel auto-displays the current Jira ticket the agent is viewing in another tab.

DIMENSIONS
- 360px wide × full viewport height (~900px tall on a typical laptop)
- This is an internal workflow tool, NOT a consumer product

DESIGN SYSTEM
- Use Wealthsimple's Mint DS Web 1.0 (Patchwork) library: https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/
- Confirmed available Mint components to use: Button, Button Icon, Text Button with Icon, Selector button, Menu button, Option menu, Modal, Navigation Button=Close
- Semantic color tokens: Primary/FG UI/strong-fg (text/icons, max contrast), subdued-fg-title (subdued titles), soft-fg (labels), inactive-fg (disabled). Positive/Warning/Negative/Highlight families for status semantics.
- Status badges and priority labels don't have a direct Mint Web primitive — design them as small custom pills built on Mint semantic colors (Negative bg 12% + Negative fg-strong = "Triage" badge, etc.)
- Typography: Mint's type scale (likely Inter or Mint's brand stack). Body 12-13px. Heading 14-16px. Micro labels 10-11px.
- Corners: 8px buttons, 12px cards, 9999px badges.
- Tone: quiet, dense, professional. Think Linear or Stripe Dashboard, NOT a consumer app. No marketing flourish, no celebratory animation.

LAYOUT (top to bottom)
1. Sticky header bar: ticket key as link ("WOCOO-22597"), status badge ("Triage"), priority label ("Medium"), close-panel X button in top-right
2. Ticket title (2 lines max, ellipsis): "Declined Mastercard transaction: Code 51 - insufficient funds"
3. Meta row: "Assignee: Albert Cai · Reporter: Albert Manantan · Created: Jun 8" — small, soft-fg
4. Identity & Account block (2-column):
   - Left: "Identity ID" label + monospace value "identity-gJLRchfi_P_5..." (truncated, with copy icon button) + small Atlas link button
   - Right: "Account ID" label + monospace value "WK7LNXW30CAD" + Tier badge "Core"
5. Description card: scrollable internally if long, capped ~150px height with "Show more" affordance. Sample text: "Hello team, This client is unable to use their Mastercard, both virtual and physical, with a certain merchant. The Atlas error decline code is showing us error 51, which is insufficient funds; however, the client does have enough funds to cover the transaction. Can we please look into the client's account, thank you."
6. Quick Actions cluster: row of 3 primary buttons — "✓ Done" (Positive variant), "→ Move" (Primary/Neutral), "💬 Comment" (Secondary)
7. Recent comments (collapsed by default): one-line "View 1 comment" affordance
8. Zendesk Transcript card: green banner header "✓ Captured from Zendesk #13605113" + small "Re-read" icon button. Below: transcript text in a scrollable area (~200px max), monospace, with a copy button in the card header. Sample transcript text: "AGENT: Hello, am I speaking to Michael? CLIENT: Yes, speaking. AGENT: Hello, Michael. My name is Morgan. I'm calling on behalf of Wealthsimple..."

CONSTRAINTS
- Use realistic data shown above. Don't substitute lorem ipsum.
- Show focus rings on interactive elements — keyboard accessibility matters.
- Density is higher than consumer apps. Padding 12-16px around card edges, 4-8px between rows.
- Do NOT design a queue / list view. Do NOT design AI / LLM affordances. Do NOT design celebratory animations or marketing copy.

OUTPUT
Provide the design at 360px width × ~900px height. Annotate each major component with the Mint component name used (e.g., "Mint: Button", "Custom: Status Badge variant").
```

---

## 🟢 Prompt 2 — Status Badge + Priority Indicator (component set)

**Use after locking Screen 1.** These reusable components show up everywhere — design them once.

```
Design two reusable components for the WOCOO Chrome extension, built on Wealthsimple's Mint DS Web 1.0 (Patchwork) semantic color tokens.

CONTEXT
These are small inline indicators that show up next to ticket titles, in side panel headers, and in inline toolbars. They MUST use Mint's semantic color variables, not hardcoded hex.

DESIGN SYSTEM
- Mint DS Web 1.0 (Patchwork): https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/
- Semantic color families: Positive (green), Warning (amber/yellow), Negative (red), Highlight (purple/blue), plus neutral fg/bg.

COMPONENT 1: Status Badge
A small inline pill, ~50-80px wide depending on label. Used everywhere ticket status appears.

VARIANTS (5 + 1 "other"):
- triage     → background: Negative bg 12% opacity, text: Negative fg-strong
- back-office → background: Warning bg 12% opacity, text: Warning fg-strong
- pending    → background: Highlight bg 12% opacity, text: Highlight fg-strong
- done       → background: Positive bg 12% opacity, text: Positive fg-strong
- cancelled  → background: neutral / inactive, text: subdued-fg-title
- other      → background: Highlight bg 8% opacity, text: subdued-fg-title

SPECS
- 11px text, 600 weight, uppercase OR title-case (your call — show both, recommend one)
- Padding: 2px horizontal, 1px vertical (compact)
- Border-radius: 9999px (full pill)
- Show all 6 variants in a row with their labels: "Triage", "Back Office", "Pending", "Done", "Cancelled", "Other"

COMPONENT 2: Priority Indicator
A text-only label (no pill background, no border). Color-coded foreground only.

VARIANTS (5):
- Highest → Negative fg-strong
- High    → Negative fg-strong (slightly lighter shade if available, otherwise same as Highest)
- Medium  → Warning fg-strong
- Low     → Positive fg-strong
- Lowest  → soft-fg

SPECS
- 11px text, 700 weight (bolder than Status Badge so they don't visually compete)
- No background, no border
- Show all 5 variants in a row with their labels: "Highest", "High", "Medium", "Low", "Lowest"

OUTPUT
Provide both components as a compact component sheet — 6 status badges in a row, then 5 priority indicators in a row below. Annotate the Mint semantic tokens used for each (e.g., "bg: Negative/bg @ 12%, fg: Negative/fg-strong").
```

---

## 🟢 Prompt 3 — Transcript Card (4 states)

**Use after Status Badge + Priority Indicator.** This is the headline feature of the extension — design it deliberately.

```
Design a "Zendesk Transcript Card" component for the WOCOO Chrome extension's side panel. It has 4 distinct states.

CONTEXT
When an agent opens a Jira ticket in another tab, the extension automatically captures the Zendesk call transcript from the page's DOM and surfaces it in the side panel. The card has to handle 4 outcomes of that auto-capture clearly.

DESIGN SYSTEM
- Mint DS Web 1.0 (Patchwork): https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/
- Semantic colors: Highlight (indigo) for in-progress, Positive (green) for success, Warning (amber) for partial, Negative (red) for errors.
- Card surface uses Mint's "high-card-stroke" effect (1px border, subtle).

WIDTH: 360px (fits in the side panel — same as Screen 1).

THE 4 STATES (design all 4 as separate cards, stacked vertically in your output)

STATE 1 — fetching
- Indigo banner at top of the card: "Reading transcript from the Zendesk widget…"
- Small animated spinner icon to the left of the text
- Card body: light gray shimmer placeholder (3 lines)

STATE 2 — success (most common)
- Green banner at top: "✓ Captured from Zendesk #13605113"
- Small "Re-read" icon button (refresh icon) in the top-right of the banner
- Card body: transcript text in a scrollable area, max-height 200px
- Monospace font, 12px, line-height 1.5
- Sample text: "AGENT: Hello, am I speaking to Michael? CLIENT: Yes, speaking. AGENT: Hello, Michael. My name is Morgan. I'm calling on behalf of Wealthsimple..." (continue with a few more agent/client turns so the scrolling area is visible)
- Copy button in the bottom-right of the card

STATE 3 — partial / couldn't-auto-capture
- Amber banner: "⚠ Couldn't auto-capture. Paste below:"
- Card body: an empty textarea with placeholder "Paste the Zendesk transcript here..." (~120px tall)
- Below the textarea: a "Parse" primary button

STATE 4 — error
- Red banner: "⚠ Zendesk widget not found on this page."
- Card body: small explanatory text "This ticket may not have a linked Zendesk conversation yet."
- Below: a "Paste manually" secondary button + a "Try again" text button

CONSTRAINTS
- Use Mint's semantic color tints for the banners (12-15% opacity backgrounds, full-strength foreground text).
- The 4 states should feel related but instantly distinguishable — color is the primary signal.
- Keep the card height comparable across states (don't make state 2 huge and state 4 tiny).

OUTPUT
Show all 4 states vertically stacked, labeled "fetching / success / partial / error". Each card 360px wide.
```

---

## 🟠 Prompt 4 — Overpayment Triage Workflow (Step 1 first, then the rest)

**Use after Transcript Card.** This is the most complex screen — iterate on Step 1 alone before fanning out to the other 7 steps. The prompt below is for Step 1; once that's locked, send the follow-up to design the full sequence.

### Prompt 4a — Step 1 alone

```
Design Step 1 of a multi-step "Overpayment Triage" workflow rendered inside the WOCOO Chrome extension's side panel.

CONTEXT
When an agent clicks "⚡ Start Overpayment Triage" in the side panel's quick-actions cluster (only shown when the ticket category is "Credit Card: Overpayment / Negative Balance"), the panel's content TRANSFORMS — the ticket-in-context view is replaced by this workflow view. The agent walks through 8 steps in sequence.

I want to design Step 1 first in isolation. Once it feels right, I'll ask you to extend to Steps 2-8.

DIMENSIONS
- 360px wide × full viewport height
- Designed as part of an in-panel workflow, NOT a modal

DESIGN SYSTEM
- Mint DS Web 1.0 (Patchwork): https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/
- Use Mint Button, Button Icon, semantic color tokens, and the Status Badge component already designed.
- Tone: functional, procedural — a checklist the agent walks down. No celebratory animation.

LAYOUT (top to bottom)

1. STICKY WORKFLOW HEADER (top, ~52px tall):
   - "← Back to ticket" small icon-button on the left (goes back to the ticket-in-context view)
   - Center: ticket key "WOCOO-22597" + workflow title "Overpayment Triage"
   - Right: progress dots — 8 small circles in a row: ● ○ ○ ○ ○ ○ ○ ✓ — only the first dot is filled (active step), others empty, last is the completion checkmark

2. STEP 1 CARD (active, expanded — this is what Step 1 looks like as the active step):
   - Card title: "📋 Step 1: Pull Ticket Details"
   - Subtitle in soft-fg: "Auto-fetched from Jira"
   - Field grid (2-column at 360px, single-column if narrower):
     - Identity ID:  "identity-eKfXCoQHtu2..."  (monospace, copy icon button)
     - Amount:       "$9,500.00"  (red text, edit pencil)
     - Tier:         (Premium tier badge — purple)
     - Account ID:   "WK292CZ38CAD"  (monospace, copy icon button)
     - Client Email: "client@example.com"  (copy icon button)
     - Reporter:     "Albert Manantan"
   - Primary button at bottom: "Continue to Acceptance Criteria →"

3. STEP STUBS (collapsed, below Step 1):
   - Step 2: "✓ Acceptance Criteria" (collapsed, soft gray)
   - Step 3: "🔍 Verify Balance" (collapsed)
   - Step 4: "🎫 Create REIMB Ticket" (collapsed)
   - Step 5: "💳 Admin Debit in i2c" (collapsed)
   - Step 6: "💬 Post Comment" (collapsed)
   - Step 7: "➡️ Move to Done" (collapsed)
   - Step 8: "🎉 Complete" (collapsed)
   - Each stub: small numbered circle + step title + soft-fg subtitle "Not started" — taller than a single line but much shorter than the active step.

CONSTRAINTS
- Use Mint's Card effect on the active step's container ("high-card-stroke")
- Step stubs should be visually deferred — lighter background, less padding, no buttons visible
- Don't over-design — the agent will see this 5-10 times per day and needs it to feel calm
- All monospace values use a system mono font

OUTPUT
A single 360px × full-height side panel showing the sticky header, Step 1 expanded, and the 7 step stubs below.
```

### Prompt 4b — once Step 1 is locked, extend to all 8 steps

```
Now extend the Overpayment Triage workflow from Step 1 (designed previously) into all 8 steps.

Design 8 separate frames, each showing the workflow at a different active step. Same dimensions (360px wide), same sticky header (with the progress dots updating to reflect the active step), same step-stubs pattern (completed steps collapse with a green ✓, future steps stay as soft-gray stubs).

THE 8 STEPS (active-state design for each):

STEP 2 — ✓ Acceptance Criteria
- Three check rows: "Amount ≥ $1,000" (green check + "$9,500.00 ✓"), "Tier: Premium" (tier badge), "Approver: Amanda Burke (≥$5K)" (override pencil)
- Primary button: "Criteria Met, Continue →"

STEP 3 — 🔍 Verify Balance
- Three quick-link buttons in a row: "Open Preset" (indigo bg), "Open Atlas" (green bg), "Open i2c" (amber bg) — each with a small external-link icon
- Below: "Filter by: identity-eKfXCo..." (monospace, copy button)
- Two outcome buttons stacked: "✓ Verified" (green) and "✏️ Balance Differs" (amber, secondary)

STEP 4 — 🎫 Create REIMB Ticket
- Read-only summary: Summary line ("Credit card overpayment reimbursement for WOCOO-22597"), Identity, Amount, Approver (with edit pencil), Tier (with edit pencil), Account ID (with override pencil if invalid)
- Primary button: "✓ Create REIMB Ticket"

STEP 5 — 💳 Admin Debit in i2c
- Instructional card with numbered list:
  1. Open i2c (with "Open i2c" link)
  2. Go to Administrative Services tab
  3. Apply Admin Debit, **$9,500.00** (amount in red)
- One quick-link to i2c, then a "✓ Admin Debit Applied" button (manual check-off)

STEP 6 — 💬 Post Comment
- Pre-filled comment text in a read-only display: "Hi {{REPORTER_MENTION}}, a reimbursement ticket has been created [REIMB-12345]. You can let the client know to expect the overpayment amount of $9,500.00 back in their chequing account within the next 2-3 business days."
- Two buttons: "✏️ Edit" (secondary) and "Review, Approve" (primary)

STEP 7 — ➡️ Move to Done
- Brief explainer: "All steps complete. Move WOCOO-22597 to Done."
- One primary button: "✓ Move to Done"

STEP 8 — 🎉 Complete
- Green success card (using Positive semantic colors): "Triage Complete"
- Summary: "REIMB-12345 · Admin Debit Applied · Comment Posted · Moved to Done"
- Two buttons: "Close & Return to Ticket Context" (primary) and "Close & Reload Dashboard" (secondary)

OUTPUT
8 frames, each 360px × full-height, labeled "Step 1 active", "Step 2 active", ..., "Step 8 complete". Show the completed steps above each active step as collapsed rows with green ✓ marks.
```

---

## 🟠 Prompt 5 — Move Workflow Modal

**Use after the Overpayment Triage screens.** This is a modal (not in-panel) and is the most-used "actually accomplish something" workflow.

```
Design the "Move Ticket" workflow modal for the WOCOO Chrome extension. This is launched from the side panel's quick-actions cluster when the agent wants to move a Jira ticket from the WOCOO board to another board (EOC / PFO / CRED / FRAUD).

DIMENSIONS
- Centered modal, ~640px wide × auto height
- Modal overlay: 50% black at modal-overlay token

DESIGN SYSTEM
- Mint DS Web 1.0 (Patchwork): https://www.figma.com/design/FDd6CaSdzwPebuzTexclKm/
- Use Mint's Modal component as the shell, Navigation Button=Close for the X
- Selector button for the destination picker, Menu button + Option menu for dropdowns
- Status Badge for inline destination chips

LAYOUT (top to bottom)

1. MODAL HEADER (sticky):
   - Title: "Move WOCOO-22597"
   - Close X (top-right)

2. STEP 1 — Move To (Destination picker)
   - Label: "Destination"
   - Selector button group, 4 horizontal options: "EOC · Engineering On-Call" / "PFO · Physical Fulfillment Ops" / "CRED · Credit Decisioning" / "FRAUD · Fraud Operation"
   - Below the selected option, an inline status chip: "API ✓" (green) for EOC/PFO/CRED, "UI only" (amber) for FRAUD
   - Right side: small text-link "Open EOC board ↗"

3. STEP 2 — Source Ticket Details (read-only confirm card)
   - Card with light gray background
   - Field rows: Summary, Identity ID (monospace, copy), Account ID (monospace, copy), Source Tier (badge)
   - All fields shown read-only — the agent confirms before acting

4. STEP 3 — Values for [Destination]
   - Section varies by destination. Show the EOC variant as the canonical:
     - "Client Status:" — 3-button selector: Core / Premium / Generation (Premium selected, amber active state)
     - "Work Type:" — read-only "Task" (no picker for EOC)
     - "Status:" — read-only "Untriaged"
     - "Problem Area:" — typeahead input (text field, 360px wide) with placeholder "Type to search… (157 options)" + a "RECOMMENDED" green chip next to it indicating a recommended option will be auto-selected
     - Small instructional text below: "Payment Card group is pinned on top. Arrow keys to navigate, Enter to select, Escape to close."

5. INFO BANNER (green tint, just above the actions)
   - "API move enabled for EOC. Zendesk chat history is preserved automatically. The source ticket key will become a new EOC key (~10-30s after confirm)."

6. MODAL ACTIONS (bottom row, right-aligned)
   - Secondary "Cancel" button (gray)
   - Primary "Review & Move via API" button (indigo)

CONSTRAINTS
- Use Mint's Modal effect (subtle shadow) — don't over-design the depth
- The modal should feel like an extension of the side panel (not a standalone app)
- Don't redesign Mint's form components — use them as-is

OUTPUT
Single modal, ~640px × auto height. Annotate Mint components used.

BONUS (optional, in the same output): Show the modal's "Confirm" state — same modal, but with an amber confirmation card replacing the actions row: "Move WOCOO-22597 to EOC with these values? ✓ Confirm Move / ← Back to Edit"
```

---

## 🟢 Bonus Prompt — Responsive width variants for Screen 1

**Use after Prompt 1's default 360px design is locked.**

```
Take the previously-designed Side Panel (Ticket-in-Context, 360px) and produce two responsive variants.

VARIANT A — Compact (280px wide)
- Drop the "Recent comments" preview
- Collapse the two-column identity/account block into a single column (Identity ID on top, Account ID below)
- Reduce horizontal padding from 12-16px to 8px
- Hide the inline Atlas icon button next to Identity ID — show a single "Atlas ↗" text-button below the identity block instead
- Quick Actions cluster: buttons may need to stack vertically if they don't fit horizontally
- Transcript card: max-height 140px (down from 200px)

VARIANT B — Comfortable (520px wide)
- Widen the description card
- Allow the recent-comments preview to show inline — 3 lines per comment instead of "View 1 comment" collapsed
- Two-column identity/account block stays
- Keep content in a max-480px reading column rather than fully stretched — don't let the description span the full 520px width
- Transcript card: max-height 240px

OUTPUT
Two side-by-side panels, the Compact (280px) on the left and Comfortable (520px) on the right. Both show the same ticket data (WOCOO-22597, identity-gJLR..., WK7LNXW30CAD, etc.) so the reflow is visible side-by-side.
```

---

## After all 5 prompts: Supporting screens

Once the 5 prompts above are designed and you're happy with them, come back to me. The remaining screens (Empty / Loading states for the side panel, Inline Toolbar on Jira, Full-page tab shell, First-Run / Auth, Settings) are smaller in scope — I'll write prompts for those as a single follow-on file or we'll just discuss them inline.

---

## Tips for using claude.ai/design effectively

- **One prompt = one screen.** Don't ask for "all the screens" — the output gets vague.
- **Iterate, don't restart.** When the design is close-but-not-right, ask claude.ai/design to "adjust X, keep everything else." Don't re-prompt from scratch.
- **Reference earlier outputs.** When designing a new component, mention "use the Status Badge variants I designed earlier" — claude.ai/design can build on prior frames in the same session.
- **Be specific about typography weights.** "12px body, 600 weight" produces better output than "small bold text."
- **Critique honestly.** If a design looks too consumer-y, say "this feels like a marketing site — make it feel more like Linear / Stripe Dashboard / a workflow tool" and the next iteration will land closer.
