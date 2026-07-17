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
