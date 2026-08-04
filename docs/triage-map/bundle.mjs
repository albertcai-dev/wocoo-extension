// Concatenates the pure modules (and the browser glue, when present) into a
// single classic script. Magic's MIME handling for .mjs is unverified, and a
// wrong Content-Type breaks ES module imports outright — one .js file sidesteps
// the question entirely.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Dependency order: a module may only reference ones above it.
const MODULES = [
  'style.mjs',
  'text.mjs',
  'parse.mjs',
  'serialize.mjs',
  'layout.mjs',
  'svg.mjs',
  'edit.mjs',
];

const EXPOSED = [
  'S', 'edgeLabelColor',
  'measure', 'wrap',
  'parseTree', 'ParseError',
  'serialize', 'titleProblem',
  'layout',
  'toSvg',
  'EditError', 'locate', 'maxUid', 'defaultChildKind',
  'setText', 'setKind', 'setEdgeLabel',
  'addChild', 'addSibling', 'deleteNode', 'moveNode', 'reparent', 'reorderSibling',
];

export function stripModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .filter((line) => !/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)export\s+/, '$1'))
    .join('\n');
}

function readModule(name) {
  return stripModuleSyntax(readFileSync(join(here, name), 'utf8'));
}

// Top-level declarations, for collision detection. Only matches declarations at
// column zero, which is exactly the scope flattening merges.
export function topLevelNames(source) {
  const names = [];
  for (const line of source.split('\n')) {
    const m = line.match(/^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (m) names.push(m[1]);
  }
  return names;
}

// Flattening every module into one scope means a duplicate top-level `function`
// declaration silently shadows the earlier one for ALL callers — parse.mjs and
// edit.mjs both declaring mkNode broke parsing in a way no module-level test
// could see. Fail the build instead.
export function assertNoCollisions() {
  const owner = new Map();
  const clashes = [];
  for (const name of MODULES) {
    for (const symbol of topLevelNames(readModule(name))) {
      if (owner.has(symbol)) {
        clashes.push(`"${symbol}" is declared in both ${owner.get(symbol)} and ${name}`);
      } else {
        owner.set(symbol, name);
      }
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      `Bundle would shadow ${clashes.length} top-level name(s):\n  ${clashes.join('\n  ')}\n` +
      'Rename one of each pair — flat concatenation puts them in a single scope.',
    );
  }
}

function iife(body) {
  return `(function () {\n'use strict';\n${body}\n})();\n`;
}

// Two output files rather than one. The glue reaches the pure modules only
// through globalThis.TriageMap, never through lexical scope, so they can ship
// separately — which keeps a UI tweak to a ~14KB push instead of re-uploading
// every module, and lets each file's upload be byte-verified on its own.
export function bundlePure() {
  assertNoCollisions();
  const parts = MODULES.map((name) => `// ---- ${name} ----\n${readModule(name)}`);
  parts.push(`globalThis.TriageMap = { ${EXPOSED.join(', ')} };`);
  return iife(parts.join('\n'));
}

export function bundleGlue() {
  const gluePath = join(here, 'web', 'app.js.in');
  if (!existsSync(gluePath)) return iife('// no glue present');
  return iife(readFileSync(gluePath, 'utf8'));
}

function main() {
  const outDir = join(here, 'out', 'web');
  mkdirSync(outDir, { recursive: true });

  const vendor = bundlePure();
  writeFileSync(join(outDir, 'vendor.js'), vendor, 'utf8');
  const glue = bundleGlue();
  writeFileSync(join(outDir, 'app.js'), glue, 'utf8');

  console.log(`Wrote ${join(outDir, 'vendor.js')} (${Buffer.byteLength(vendor)} bytes)`);
  console.log(`Wrote ${join(outDir, 'app.js')} (${Buffer.byteLength(glue)} bytes)`);
}

if (process.argv[1] && process.argv[1].endsWith('bundle.mjs')) main();
