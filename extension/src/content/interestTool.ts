export {}; // Treat as module → file-scoped declarations, no collision with other content scripts.

// Content script for the local Interest Validation tool (Streamlit, localhost:8501).
// Chain, when the side panel opened us with ?identity=<identity_canonical_id>:
//   1. Click the "Single User Validation" tab
//   2. Type the identity into "Enter identity_canonical_id here then press Enter"
//   3. Press Enter — Streamlit reruns and renders the validation for that identity
//
// Streamlit renders BaseWeb components, so tabs are `button[data-baseweb="tab"]` and the
// text input is a plain React-controlled <input>. `st.tabs` has no Python API for picking
// the active tab, which is why this runs in the DOM rather than in app.py — the tool is
// maintained by someone else and shouldn't need patching.

const IDENTITY_PARAM = 'identity';
const TAB_LABEL = 'Single User Validation';
const INPUT_LABEL_MATCH = /identity_canonical_id/i;

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-interest]', msg, ...args);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Polls for `find()` to return something visible, up to `timeoutMs`. */
async function waitFor<T extends HTMLElement>(find: () => T | null, timeoutMs = 30_000, label = 'element'): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = find();
    if (el && isVisible(el)) return el;
    await sleep(250);
  }
  log(`timed out waiting for ${label}`);
  return null;
}

function setValue(el: HTMLInputElement, value: string) {
  // React tracks the input's value internally — assigning through the native setter is
  // what makes it notice the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressEnter(el: HTMLInputElement) {
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
  }
}

function findTab(label: string): HTMLElement | null {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('button[data-baseweb="tab"], [role="tab"]'));
  // includes() rather than === so nested markup / stray whitespace doesn't break the
  // match. "All Users Validation" can't false-positive on "Single User Validation".
  return tabs.find((t) => (t.textContent || '').trim().includes(label)) ?? null;
}

function findIdentityInput(): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'));
  return inputs.find((i) => INPUT_LABEL_MATCH.test(i.getAttribute('aria-label') || '')) ?? null;
}

async function run() {
  const identity = new URLSearchParams(location.search).get(IDENTITY_PARAM);
  if (!identity) { log('no ?identity= param — nothing to prefill'); return; }
  log('prefilling identity', identity);

  const tab = await waitFor(() => findTab(TAB_LABEL), 30_000, `"${TAB_LABEL}" tab`);
  if (!tab) return;
  // Streamlit keeps every tab panel mounted and hides the inactive ones, so the click is
  // what makes the input visible — and what the agent would have done by hand.
  if (tab.getAttribute('aria-selected') !== 'true') {
    tab.click();
    await sleep(300);
  }

  const input = await waitFor(findIdentityInput, 15_000, 'identity input');
  if (!input) return;

  if (input.value.trim() === identity) { log('identity already filled — leaving it alone'); return; }

  input.focus();
  setValue(input, identity);
  await sleep(120);
  pressEnter(input);
  // Streamlit also commits a text_input on blur — a cheap belt-and-braces in case the
  // synthetic Enter is swallowed.
  await sleep(200);
  if (document.activeElement === input) input.blur();

  log('submitted identity — Streamlit should be running the single-user validation');
}

// Streamlit boots its React tree after the websocket connects, so the DOM is empty at
// document_idle. waitFor() handles that; run once per page load.
void run();
