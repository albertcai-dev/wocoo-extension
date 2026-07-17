# i2c Service Desk Form Autofill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the I2cCard's "Open i2c Form" link with a button that stashes Summary + Description in `chrome.storage.local` then opens the JSM portal URL, where a new content script picks up the values and fills the form's Summary input + Description rich-text editor.

**Architecture:** New `src/content/i2cservicedesk.ts` content script registered against `https://tracking.i2cinc.com/servicedesk/customer/portal/*` reads a one-shot `pending_i2c_servicedesk_form` storage key, polls for the Summary input and Description editor (textarea OR contenteditable ProseMirror), fills via React-friendly setters + `document.execCommand('insertText', ...)`, then clears the storage key. `src/sidepanel/MessagingCards.tsx` swaps the existing `<a>` link for a `<button>` that writes the storage key and opens the URL. The textarea Copy buttons stay as the fallback for any autofill failure.

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through a WOCOO ticket that renders the I2cCard.

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step. Do not introduce a test framework.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **Do not regress existing flows.** Especially the existing `src/content/i2c.ts` script (login fill on `wealthsimplecs.mycardplace.com`) and the existing Copy buttons on the I2cCard textareas.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports.
- **Storage key**: `pending_i2c_servicedesk_form`. Shape: `{ summary: string; description: string }`. One-shot — content script removes the key after the fill-or-timeout decision point.
- **Match pattern**: `https://tracking.i2cinc.com/servicedesk/customer/portal/*` (scoped to JSM portal paths only).
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification.

---

## File Structure

| Path | Change |
|---|---|
| `src/content/i2cservicedesk.ts` | **new** — content script: read storage key, poll for fields (250ms × 12 = 3s), fill Summary (input) + Description (textarea-first-then-ProseMirror), clear key. |
| `extension/manifest.json` | Add `https://tracking.i2cinc.com/*` to `host_permissions`; register new `content_scripts` entry. |
| `src/sidepanel/MessagingCards.tsx` | Replace the `<a href={I2C_FORM_URL}>` "Open i2c Form ↗" with a `<button>` (label: `↗ Open & Fill Form`) that writes `pending_i2c_servicedesk_form` then opens the URL. Keep the existing Copy buttons on the textareas. |

---

## Task 1: Add content script + register in manifest

**Files:**
- Create: `src/content/i2cservicedesk.ts`
- Modify: `extension/manifest.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a registered content script that runs on `tracking.i2cinc.com/servicedesk/customer/portal/*` and consumes `pending_i2c_servicedesk_form` from `chrome.storage.local`. No exports.

- [ ] **Step 1: Create `src/content/i2cservicedesk.ts`** with this content verbatim:

```ts
// Content script on tracking.i2cinc.com — picks up the side panel's stashed
// {summary, description} draft and pre-fills the JSM "Create" form, then clears
// the storage signal. One-shot: if no signal is present on load, no-op.

const PENDING_KEY = 'pending_i2c_servicedesk_form';
const POLL_INTERVAL_MS = 250;
const MAX_POLL_ATTEMPTS = 12; // 12 × 250ms = 3s
const POST_FILL_SETTLE_MS = 500;

interface PendingDraft {
  summary: string;
  description: string;
}

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-i2c-servicedesk]', msg, ...args);
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function findSummaryInput(): HTMLInputElement | null {
  // Find a visible label whose trimmed text starts with "Summary", then locate
  // a text-style <input> inside the same enclosing container.
  const labels = Array.from(document.querySelectorAll<HTMLElement>('label'));
  for (const l of labels) {
    const t = (l.textContent || '').trim();
    if (!/^Summary\b/i.test(t)) continue;
    const container = l.closest('div');
    const input = container?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
    if (input && isVisible(input)) return input;
  }
  return null;
}

function findDescriptionField(): { textarea: HTMLTextAreaElement | null; editor: HTMLElement | null } {
  // Description is either a plain textarea OR a contenteditable rich-text editor.
  // Walk Description labels and look for either inside the enclosing container.
  const labels = Array.from(document.querySelectorAll<HTMLElement>('label'));
  for (const l of labels) {
    const t = (l.textContent || '').trim();
    if (!/^Description\b/i.test(t)) continue;
    const container = l.closest('div');
    if (!container) continue;
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (textarea && isVisible(textarea)) return { textarea, editor: null };
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editor && isVisible(editor)) return { textarea: null, editor };
  }
  return { textarea: null, editor: null };
}

function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // React tracks input value via an internal hook on the prototype's setter; calling
  // the prototype's native setter then dispatching input + change is the canonical
  // way to make React notice the change.
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillDescription(field: { textarea: HTMLTextAreaElement | null; editor: HTMLElement | null }, value: string): boolean {
  if (field.textarea) {
    setReactInputValue(field.textarea, value);
    return field.textarea.value.length > 0;
  }
  if (field.editor) {
    field.editor.focus();
    // execCommand is deprecated but remains the most reliable cross-editor way to
    // insert plain text that the editor (ProseMirror / Atlaskit / etc.) will
    // recognize and integrate into its internal model.
    try {
      document.execCommand('insertText', false, value);
    } catch (e) {
      log('execCommand failed:', e);
    }
    return (field.editor.innerText || '').length > 0;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fillForm(draft: PendingDraft): Promise<void> {
  log('looking for form fields…');
  let summary: HTMLInputElement | null = null;
  let description: { textarea: HTMLTextAreaElement | null; editor: HTMLElement | null } = { textarea: null, editor: null };

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    summary = findSummaryInput();
    description = findDescriptionField();
    if (summary && (description.textarea || description.editor)) break;
    await sleep(POLL_INTERVAL_MS);
  }

  if (!summary) log('summary input not found after timeout');
  if (!description.textarea && !description.editor) log('description field not found after timeout');

  if (summary && draft.summary) {
    setReactInputValue(summary, draft.summary);
    log('summary filled');
  }
  if ((description.textarea || description.editor) && draft.description) {
    const ok = fillDescription(description, draft.description);
    log(ok ? 'description filled' : 'description fill produced empty content');
  }
}

async function main() {
  try {
    const result = await chrome.storage.local.get(PENDING_KEY);
    const draft = result[PENDING_KEY] as PendingDraft | undefined;
    if (!draft || typeof draft !== 'object' || typeof draft.summary !== 'string') {
      // No signal — direct visit (not triggered from the side panel). Silent no-op.
      return;
    }
    log('found pending draft', { summaryLen: draft.summary.length, descriptionLen: (draft.description || '').length });

    await fillForm(draft);

    // Wait a tick for editor state to settle, then clear the signal so a manual
    // page reload doesn't re-fill stale data.
    await sleep(POST_FILL_SETTLE_MS);
    await chrome.storage.local.remove(PENDING_KEY);
    log('done, signal cleared');
  } catch (e) {
    log('main failed:', e);
  }
}

main();
```

- [ ] **Step 2: Open `extension/manifest.json`** and add `tracking.i2cinc.com` to `host_permissions`. Find the existing block:

```json
  "host_permissions": [
    "https://wealthsimple.atlassian.net/*",
    "https://atlas.wealthsimple.com/*",
    "https://auth.atlassian.com/*",
    "https://api.atlassian.com/*",
    "https://wealthsimplecs.mycardplace.com/*",
    "https://*.preset.io/*",
    "https://admin.koho.ca/*",
    "https://ledge.wealthsimple.com/*",
    "https://app.slack.com/*"
  ]
```

Replace with:

```json
  "host_permissions": [
    "https://wealthsimple.atlassian.net/*",
    "https://atlas.wealthsimple.com/*",
    "https://auth.atlassian.com/*",
    "https://api.atlassian.com/*",
    "https://wealthsimplecs.mycardplace.com/*",
    "https://*.preset.io/*",
    "https://admin.koho.ca/*",
    "https://ledge.wealthsimple.com/*",
    "https://app.slack.com/*",
    "https://tracking.i2cinc.com/*"
  ]
```

- [ ] **Step 3: Add the new content_scripts entry** to the same `extension/manifest.json`. Find the existing `content_scripts` array (it currently ends with the slack entry):

```json
    {
      "matches": ["https://app.slack.com/*"],
      "js": ["src/content/slack.ts"],
      "run_at": "document_idle"
    }
```

Append a comma after the closing brace and add the new entry:

```json
    {
      "matches": ["https://app.slack.com/*"],
      "js": ["src/content/slack.ts"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://tracking.i2cinc.com/servicedesk/customer/portal/*"],
      "js": ["src/content/i2cservicedesk.ts"],
      "run_at": "document_idle"
    }
```

- [ ] **Step 4: Build to confirm everything compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors. The output should include a new `dist/assets/i2cservicedesk.ts-*.js` artifact alongside the other content scripts (the build line `dist/assets/i2cservicedesk.ts-*.js ... kB` appears).

- [ ] **Step 5: Confirm the manifest copied through to dist** and includes the new pieces:

```bash
grep -E 'tracking.i2cinc.com|i2cservicedesk' /Users/albert.cai/projects/wocoo-extension/extension/dist/manifest.json
```
Expected: at least 2 matches — one in `host_permissions`, one in `content_scripts`.

---

## Task 2: Replace I2cCard's Open link with an Open-and-Fill button

**Files:**
- Modify: `src/sidepanel/MessagingCards.tsx`

**Interfaces:**
- Consumes:
  - Task 1's content script (via the side-effect of writing `pending_i2c_servicedesk_form` to `chrome.storage.local`).
- Produces: no new exports — the existing `I2cCard` component keeps its signature.

- [ ] **Step 1: Open `src/sidepanel/MessagingCards.tsx`.** Find the existing I2cCard render block (around line 47–58):

```tsx
export function I2cCard({ ticket }: { ticket: WocooTicket }) {
  const initial = buildI2cDraft(ticket);
  const [summary, setSummary] = useState(initial.summary);
  const [description, setDescription] = useState(initial.description);

  return (
    <section style={cardStyle}>
      <header style={cardHeader}>
        <span style={cardTitle}>🎫 i2c Ticket</span>
        <a href={I2C_FORM_URL} target="_blank" rel="noreferrer" style={openLinkStyle}>Open i2c Form ↗</a>
      </header>

      <FieldBlock label="Suggested Summary" value={summary} onChange={setSummary} rows={2} />
      <FieldBlock label="Suggested Description" value={description} onChange={setDescription} rows={8} />
    </section>
  );
}
```

- [ ] **Step 2: Replace the I2cCard component** with the version below, which adds the `openAndFill` handler and swaps the `<a>` for a `<button>`:

```tsx
export function I2cCard({ ticket }: { ticket: WocooTicket }) {
  const initial = buildI2cDraft(ticket);
  const [summary, setSummary] = useState(initial.summary);
  const [description, setDescription] = useState(initial.description);

  async function openAndFill() {
    try {
      await chrome.storage.local.set({
        pending_i2c_servicedesk_form: { summary, description },
      });
    } catch (e) {
      // Storage write rarely fails, but if it does the agent can still paste via Copy.
      console.warn('[wocoo-i2c-card] storage write failed:', e);
    }
    window.open(I2C_FORM_URL, '_blank', 'noopener,noreferrer');
  }

  return (
    <section style={cardStyle}>
      <header style={cardHeader}>
        <span style={cardTitle}>🎫 i2c Ticket</span>
        <button type="button" onClick={openAndFill} style={openButtonStyle}>↗ Open &amp; Fill Form</button>
      </header>

      <FieldBlock label="Suggested Summary" value={summary} onChange={setSummary} rows={2} />
      <FieldBlock label="Suggested Description" value={description} onChange={setDescription} rows={8} />
    </section>
  );
}
```

- [ ] **Step 3: Add the `openButtonStyle` constant** (button-flavored variant of the existing `openLinkStyle` — same look, but `cursor: pointer` and a reset `border` since `<button>` defaults differ from `<a>`). Find the existing `openLinkStyle` block (around line 209–218):

```ts
const openLinkStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'var(--mint-warning-bg-soft)',
  color: 'var(--mint-warning-fg-strong)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-pill)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 700,
  textDecoration: 'none',
};
```

Add the new constant immediately after it:

```ts
const openButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'var(--mint-warning-bg-soft)',
  color: 'var(--mint-warning-fg-strong)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-pill)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 700,
  cursor: 'pointer',
};
```

The original `openLinkStyle` stays in place — it's no longer referenced by I2cCard but leaving it doesn't cost anything and avoids touching neighboring code. (If a build warning fires about an unused const, delete it.)

- [ ] **Step 4: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 5: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 6: End-to-end test — happy path.**

  1. Open a WOCOO ticket where the I2cCard renders in the side panel.
  2. Confirm the header now shows **↗ Open & Fill Form** (button, not link).
  3. Click it.
  4. A new tab opens at `https://tracking.i2cinc.com/servicedesk/customer/portal/2/create/17`.
  5. Within ~1 second of the form rendering, both **Summary** and **Description** should be populated with the values from the side-panel textareas.
  6. Open DevTools on the form tab → Console → confirm `[wocoo-i2c-servicedesk]` log lines: `found pending draft`, `summary filled`, `description filled`, `done, signal cleared`.

- [ ] **Step 7: End-to-end test — edited values.**

  1. Edit the Suggested Summary textarea in the side panel before clicking the button.
  2. Click **↗ Open & Fill Form**.
  3. Confirm the destination form's Summary matches the edited text.

- [ ] **Step 8: Negative — unrelated visit.**

  1. In a fresh tab, navigate directly to `https://tracking.i2cinc.com/servicedesk/customer/portal/2/create/17` (without clicking the side-panel button).
  2. Confirm the form is empty — the content script does NOT auto-fill on standalone visits.
  3. Console should show no `[wocoo-i2c-servicedesk]` log lines because the storage key is absent.

- [ ] **Step 9: Negative — back/forward navigation.**

  1. After test 6, in the form tab use browser back then forward.
  2. Confirm the form does NOT re-fill — the storage key was cleared on first fill.

- [ ] **Step 10: Sanity — Copy buttons still work.**

  1. In the side panel's I2cCard, click the **Copy** button next to either textarea.
  2. Paste somewhere (e.g. a scratch text editor). Confirm the textarea text is on the clipboard.

- [ ] **Step 11: Regression — existing i2c login content script.**

  1. On a ticket with `ticket.clientEmail`, click **↗ i2c** from QuickActions.
  2. Confirm the existing `wealthsimplecs.mycardplace.com` login form still auto-fills with the configured email + password (the existing `src/content/i2c.ts` script — separate from the new one).

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - Side panel button swap (link → button with `pending_i2c_servicedesk_form` write) → Task 2 Step 2.
  - New content script with poll-fill-clear lifecycle → Task 1 Step 1.
  - Two-tiered Description fill (textarea-first then ProseMirror) → Task 1 Step 1 (`fillDescription`).
  - React-friendly setter pattern → Task 1 Step 1 (`setReactInputValue`).
  - Manifest `host_permissions` + `content_scripts` additions → Task 1 Steps 2 and 3.
  - One-shot storage key (cleared after fill-or-timeout) → Task 1 Step 1 (`main` always reaches `chrome.storage.local.remove(PENDING_KEY)` after the fill attempt; no-ops never reach it because they return early before fillForm is called — matching the spec's "Storage key only clears when the script reaches the fill-or-timeout decision point").
  - Copy buttons kept as fallback → Task 2 Step 2 (FieldBlock calls unchanged).
  - Manual verification covers happy path, edits, unrelated visit, back/forward, Copy fallback, and the existing-i2c-login regression → Task 2 Steps 6–11.
- **Placeholder scan:** No "TBD"/"TODO"/"implement later". All code blocks are complete; all manual steps name exact buttons and expected logs.
- **Type consistency:** `PendingDraft`, `PENDING_KEY = 'pending_i2c_servicedesk_form'`, the `{ summary, description }` shape — all consistent between Task 1's content script and Task 2's side-panel writer.
- **Scope:** One focused feature, three files (1 new + 2 modified), two tasks. Single plan is the right shape.
