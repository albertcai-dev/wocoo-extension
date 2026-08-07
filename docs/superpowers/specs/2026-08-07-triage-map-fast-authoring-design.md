# Triage Map Fast Authoring — Design

**Date:** 2026-08-07
**Status:** Approved, not yet implemented
**Builds on:** `2026-08-03-triage-map-editor-design.md`, `2026-08-04-triage-map-orientation-and-zoom-design.md`
**Sheet:** https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit
**Site:** https://magic.w10e.com/albert.cai/wocoo-triage-map

## Purpose

Cut the cost of getting a procedure out of your head and into a map. Two features:

1. **Keyboard-first authoring** — `Tab` and `Enter` create nodes and drop straight into a one-line editor, so a chain is an unbroken burst of typing.
2. **Paste an outline** — paste a numbered list from a Google Doc and get a step chain.

### Why these two

Adding one node today is four actions: click the box, click `+ child`, double-click the new box, type. For a five-step procedure that is twenty interactions. The bottleneck is input speed, not visual fidelity — the taxonomy is authored incrementally, mid-queue, and the source material is usually already a numbered list in a Doc.

### On "make it like Miro/Figma"

Miro and Figma are freeform canvases. Freeform positioning was considered and rejected twice, and remains rejected: node ids are positional so inserting a node reshuffles them, saved coordinates would attach to the wrong boxes, and 30 procedures would mean 30 hand-maintained layouts.

What actually makes those tools feel good is low-friction input and direct manipulation, and that is available without touching the architecture. This spec takes the input half.

### Out of scope

- Freeform positioning, arbitrary shapes, sticky notes, multiplayer cursors.
- Kind inference when pasting. Considered and rejected — see "Rejected" below.
- Hover affordances, drag ghosts, AI-drafted trees. All viable later; not here.

## Architecture

Both features get pure, tested modules. The glue only wires events, keeping the untestable surface as thin as it is today.

| module | addition |
|---|---|
| `outline.mjs` *(new)* | `parseOutline(text) → Array<{ depth, text }>` |
| `edit.mjs` | `insertOutline(tree, uid, items) → { tree, firstUid }` |
| `edit.mjs` | `navigate(tree, uid, direction) → uid \| null` |

`navigate` is a read operation and sits beside `locate`, which is also a read operation. `insertOutline` is a mutation and follows the existing immutable convention: deep-clone, return a new tree.

### `parseOutline`

- Strips list markers: `1.`, `1)`, `-`, `*`, `•`, each with trailing whitespace.
- Derives `depth` from leading whitespace, **normalised so the shallowest line is depth 0**. A Doc paste is often uniformly indented; without normalising, everything would nest one level too deep.
- Treats a tab as two spaces.
- Drops blank lines.
- **Clamps any indent jump to one level.** A jump from depth 0 to depth 3 becomes depth 1, matching how `parse.mjs` already refuses multi-level jumps in the DSL.
- Returns `[]` for empty or whitespace-only input.

### `insertOutline`

Builds the whole nested subtree under `uid` in **one** operation, so a pasted twelve-line procedure is a single undo step. Every created node is a `step`. Throws `EditError` if the target cannot have children, reusing the same message `addChild` produces for an outcome or annotation.

### `navigate`

| direction | result |
|---|---|
| `up` / `down` | previous / next sibling; `null` at the ends — **no wrapping** |
| `left` | parent; `null` at the root |
| `right` | first child; `null` if childless |

No wrapping, because wrapping is disorienting when the whole tree is not visible.

## Interaction model

Two editing surfaces. A new single-line `#fastEdit` input positioned over the selected box handles the fast path. The existing three-field popup stays, reachable with `⌘Enter` for subtitle and edge label.

**Selected, not editing:**

| key | action |
|---|---|
| `Tab` | add child, start editing it |
| `Enter` | add sibling, start editing it |
| `⇧Tab` | outdent — reparent to grandparent |
| `↑` `↓` | previous / next sibling |
| `←` `→` | parent / first child |
| `⌫` | delete (confirm if it has children) |
| `⌘Enter` | open the full popup |
| `⌘V` | paste an outline under this node |
| `⌘Z` / `⇧⌘Z` | undo / redo |

**While editing:**

| key | action |
|---|---|
| `Enter` | commit, add sibling, keep editing |
| `Tab` | commit, add child, keep editing |
| `⇧Tab` | commit, outdent, keep editing |
| `Esc` | commit, stop |
| `Enter` or `Esc` on an empty title | delete that node, stop editing |

The empty-title rule matters: `titleProblem` rejects an empty title, so without it every chain would strand a "New step" at the end. Deleting on empty is also how outliners end a list.

### Governing rule for refusals

**A keystroke does nothing whenever its toolbar equivalent is disabled.** `Tab` on an outcome or annotation is silently inert, exactly as `+ child` is greyed out there. No error banner: during a fast typing burst a banner per keystroke is worse than silence, and the disabled button already explains why. Implemented by reusing the same predicates `syncToolbar` computes.

### Boundaries

- **`⇧Tab` is inert when the parent is already the root** — nowhere to outdent to. Outdenting from a branch header up to the root is allowed, since the root accepts children.
- **Arrows do not wrap.**
- **The new node scrolls into view** after each `Enter`. Without it a five-step chain walks off the bottom and you type blind.
- **`#fastEdit` is repositioned after every re-render and multiplied by `state.zoom`** — the same trap the popup hit, since both read SVG user units and are positioned in CSS pixels.

### Behaviour change

Today `Enter` adds a child and `⇧Enter` adds a sibling. This spec switches to `Tab` for child and `Enter` for sibling, matching outliner convention. `⇧Enter` is retired.

## Paste

- Listener on `document` for `paste`.
- **Ignored when the event target is an `input` or `textarea`**, so pasting into a title field behaves normally.
- Ignored in read-only mode, or with no selection.
- Reads `text/plain`, runs `parseOutline`, then `insertOutline` under the selection.
- Applied through a single `applyEdit`, so it is one undo step and one debounced save.
- `preventDefault` only when something was actually inserted.
- Zero parsed items is a no-op.

## Testing

| target | approach |
|---|---|
| `outline.mjs` | markers stripped; depth normalised when the whole paste is indented; tabs count as two spaces; blank lines dropped; indent jumps clamped; empty input yields `[]` |
| `insertOutline` | nesting matches depths; single undo step; input not mutated; refused on outcome and annotation parents; new uids do not collide |
| `navigate` | each direction; `null` at every boundary; no wrapping |
| glue | the headless harness, promoted from throwaway to committed test |

### Committing the harness

The throwaway harness built to diagnose the disabled-toolbar bug — stub `MagicTools`, run the real bundle in headless Chrome, assert DOM state — found that root cause in five minutes. `app.js` is still the only code with no tests, and keyboard flows are exactly what it can verify. It becomes `web/harness/` with a small runner, exercising at minimum: root auto-selected on load, `Tab` then typing then `Enter` produces two siblings, `Enter` on an empty node removes it, and a pasted three-line list produces three steps.

## Rejected

**Kind inference on paste** — turning a line ending in `?` into a decision, `Yes:` into an outcome, `Note:` into an annotation. Rejected because it misfires on any step phrased as a question ("Check whether the fee posted?"), a wrong kind is invisible until you look closely at the diagram, and the DSL only permits edge labels on outcomes so a guessed `Yes:` on a non-outcome would throw. Changing a kind afterwards is one keystroke; silently wrong structure is not.

**Keeping the three-field popup as the fast path** — would overload `Tab` (add-child outside a field, next-field inside one) and reopen a popup on every node during a burst.

**An explicit fast-entry mode** — no keybinding conflicts by construction, but a mode to remember, and modes are what Miro and Figma deliberately avoid.

## Risks

- **`Tab` is a browser focus key.** Every handled case must `preventDefault`, or focus escapes to the toolbar mid-burst. The harness should assert this.
- **Muscle memory.** `Enter` changing from child to sibling will misfire for a while. Mitigated by matching the convention most outliners use.
- **Repositioning `#fastEdit` on re-render** is the same class of bug as the popup drift at zoom, and is easy to reintroduce. Covered by a harness assertion at non-default zoom.
