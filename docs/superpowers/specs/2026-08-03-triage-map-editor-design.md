# Triage Map Editor — Design

**Date:** 2026-08-03
**Status:** Approved, not yet implemented
**Builds on:** `2026-08-03-triage-decision-map-design.md`
**Sheet:** https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit
**Site:** https://magic.w10e.com/albert.cai/wocoo-triage-map

## Purpose

Turn the read-only hosted viewer into a visual editor: author and restructure
triage trees by direct manipulation instead of typing DSL into a spreadsheet
cell, with every change written back to the `Trees` tab.

### What this changes about the existing design

The base design says the sheet is source of truth and diagrams are generated
build output. **That still holds.** The editor manipulates *structure*, never
coordinates — layout stays derived, and the sheet remains the only place tree
content lives. The site becomes an editor *for* the sheet.

Two concrete changes:

1. **The site stops serving pre-rendered SVGs.** It reads `Trees` at runtime and
   renders in the browser. The two `.svg` files currently uploaded are deleted
   from the site. Content changes no longer require a re-push — only code
   changes do.
2. **`svg.mjs` gains `data-node-id` attributes** so the editor can hit-test.

### Out of scope

- Freeform box positioning. Considered and rejected — see "Rejected" below.
- Editing the `Procedures` or `Intents` tabs. Those stay sheet-edited.
- The AI next-best-action card ("the brain"). Still not built.
- Multi-user concurrent editing. Conflicts are detected and surfaced, not merged.

## Architecture

### Existing modules run unchanged in the browser

`parse.mjs`, `text.mjs`, `layout.mjs`, `svg.mjs`, `style.mjs` are pure — no
`node:` imports outside `render.mjs`. The same tested code renders local SVGs and
the live editor, so there is no second implementation to keep in sync.

### New modules

| module | responsibility |
|---|---|
| `serialize.mjs` | `serialize(tree) → string`. Tree → DSL text; the inverse of `parse`. |
| `edit.mjs` | `addChild`, `addSibling`, `deleteNode`, `setText`, `setKind`, `setEdgeLabel`, `reparent`, `reorderSibling`. Each takes a tree and returns a **new** tree; no mutation. |
| `bundle.mjs` | Concatenates modules in dependency order into `out/web/app.js`, stripping `import`/`export`. |

Both `serialize` and `edit` are pure and unit-tested in Node with no DOM.

### `serialize` requirements

Must round-trip every fixture: `parse(serialize(t))` deep-equals `t`.

- Indentation is `'  '.repeat(depth)`.
- Sigils: root emits none; `#` branch_header; `-` step; `?` decision;
  `?AND` when `conjoined`; `~` annotation; `=` outcome.
- `subtitle` is appended as ` | <subtitle>` when non-null.
- An outcome's `edgeLabel` is emitted as a `<label> = ` prefix in place of `= `.
- **A `title` containing newlines** emits its first line with the sigil, then each
  subsequent line indented one level deeper with no sigil — the continuation-line
  form `parse` produces.

### Known DSL limitation, accepted

The grammar can only attach an edge label to an **outcome** (`Yes = …`). A
decision-to-decision or header-to-step edge cannot carry a label. The editor
therefore only offers edge-label editing on outcomes. Extending the grammar is
not in scope.

### `svg.mjs` change

Each box is wrapped in `<g data-node-id="n7">`. The editor queries by attribute
and attaches listeners. Locally generated SVGs carry the attribute harmlessly.

### Browser shell

`web/index.html` plus `web/app.js.in` (the glue: DOM, drag handling,
`MagicTools` calls, undo stack). `bundle.mjs` combines the pure modules and the
glue into `out/web/app.js`. **The site is two files:** `index.html` and `app.js`.

### Why bundling rather than ES module imports

It is unverified whether Magic serves `.mjs` with a JavaScript MIME type; if it
does not, module imports fail outright. Bundling to one `.js` removes the
question. It also keeps the local `.mjs` sources importable by Node, which `.js`
files would not be — `docs/triage-map/` has no `package.json`, so `.js` there
would be treated as CommonJS and `export` would throw.

### File layout

```
docs/triage-map/
  parse.mjs  text.mjs  layout.mjs  svg.mjs  style.mjs   shared, unchanged
  serialize.mjs  edit.mjs                               new, pure, tested
  bundle.mjs                                            emits out/web/app.js
  render.mjs                                            local SVG pipeline
  web/index.html                                        browser shell
  web/app.js.in                                         browser glue
  out/web/app.js                                        build output
```

### The local pipeline stays

`render.mjs` still produces `out/*.svg` and the self-contained `out/index.html`
from `data/trees.json`. It remains useful offline and for pasting diagrams into
docs. This means content reaches diagrams two ways — the committed snapshot
(local) and a live sheet read (site). The *rendering code* is shared; only the
content source differs. MCPLocker has no Node client, so the local path cannot
read the sheet directly and the snapshot cannot be eliminated.

## Editor interactions

| action | gesture | notes |
|---|---|---|
| select | click a box | outline; keyboard operations target it |
| edit text | double-click | inline fields for title and subtitle; `⏎` commits, `Esc` reverts |
| edit edge label | click the `Yes`/`No` text | outcomes only; `yes`/`no` recolour automatically |
| change kind | segmented picker on the selection | `#` `-` `?` `?AND` `~` `=` |
| add child | `⏎`, or toolbar | kind defaults by parent — see table below |
| add sibling | `⇧⏎` | inserted directly below, same kind as the selected node |
| delete | `⌦` | confirmation only when the node has children |
| reparent | drag **onto** a box | becomes that box's last child |
| reorder | drag **between** boxes | insertion line marks the drop point |
| undo / redo | `⌘Z` / `⇧⌘Z` | per-procedure stack, capped at 50 |
| new procedure | sidebar `+` | prompts for a name; creates a `Trees` row holding only a root, which parses as valid |
| delete procedure | sidebar hover → `⌫` | typed confirmation, since it removes a sheet row |

**Default kind for a new child**, by parent kind:

| parent | new child defaults to | reasoning |
|---|---|---|
| `root` | `branch_header` if the root already has one, else `step` | matches the two shapes the base design supports: columned tree, or linear checklist |
| `branch_header` | `step` if the header has no children, else same kind as its last child | continues whatever the branch is already doing |
| `decision` | `outcome` | a decision's job is to fan out to outcomes |
| `step` | `step` | steps chain |
| `annotation` | *refused* — annotations are leaf commentary | |
| `outcome` | *refused* — terminal by definition | |

**Dropping between two boxes** reorders within **the drop target's parent**, which
may differ from the dragged node's parent — so a single gesture can reparent and
position in one move.

**Illegal drops are refused, not corrected** — onto a node's own descendant
(cycle), onto an `outcome` or `annotation` (both leaves), or dragging the root.
The drop indicator does not appear.

## Data flow

### Load

`MagicTools.call('google_sheets_get', { range: 'Trees!A2:C100' })`, then `parse`
each `tree_dsl`. A tree that fails to parse shows an error state in the sidebar
rather than breaking the app. Each cell's raw text is retained as
`lastKnownRemote` for conflict detection.

### Edit

Every operation goes through `edit.mjs`, producing a new tree pushed onto the
undo stack. Re-layout and re-render immediately so the canvas is always the
derived truth. Mark dirty; schedule a debounced save.

### Save — debounced 800ms

1. `serialize(tree)` → DSL text.
2. Re-read the target cell and compare with `lastKnownRemote`.
   - unchanged → write; update `lastKnownRemote`
   - **changed → do not write.** Banner: "This tree changed in the sheet since
     you loaded it," offering Overwrite / Reload / Keep editing locally.
3. Write with **`google_sheets_batch_update_values` and
   `value_input_option: 'RAW'`**, updating `Trees!B<row>` and stamping
   `Trees!C<row>` with today's date.

Undo also triggers a debounced save.

**Why `batch_update_values` and not `google_sheets_update`:** the latter's schema
exposes no `value_input_option`, so it defaults to `USER_ENTERED`, which
interprets a leading `=` as a formula — and the DSL is full of `= outcome` lines.
`RAW` is also the mode verified to preserve DSL indentation and newlines when the
sheet was seeded on 2026-08-03.

### Validation reuses the parser

After each edit, run `parseTree(serialize(tree))`. Failures surface as error
badges on the offending nodes plus a banner noting that `render.mjs` will refuse
the tree. **Autosave still proceeds** — losing work to a transiently invalid
state is worse than storing one. This round-trip doubles as a continuous
integrity check on `serialize`.

### When `window.MagicTools` is missing

The app opens read-only with a banner linking to `mcplocker.w10external.com`. It
does not pretend edits are saved.

## Testing

| target | approach |
|---|---|
| `serialize.mjs` | Round-trip property test over all fixtures: `parse(serialize(t))` deep-equals `t`. Plus unit tests for continuation lines, subtitles, edge labels, `?AND`. |
| `edit.mjs` | Unit test each operation for the returned tree *and* for non-mutation of the input. Illegal-operation tests: reparent onto a descendant, onto an outcome, moving the root. |
| `svg.mjs` | New test: every box emits a `data-node-id`, and ids are unique. |
| `bundle.mjs` | Assert the output contains no `import` or `export` statements and that it evaluates without throwing. |
| `app.js` | Not unit-tested by design. Verified against a manual checklist: load, each gesture, conflict banner, read-only mode. |

## Decisions made rather than asked

- **Deleting a node removes its whole subtree** rather than promoting children.
  Promotion silently produces structures the user did not intend, such as an
  outcome adopting a decision's branches. Subtree delete is predictable and undo
  is one keystroke.
- **Kind changes are unconstrained.** Blocking a keystroke because the
  intermediate tree is invalid is more annoying than flagging the result, and
  mid-edit trees are often briefly invalid.
- **Debounced writes, local undo, and clobber detection** were added on top of
  the chosen autosave model. They do not reintroduce a Save button; they bound
  the cost of autosave's known downsides.
- **No `MagicStorage` draft buffer.** With 800ms debounced autosave it would
  protect at most 800ms of typing. Dropped as YAGNI.

## Rejected

**Freeform box positioning.** Dragging to set absolute coordinates was considered
and rejected. Node ids are positional (`n1`, `n2`, …) and assigned during layout
traversal, so inserting a node reshuffles every id after it and saved positions
would attach to the wrong boxes. Content-keyed overrides would avoid that but go
stale on every rename, and 30 procedures would mean 30 hand-maintained layouts
with auto-layout no longer able to help. Structural editing gives visual
authoring without owning coordinates.

## Risks

- **`.mjs` MIME type on Magic is unverified.** Mitigated by bundling to one
  `.js`; the risk never materialises.
- **`MagicTools` depends on the MCPLocker browser extension.** Precedent exists —
  `wocoo-triage-v3` already calls Google Sheets this way — but a viewer without
  the extension gets read-only mode.
- **Sheets API write volume.** Debouncing at 800ms plus one read per write cycle
  keeps this modest for single-user editing. Not designed for several people
  editing one tree at once.
