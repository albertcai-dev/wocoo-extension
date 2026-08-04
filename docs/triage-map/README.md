# Triage decision map renderer

Generates one SVG decision map per triage procedure from the DSL authored in the
[triage map sheet](https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit).

Design: `../superpowers/specs/2026-08-03-triage-decision-map-design.md`

## Render

```bash
node docs/triage-map/render.mjs
open docs/triage-map/out/index.html
```

`out/` is build output and is gitignored. Never edit the SVGs by hand. The
generated `out/index.html` is self-contained (SVGs inlined), so it works opened
straight from disk with no server.

## Hosted editor

<https://magic.w10e.com/albert.cai/wocoo-triage-map> — Okta-gated. Reads the
`Trees` tab at runtime and writes edits back, so **content changes never require
a re-push**; only code changes do.

Editing is *structural*: dragging reparents or reorders and layout is always
re-derived. There is no way to nudge a box for aesthetics — that is the trade for
never maintaining coordinates. Adjust `style.mjs` gaps instead, which affects
every diagram at once.

Autosave is debounced 800ms with local undo (⌘Z) and clobber detection: if a tree
changed in the sheet since load, the site refuses to overwrite and asks.

Design: `../superpowers/specs/2026-08-03-triage-map-editor-design.md`

### Republish after a code change

```bash
node docs/triage-map/bundle.mjs
```

That writes two files. Upload with `magic_file_write` to site `wocoo-triage-map`:

| local | site path | changes when |
|---|---|---|
| `out/web/vendor.js` | `vendor.js` | a pure module changes |
| `out/web/app.js` | `app.js` | `web/app.js.in` changes — most UI tweaks |
| `web/index.html` | `index.html` | the shell changes |

The split exists so a UI tweak is a ~16KB push rather than re-uploading every
module. `vendor.js` must load before `app.js`; the glue reaches the modules only
through `globalThis.TriageMap`, never lexical scope.

Verify with `magic_file_list` and compare byte sizes against local. Do **not**
verify with `curl` — unauthenticated requests get a `307` to Okta sign-in, so you
end up hashing the login page.

## Sync from the sheet

`render.mjs` reads `data/trees.json`, a committed snapshot of the sheet's
`Trees` tab. MCPLocker has no Node client, so refreshing is a Claude runbook:

> Read `Trees!A2:B100` from sheet `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto`
> and rewrite `docs/triage-map/data/trees.json` as an array of
> `{ procedure, tree_dsl }`, preserving newlines inside `tree_dsl`.

Then re-run the renderer and commit both the snapshot and any style changes.

## Tests

```bash
node --test docs/triage-map/*.test.mjs
```

Note the glob — `node --test <directory>` does not work on Node 24, which reads
a bare directory path as a module to execute.

## Modules

| file | responsibility |
|---|---|
| `parse.mjs` | DSL text → node tree, and all validation |
| `text.mjs` | glyph-width approximation, measurement, word wrap |
| `layout.mjs` | node tree → absolutely-positioned boxes, headers, edges |
| `svg.mjs` | positioned diagram → SVG string; edge geometry and escaping |
| `style.mjs` | every style token; the only file to edit to change the look |
| `render.mjs` | CLI: snapshot → `out/*.svg` + `out/index.html` |
| `fixtures/*.tree` | test inputs. These are **not** mirrors of the sheet — they exist to exercise the grammar, including shapes the sheet may not currently use. |

## DSL

Indentation is two spaces per level and gives parentage. The legend also lives
on `Trees!E1` in the sheet.

| sigil | kind |
|---|---|
| *(first line)* | the procedure name |
| `#` | branch header (a subtype); text after `\|` is where you validate it |
| `-` | step — an ordered action taken every time |
| `?` | decision — a yes/no test |
| `?AND` | conjoined decision; 2+ consecutive siblings, all must hold |
| `~` | annotation — how to validate the step/decision above it |
| `=` | outcome — terminal action; text after `\|` is the reason |

A word before `=` is the edge label (`Yes` renders green, `No` red). A
deeper-indented line with no sigil continues the line above it.

The parser refuses to render an invalid tree. It fails with line numbers on: an
outcome with children, a decision with no branches, a one-member `?AND` group,
odd indentation, an indent jump of more than one level, and a second root.

## Layout notes

Two behaviours that are easy to break and are covered by tests:

- **`anchorY`** — outgoing straight edges start below a node's annotation stack,
  not at the node's bottom edge. Otherwise the edge and its `Yes` label run
  straight through the annotation explaining that very decision.
- **`col`** — elbow rails clear only boxes in their own column. Scanning all
  boxes pushes rails across into the neighbouring column.

Font metrics are approximated for Inter. Where Inter is absent the fallback face
is wider, so boxes carry a `widthSafety` margin rather than clipping text.
