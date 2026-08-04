# Triage Map Orientation and Zoom — Design

**Date:** 2026-08-04
**Status:** Approved, not yet implemented
**Builds on:** `2026-08-03-triage-decision-map-design.md`, `2026-08-03-triage-map-editor-design.md`
**Sheet:** https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit
**Site:** https://magic.w10e.com/albert.cai/wocoo-triage-map

## Purpose

Two canvas viewing controls the editor lacks:

1. **Zoom** — present in the pre-editor viewer, dropped when `index.html` became the editor shell.
2. **Per-map orientation** — a `vertical` / `horizontal` toggle that the layout engine honours, stored per map.

### Why orientation is worth the refactor

Diagram proportions are badly lopsided in one direction only, and which direction depends on the tree's shape. Measured vertical dimensions today:

| procedure | shape | vertical (measured) |
|---|---|---|
| CC Fee Relief | 4 branch headers | 1706w × 567h |
| Declined Transaction | linear checklist | 427w × 759h |

What the transpose does to each is **structurally** predictable, though the exact numbers are only known once measured:

- **A linear chain** stacks its nodes along the flow axis, so transposing converts a tall narrow strip into a short wide one. Height must fall and width must rise. This is the dramatic case.
- **A multi-band tree** stops placing bands side by side and stacks them instead. A band's cross extent becomes its tallest single box rather than the sum of its nodes, so the diagram gets somewhat narrower and somewhat taller — a rebalancing, not a flip. CC Fee Relief is expected to stay landscape, just less extremely so.

Wide diagrams force horizontal scrolling, which is worse than vertical scrolling, so reducing width is the win for multi-band trees. A per-map choice earns its keep in both directions — but only the chain case reverses orientation outright, and tests should assert only the structurally certain claims.

### Out of scope

- Freeform box positioning. Rejected in the editor spec and still rejected.
- Any orientation beyond these two (no radial, no auto-choose).
- Changing box sizing or text wrapping. Boxes are sized by their text in both modes.

## Layout: axis parameterisation

The transpose is a renaming of two axes, not a second layout engine. Today's algorithm already has an implicit **main axis** (the direction children flow) and **cross axis** (the direction siblings separate).

| | vertical | horizontal |
|---|---|---|
| children of a header flow along | `y`, downward | `x`, rightward |
| headers separate along | `x`, rightward | `y`, downward |
| `?AND` members separate along | `x` | `y` |
| annotations stack along | main (`y`) | main (`x`) |
| decision alternatives stack along | main (`y`) | main (`x`) |
| header text sits | above its column | left of its row |
| elbow rail runs along | cross (`x`) | cross (`y`) |

**Boxes never transpose.** A box is sized by its wrapped text regardless of orientation. So the main-axis size is `h` when vertical and `w` when horizontal, while the cross-axis size is `w` when vertical and `h` when horizontal. That asymmetry is the mechanism.

**Header offset is symmetric.** In vertical mode a header sits above its column and children start below it — main-axis offset. In horizontal mode it sits left of its row and children start to its right — also main-axis offset. Both modes therefore compute a header's main-axis extent (its text height when vertical, its text width when horizontal) and a cross-axis extent.

### Renames

Three, so the code stops implying "vertical" is the only mode:

| from | to | meaning |
|---|---|---|
| `anchorY` | `anchor` | scalar on the main axis where outgoing straight edges begin, still pushed past the annotation stack |
| `col` | `band` | a header's index — a column when vertical, a row when horizontal |
| `S.gap.vertical`, `S.gap.column` | `S.gap.main`, `S.gap.cross` | spacing between flow siblings, and between bands |

`S.page.rightAllowance` becomes **`S.page.railAllowance`**, applied to whichever axis the rail hangs off: the right edge when vertical, the bottom edge when horizontal. It exists because layout cannot know where a rail lands — rails are computed at render time from the boxes an edge passes.

### Signatures

- `layout(root, orientation = 'vertical')` returns the diagram with `orientation` on it.
- `toSvg(diagram, title)` reads `diagram.orientation`; no new parameter.
- `railFor(a, b, boxes, orientation)` intersects on the main axis and still scans only same-`band` boxes.

## The safety property

**Vertical output must not change at all.** The existing 111 tests encode two edge-routing defects that cost real debugging on 2026-08-03: straight edges crossing the annotation that explains their own decision, and elbow rails reaching into the neighbouring column. They must keep passing unchanged apart from the three renames.

To make silent regression impossible, a **golden-file test** commits the current vertical SVG for a fixture and asserts byte equality. If vertical rendering shifts by one pixel, that test fails.

## Sheet

`Trees` gains column **D `orientation`**:

- strict data validation on `vertical` | `horizontal`
- blank is treated as `vertical`, so existing rows need no migration
- load range becomes `Trees!A2:D100`

Two deliberate asymmetries in saving:

- **Flipping orientation does not stamp `last_reviewed`.** It is a view preference, not a content change; stamping would make that column misreport when the tree was last thought about.
- **Clobber detection stays on column B only.** Losing a concurrent orientation flip is harmless, so column D is last-write-wins. Guarding it would raise conflict banners over something nobody minds losing.

## Editor controls

**Orientation** — a `Vertical | Horizontal` segmented control in the toolbar, enabled whenever a valid tree is loaded. Unlike the kind picker it does not require a selected node.

**Zoom** — `−` / `%` / `+` / `Fit` / `Actual`, implemented as a CSS `transform: scale()` on a wrapper around the inline SVG rather than by rewriting SVG dimensions.

Two interactions that break without explicit handling:

- **The inline text editor must scale its position.** `showEditor()` positions the popup from `rect.getAttribute('x')` / `('y')`, which are SVG user units. Under a CSS transform these need multiplying by the zoom factor, or the popup drifts away from its box as you zoom. Drag is unaffected — it works from `getBoundingClientRect()`, which is transform-aware.
- **Zoom refits on procedure change and on orientation flip.** A horizontal map inheriting a vertical map's zoom looks broken.

## Local pipeline

`data/trees.json` entries gain an optional `orientation`, passed through `renderAll` to `layout`, defaulting to `vertical`. The README sync runbook moves from `Trees!A2:B100` to `Trees!A2:D100` so the snapshot carries orientation.

## Testing

| target | approach |
|---|---|
| golden guard | committed vertical SVG for a fixture, asserted byte-identical |
| `layout` horizontal | mirrors of the load-bearing vertical tests: headers become rows ordered top-to-bottom, children advance on `x`, no two boxes overlap, `anchor` clears the annotation stack, rails scoped to `band` |
| `layout` both modes | every fixture laid out in both orientations produces no overlaps and bounds containing every box |
| `svg` horizontal | a straight edge runs along `x` at a fixed `y` inset; an elbow rail runs along `y` and clears same-band boxes; diagram bounds leave room for a rail hanging off the last band |
| `render` | `orientation` from the snapshot reaches `layout`; absent means vertical |
| editor glue | manual, as before: toggle re-renders and persists to column D; zoom controls; inline editor stays on its box at 200% zoom |

## Deployment

`vendor.js` changes (layout, svg, style all move), so both files get pushed this time — not the app-only push the split usually allows. Verify with `magic_file_list` byte sizes, never `curl`.
