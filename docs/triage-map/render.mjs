// CLI entry point: reads the committed snapshot of the sheet's Trees tab and
// writes one SVG per procedure plus an index contact sheet.
//
//   node docs/triage-map/render.mjs
//
// Refresh data/trees.json from the sheet first — see README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTree, ParseError } from './parse.mjs';
import { layout } from './layout.mjs';
import { toSvg } from './svg.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function renderAll(trees) {
  const out = [];
  for (const row of trees) {
    if (!row.tree_dsl || row.tree_dsl.trim() === '') continue;
    try {
      out.push({
        slug: slugify(row.procedure),
        procedure: row.procedure,
        svg: toSvg(layout(parseTree(row.tree_dsl)), row.procedure),
      });
    } catch (err) {
      if (err instanceof ParseError) {
        throw new Error(`Tree for "${row.procedure}" failed to parse:\n${err.message}`);
      }
      throw err;
    }
  }
  return out;
}

const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit';

// Self-contained viewer: SVGs are inlined rather than linked, so this single
// file works opened locally and uploaded to a Magic site with no other assets.
export function indexHtml(rendered, generatedAt = new Date().toISOString().slice(0, 10)) {
  const nav = rendered
    .map(
      (r, i) =>
        `    <button class="nav-item${i === 0 ? ' active' : ''}" data-slug="${r.slug}">${r.procedure}</button>`,
    )
    .join('\n');

  const panels = rendered
    .map(
      (r, i) => `  <section class="panel${i === 0 ? ' active' : ''}" data-slug="${r.slug}">
    <h2>${r.procedure}</h2>
    <div class="canvas"><div class="scaler">${r.svg}</div></div>
  </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WOCOO Triage Decision Maps</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif;
         margin: 0; background: #FAF9F7; color: #1F2421; display: flex; min-height: 100vh; }
  aside { width: 260px; flex: 0 0 260px; background: #fff; border-right: 1px solid #E5E2DC;
          padding: 24px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { color: #7A756C; font-size: 12px; margin: 0 0 20px; }
  .nav-item { display: block; width: 100%; text-align: left; border: 0; background: none;
              font: inherit; font-size: 13px; color: #1F2421; padding: 8px 10px; border-radius: 6px;
              cursor: pointer; margin-bottom: 2px; }
  .nav-item:hover { background: #F2F0EB; }
  .nav-item.active { background: #EDE9E0; font-weight: 600; }
  footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #E5E2DC;
           font-size: 11.5px; color: #7A756C; line-height: 1.5; }
  footer a { color: #1B7F4B; }
  main { flex: 1; padding: 24px 32px 64px; overflow-x: hidden; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .toolbar button { font: inherit; font-size: 12px; border: 1px solid #E5E2DC; background: #fff;
                    border-radius: 6px; padding: 5px 10px; cursor: pointer; color: #1F2421; }
  .toolbar button:hover { background: #F2F0EB; }
  #zoomLabel { font-size: 12px; color: #7A756C; min-width: 44px; }
  .panel { display: none; }
  .panel.active { display: block; }
  h2 { font-size: 17px; margin: 0 0 14px; }
  .canvas { border: 1px solid #E5E2DC; border-radius: 10px; background: #fff;
            padding: 8px; overflow: auto; max-height: calc(100vh - 160px); }
  .scaler { transform-origin: top left; }
  .scaler svg { display: block; }
</style>
</head>
<body>
<aside>
  <h1>Triage Decision Maps</h1>
  <p class="sub">${rendered.length} procedure${rendered.length === 1 ? '' : 's'} mapped</p>
${nav}
  <footer>
    Generated ${generatedAt} from the <a href="${SHEET_URL}">Trees tab</a>.<br>
    Edit the sheet, never these diagrams.
  </footer>
</aside>
<main>
  <div class="toolbar">
    <button id="zoomOut">&minus;</button>
    <span id="zoomLabel">100%</span>
    <button id="zoomIn">+</button>
    <button id="zoomFit">Fit width</button>
    <button id="zoomReset">Reset</button>
  </div>
${panels}
</main>
<script>
  var zoom = 1;

  function activePanel() {
    return document.querySelector('.panel.active');
  }

  function applyZoom() {
    var panel = activePanel();
    if (!panel) return;
    var scaler = panel.querySelector('.scaler');
    var svg = scaler.querySelector('svg');
    scaler.style.transform = 'scale(' + zoom + ')';
    // Reserve laid-out space for the scaled content so scrollbars behave.
    scaler.style.width = (svg.getAttribute('width') * zoom) + 'px';
    scaler.style.height = (svg.getAttribute('height') * zoom) + 'px';
    document.getElementById('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  }

  function setZoom(z) {
    zoom = Math.min(4, Math.max(0.2, z));
    applyZoom();
  }

  function fitWidth() {
    var panel = activePanel();
    if (!panel) return;
    var canvas = panel.querySelector('.canvas');
    var svg = panel.querySelector('svg');
    var available = canvas.clientWidth - 20;
    setZoom(available / Number(svg.getAttribute('width')));
  }

  document.getElementById('zoomIn').onclick = function () { setZoom(zoom * 1.25); };
  document.getElementById('zoomOut').onclick = function () { setZoom(zoom / 1.25); };
  document.getElementById('zoomFit').onclick = fitWidth;
  document.getElementById('zoomReset').onclick = function () { setZoom(1); };

  Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (btn) {
    btn.onclick = function () {
      var slug = btn.getAttribute('data-slug');
      Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
        p.classList.toggle('active', p.getAttribute('data-slug') === slug);
      });
      fitWidth();
    };
  });

  window.addEventListener('resize', fitWidth);
  fitWidth();
</script>
</body>
</html>
`;
}

function main() {
  const dataPath = join(here, 'data', 'trees.json');
  const trees = JSON.parse(readFileSync(dataPath, 'utf8'));
  const rendered = renderAll(trees);

  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  for (const r of rendered) {
    writeFileSync(join(outDir, `${r.slug}.svg`), r.svg, 'utf8');
  }
  writeFileSync(join(outDir, 'index.html'), indexHtml(rendered), 'utf8');

  console.log(`Rendered ${rendered.length} diagram(s) to ${outDir}`);
  for (const r of rendered) console.log(`  ${r.slug}.svg  ${r.procedure}`);
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) main();
