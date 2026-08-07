import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './web/harness/scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const built = join(here, 'out', 'web');

// The harness drives the REAL bundle in a real browser. Skip rather than fail
// where Chrome or a build is missing, so the rest of the suite still runs.
const runnable = existsSync(CHROME) && existsSync(join(built, 'app.js'));

const PRELUDE = `
function probe(t) {
  var d = document.createElement('div');
  d.className = 'probe';
  d.textContent = t;
  document.body.appendChild(d);
}
function tick() { return new Promise(function (r) { setTimeout(r, 60); }); }
function ready() {
  return new Promise(function (r) {
    var iv = setInterval(function () {
      if (document.querySelector('#scaler g[data-node-uid]')) { clearInterval(iv); r(); }
    }, 30);
  });
}
function fastEl() { return document.getElementById('fastEdit'); }
function buttons() {
  return ['kind', 'addChild', 'addSib', 'del'].map(function (i) {
    var e = document.getElementById(i);
    return i + '=' + (e && e.disabled ? 'OFF' : 'on');
  }).join(' ');
}
function titles() {
  return Array.prototype.map.call(
    document.querySelectorAll('#scaler g[data-node-uid]'),
    function (g) {
      var t = g.querySelector('text[font-weight]');
      return t ? t.textContent : '';
    }
  );
}
function key(target, k) {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true,
  }));
}
function type(s) { fastEl().value = s; }
function paste(text) {
  var dt = new DataTransfer();
  dt.setData('text/plain', text);
  document.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  }));
}
`;

function runScenario(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-harness-'));
  cpSync(join(built, 'vendor.js'), join(dir, 'vendor.js'));
  cpSync(join(built, 'app.js'), join(dir, 'app.js'));

  const stub = `<script>
window.MagicTools = { call: function (tool) {
  if (tool === 'google_sheets_get') {
    return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(
      { values: ${JSON.stringify(scenario.rows)} }
    ) }] });
  }
  return Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
} };
</script>`;

  const driver = `<script>
${PRELUDE}
(async function () {
  try { ${scenario.drive} }
  catch (e) { probe('ERROR ' + e.message); }
})();
</script>`;

  let html = readFileSync(join(here, 'web', 'index.html'), 'utf8');
  html = html.replace('<script src="vendor.js"></script>', stub + '<script src="vendor.js"></script>');
  html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>' + driver);
  writeFileSync(join(dir, 'index.html'), html);

  const out = execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom',
    `file://${join(dir, 'index.html')}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  return [...out.matchAll(/class="probe">([^<]*)/g)].map((m) => m[1]);
}

for (const scenario of SCENARIOS) {
  test(`harness: ${scenario.name}`, { skip: runnable ? false : 'Chrome or build missing' }, () => {
    assert.deepEqual(runScenario(scenario), scenario.expect);
  });
}
