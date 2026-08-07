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

The canvas has zoom controls (`−` / `+` / `Fit` / `Actual`). **Zoom starts at
Actual and never changes on its own** — auto-fitting magnified a small map to the
4× clamp, since a single root box is only ~230px wide against a ~1000px pane.
`Fit` is still there when a wide map needs it.

### Authoring by keyboard

With a node selected: `Tab` adds a child and starts typing, `Enter` adds a
sibling, `⇧Tab` outdents, arrows move the selection (no wrapping), `⌫` deletes,
`⌘Enter` opens the full popup for subtitle and edge label. While typing, `Enter`
commits and chains onward, `Tab` commits and indents, `Esc` commits and stops.
`Enter` or `Esc` on an empty freshly created node removes it — that is how a
burst ends.

A keystroke does nothing whenever its toolbar equivalent is disabled, rather
than raising an error banner mid-burst.

`⌘V` pastes a numbered or bulleted list as a chain of steps under the selection,
nesting by indentation, as one undo step. Every pasted line becomes a step;
change kinds afterwards with the picker. A pasted `|` splits title from subtitle,
as it does in the DSL — otherwise it would be re-read as a subtitle separator and
corrupt the tree.

### Browser tests

`harness.test.mjs` drives the real built bundle in headless Chrome against a
stubbed `MagicTools`, asserting DOM state. It skips when Chrome or `out/web/` is
missing. **Build first**, or the scenarios test a stale bundle:

```bash
node docs/triage-map/bundle.mjs && node --test docs/triage-map/harness.test.mjs
```

This is the only coverage `app.js` has, and it earned its place: it diagnosed the
disabled-toolbar bug in five minutes, and it guards the two traps most likely to
regress — `Tab` stealing focus to the toolbar, and an inline editor failing to
track zoom.

### Orientation

Each map is `vertical` (branch headers side by side as columns, children flowing
down) or `horizontal` (headers stacked as rows, children flowing right), stored
per map in `Trees` column D and shared with everyone. Blank means vertical.
Flipping it does **not** stamp `last_reviewed` and is exempt from clobber
detection, because losing a concurrent view-preference flip is harmless.

**Set expectations honestly: this is a preference toggle, not a space win.**
Measured on the fixtures:

| | vertical | horizontal |
|---|---|---|
| CC Fee Relief (4 bands) | 1706×567 | 1664×631 |
| Declined Transaction (chain) | 427×759 | 2287×234 |

Boxes are far wider than they are tall — text wraps at 230px while boxes are
39–78px high — so chaining along x always produces a much larger extent than
chaining along y. A multi-band tree therefore barely narrows, and a chain turns
into a very wide, short ribbon. Useful if you want a procedure to read as one
left-to-right flow; not a fix for a diagram being too wide.

Design: `../superpowers/specs/2026-08-03-triage-map-editor-design.md` and
`../superpowers/specs/2026-08-04-triage-map-orientation-and-zoom-design.md`

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

**`magic_file_edit` is mostly reliable but occasionally flaky.** On 2026-08-04
four consecutive edits to `vendor.js` failed with a bogus `site_not_found` while
`magic_file_list` kept working; a whole-file `magic_file_write` then succeeded.
On 2026-08-07 three edits to the same file went through without trouble. So the
failure is transient, not tied to a file, a size, or payload content, and the
error message is misleading.

Practical rule: use `file_edit`, verify byte sizes with `magic_file_list`
afterwards, and fall back to `magic_file_write` if an edit fails twice. Never
verify with `curl` — unauthenticated requests get a `307` to Okta sign-in.

## Sync from the sheet

`render.mjs` reads `data/trees.json`, a committed snapshot of the sheet's
`Trees` tab. MCPLocker has no Node client, so refreshing is a Claude runbook:

> Read `Trees!A2:D100` from sheet `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto`
> and rewrite `docs/triage-map/data/trees.json` as an array of
> `{ procedure, tree_dsl, orientation }`, preserving newlines inside `tree_dsl`
> and omitting `orientation` when the cell is blank.

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
