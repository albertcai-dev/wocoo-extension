import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripModuleSyntax, bundlePure, bundleGlue, topLevelNames, assertNoCollisions,
} from './bundle.mjs';

test('stripModuleSyntax drops import lines', () => {
  const out = stripModuleSyntax("import { S } from './style.mjs';\nconst a = 1;\n");
  assert.ok(!out.includes('import'));
  assert.ok(out.includes('const a = 1;'));
});

test('stripModuleSyntax unwraps export declarations', () => {
  const out = stripModuleSyntax('export function f() {}\nexport const c = 2;\nexport class K {}\n');
  assert.ok(out.includes('function f() {}'));
  assert.ok(out.includes('const c = 2;'));
  assert.ok(out.includes('class K {}'));
  assert.ok(!/^export /m.test(out));
});

test('stripModuleSyntax drops bare export lists', () => {
  const out = stripModuleSyntax('const a = 1;\nexport { a };\n');
  assert.ok(!out.includes('export'));
});

test('topLevelNames finds column-zero declarations only', () => {
  const src = [
    'function outer() {',
    '  function inner() {}',
    '  const local = 1;',
    '}',
    'const top = 2;',
    'class Klass {}',
  ].join('\n');
  assert.deepEqual(topLevelNames(src), ['outer', 'top', 'Klass']);
});

test('the real modules declare no colliding top-level names', () => {
  assert.doesNotThrow(assertNoCollisions);
});

test('the pure bundle contains no module syntax', () => {
  const code = bundlePure();
  assert.ok(!/^\s*import\s/m.test(code), 'no import statements');
  assert.ok(!/^\s*export\s/m.test(code), 'no export statements');
});

test('the pure bundle evaluates and exposes the pipeline', () => {
  const code = bundlePure();
  const globals = {};
  new Function('globalThis', code).call(globals, globals);
  const api = globals.TriageMap;
  assert.equal(typeof api.parseTree, 'function');
  assert.equal(typeof api.serialize, 'function');
  assert.equal(typeof api.layout, 'function');
  assert.equal(typeof api.toSvg, 'function');
  assert.equal(typeof api.setText, 'function');
});

test('the bundled pipeline renders the same way as the modules do', async () => {
  const [{ parseTree }, { layout }, { toSvg }] = await Promise.all([
    import('./parse.mjs'), import('./layout.mjs'), import('./svg.mjs'),
  ]);
  const src = 'P\n  - one\n  ? Q?\n    Yes = Done\n';
  const expected = toSvg(layout(parseTree(src)), 'P');

  const globals = {};
  new Function('globalThis', bundlePure()).call(globals, globals);
  const api = globals.TriageMap;
  const actual = api.toSvg(api.layout(api.parseTree(src)), 'P');

  assert.equal(actual, expected);
});

test('the glue bundle carries no module syntax and reaches modules only via TriageMap', () => {
  const glue = bundleGlue();
  assert.ok(!/^\s*import\s/m.test(glue), 'no import statements');
  assert.ok(!/^\s*export\s/m.test(glue), 'no export statements');
  assert.ok(glue.includes('globalThis.TriageMap'), 'glue must read the namespace');
});

test('the glue bundle does not redeclare anything the vendor bundle declares', () => {
  const vendorNames = new Set(topLevelNames(bundlePure()));
  for (const name of topLevelNames(bundleGlue())) {
    assert.ok(!vendorNames.has(name), `glue redeclares "${name}" from vendor`);
  }
});

test('the pure bundle exposes the fast-authoring functions', () => {
  const globals = {};
  new Function('globalThis', bundlePure()).call(globals, globals);
  const api = globals.TriageMap;
  assert.equal(typeof api.parseOutline, 'function');
  assert.equal(typeof api.insertOutline, 'function');
  assert.equal(typeof api.navigate, 'function');
});

test('the bundled outline pipeline matches the modules', async () => {
  const [{ parseOutline }] = await Promise.all([import('./outline.mjs')]);
  const src = '1. One\n   - Sub\n2. Two\n';
  const globals = {};
  new Function('globalThis', bundlePure()).call(globals, globals);
  assert.deepEqual(globals.TriageMap.parseOutline(src), parseOutline(src));
});
