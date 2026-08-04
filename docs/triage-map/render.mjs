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

export function indexHtml(rendered) {
  const items = rendered
    .map(
      (r) => `  <section>
    <h2>${r.procedure}</h2>
    <img src="${r.slug}.svg" alt="${r.procedure} decision map">
  </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WOCOO Triage Decision Maps</title>
<style>
  body { font-family: Inter, -apple-system, sans-serif; margin: 0; padding: 40px; background: #FAF9F7; color: #1F2421; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.meta { color: #7A756C; font-size: 13px; margin: 0 0 32px; }
  section { margin-bottom: 48px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  img { max-width: 100%; border: 1px solid #E5E2DC; border-radius: 8px; background: #fff; }
</style>
</head>
<body>
<h1>WOCOO Triage Decision Maps</h1>
<p class="meta">Generated from the Trees tab. Do not edit these files by hand.</p>
${items}
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
