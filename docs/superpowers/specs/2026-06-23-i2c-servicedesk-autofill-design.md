# i2c Service Desk Form Autofill

**Date**: 2026-06-23
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

The I2cCard in the side panel today builds a suggested Summary + Description from the WOCOO ticket and shows them in editable textareas with Copy buttons. To raise an i2c support ticket, the agent clicks the "Open i2c Form ↗" link to a JSM portal (`https://tracking.i2cinc.com/servicedesk/customer/portal/2/create/17`) and pastes both fields by hand. Two paste actions, easy to forget the description, slow.

The extension already has the data; the destination form has matching fields. Wire them up.

## Goals

- Clicking the existing "Open i2c Form" affordance auto-fills the destination form's Summary and Description with the current values from the side panel.
- Use the existing pattern: side panel writes a one-shot `pending_*` key to `chrome.storage.local`; a new content script on the destination domain reads it on page load, fills the form, then clears the key.
- Keep the Copy buttons on the textareas as a fallback — rich text editors are flaky, the agent should always have a manual paste path.
- One-shot semantics: a manual reload of the form page (without re-clicking the side-panel button) does NOT re-fill stale data.

## Non-Goals

- Auto-filling Problem Area, Priority, or Attachment fields. Those stay agent-driven.
- Auto-submitting the form. Agent reviews + clicks Create themselves.
- Authentication / login flow on `tracking.i2cinc.com`. Out of scope — if the agent isn't logged in, JSM handles the redirect; our content script just no-ops until the form is reachable.
- Filling forms on any other JSM portal (URL match is scoped to `tracking.i2cinc.com/servicedesk/customer/portal/*`).

## Side Panel Change

`src/sidepanel/MessagingCards.tsx`: in the `I2cCard` component header, replace the `<a href={I2C_FORM_URL}>` link with a `<button>` whose `onClick` handler:

1. Writes the current `summary` and `description` state to `chrome.storage.local` under key `pending_i2c_servicedesk_form`:
   ```ts
   await chrome.storage.local.set({
     pending_i2c_servicedesk_form: { summary, description },
   });
   ```
2. Opens the form URL in a new tab:
   ```ts
   window.open(I2C_FORM_URL, '_blank', 'noopener,noreferrer');
   ```

Visual styling stays the same (existing `openLinkStyle`). Label changes from `Open i2c Form ↗` to `↗ Open & Fill Form` to communicate the new behavior.

The Suggested Summary and Suggested Description textareas + their Copy buttons stay exactly as today — fallback if the autofill fails.

## Content Script — `src/content/i2cservicedesk.ts` (NEW)

Runs on `https://tracking.i2cinc.com/servicedesk/customer/portal/*` at `document_idle`. Lifecycle:

1. On load, read `pending_i2c_servicedesk_form` from `chrome.storage.local`. If absent or shape-invalid, return — no-op.
2. Poll for the Summary input AND the Description editor every 250ms for up to 3 seconds (JSM hydrates async).
3. Once both are found:
   - Fill Summary as a standard text input (React-friendly native setter + dispatch `input` event, same pattern as `src/content/i2c.ts`).
   - Fill Description via the two-tiered strategy below.
4. Clear `pending_i2c_servicedesk_form` from storage regardless of fill success — one-shot.
5. Log result to console (`[wocoo-i2c-servicedesk]` prefix, matching the existing content-script logging convention).

### Summary fill

Locate the Summary input by walking labels: find the visible label whose trimmed text is exactly `Summary` (case-insensitive), then find the nearest `<input>` inside the label's ancestor `<div>` cluster.

Set the value using the React-friendly pattern (so React's internal state syncs with the DOM):

```ts
function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
```

### Description fill (two-tiered)

The Description field is a rich-text editor in JSM. The screenshot shows Atlassian's Atlaskit Editor (ProseMirror-based). Two attempts in order:

**Tier 1 — Plain textarea**: If any JSM portals serve a plain `<textarea>` for description (some do), set it via `setReactInputValue` above.

**Tier 2 — ProseMirror contenteditable**: Find a `[contenteditable="true"]` element near the "Description" label. Focus, then:

```ts
editor.focus();
document.execCommand('insertText', false, description);
```

`document.execCommand('insertText', ...)` is deprecated but remains the most reliable cross-editor way to insert plain text that respects the editor's internal state model (ProseMirror, Slate, Lexical all handle it). Newlines collapse to soft breaks — acceptable for triage descriptions.

If neither tier produces a non-empty editor after 500ms, log a warning and bail. The agent has the Copy button as recourse.

## Manifest

`extension/manifest.json` — two additions:

1. Add to `host_permissions`:
   ```
   "https://tracking.i2cinc.com/*"
   ```

2. Add to `content_scripts`:
   ```json
   {
     "matches": ["https://tracking.i2cinc.com/servicedesk/customer/portal/*"],
     "js": ["src/content/i2cservicedesk.ts"],
     "run_at": "document_idle"
   }
   ```

## Data Flow

```
[agent in side panel]
        │ clicks "↗ Open & Fill Form"
        ▼
[MessagingCards.tsx]
   sets pending_i2c_servicedesk_form = {summary, description}
   window.open(I2C_FORM_URL)
        │
        ▼
[browser opens new tab @ tracking.i2cinc.com/servicedesk/.../create/17]
   page renders → document_idle fires
        │
        ▼
[i2cservicedesk.ts content script]
   reads pending_i2c_servicedesk_form
   polls 250ms × 12 (up to 3s) for Summary input + Description editor
   fills Summary (native setter + input/change events)
   fills Description (textarea path → ProseMirror path)
   clears pending_i2c_servicedesk_form (success OR timeout)
   logs result
        │
        ▼
[form pre-populated; agent reviews + clicks Create]
```

## Architecture

| Path | New? | Responsibility |
|---|---|---|
| `src/sidepanel/MessagingCards.tsx` | modify | Replace the `Open i2c Form` `<a>` link with a `<button>` whose `onClick` writes `pending_i2c_servicedesk_form` to storage then opens the URL. Keep the Copy buttons on the textareas. |
| `src/content/i2cservicedesk.ts` | **new** | Page-side autofill: read storage key, poll for fields, fill Summary (input) and Description (textarea-then-ProseMirror), clear the key, log result. |
| `extension/manifest.json` | modify | Add `tracking.i2cinc.com` to host_permissions; register the new content script entry. |

All other files unchanged.

## Reused machinery

- `chrome.storage.local` for the one-shot pending-fill signal — same pattern as `pending_preset_identity_id`, `pending_ledge_verify_*`, `pending_i2c_email`, etc.
- React-friendly native setter pattern from `src/content/i2c.ts`.
- Content-script `document_idle` registration + console logging convention.

## Error Handling

- **Storage key absent**: content script no-ops silently. Normal case for unrelated visits to the JSM portal.
- **Form fields not found within timeout** (3 seconds for fields, 500ms post-fill verification): clear the storage key and log a warning. Agent uses Copy buttons.
- **Summary fills but Description doesn't**: agent sees the partial-fill — Summary is right, Description is empty. They paste from the Copy button. Acceptable degraded state.
- **Login redirect**: the content script's match pattern includes `/servicedesk/customer/portal/*`, which covers the portal pages. If JSM redirects to a login page outside that path, the script doesn't run on the login page. After login, the agent is dropped at the form — script runs then, but the storage key is still present (we don't clear it on no-op). First proper form render fires the fill. Important: storage key only clears when the script reaches the fill-or-timeout decision point.

  Caveat: a long login delay could leave the storage key in place for multiple seconds. If the agent meanwhile clicks the side panel again and re-clicks "↗ Open & Fill Form" with different content, the storage key is overwritten — newer click wins. Acceptable.

- **Agent reopens the form via browser back/forward**: the storage key was cleared on first fill, so a back-navigation doesn't re-fill. Agent has to re-click the side-panel button. Correct behavior.

## Edge Cases

- **Empty summary or description**: side-panel button still fires; content script fills whatever's non-empty and leaves the other field blank. Acceptable — agent's choice.
- **Description contains literal HTML / markdown**: `execCommand('insertText', ...)` inserts as plain text. No accidental formatting injection.
- **JSM editor swapped to a different framework in the future**: tier 2 might break. Tier 1 falls back to direct value-set if a textarea ever appears. Worst case the script no-ops and the Copy buttons take over.
- **Multiple WOCOO sessions open simultaneously, each opens their own i2c form tab**: race on `pending_i2c_servicedesk_form` — the second click overwrites the first. Side-effect: the first newly-opened tab will fill with the SECOND ticket's content. Rare in practice (agents normally work one ticket at a time). Acceptable; mitigation would be a UUID-keyed bucket but YAGNI.

## Testing

Manual, no automated tests.

1. **Smoke — happy path**: On a WOCOO ticket where the I2cCard renders, click **↗ Open & Fill Form**. A new tab opens at `tracking.i2cinc.com/.../create/17`. Within ~1 second after the form renders, both Summary and Description should be populated with the values from the side-panel textareas.
2. **Smoke — edited values**: Edit the Suggested Summary in the side panel before clicking the button. Confirm the destination form's Summary matches the edited text (not the auto-generated initial value).
3. **Negative — unrelated visit**: Open `tracking.i2cinc.com/.../create/17` directly in a fresh tab (without clicking the side-panel button). Confirm the form is empty — the content script doesn't fire on its own.
4. **Negative — back/forward navigation**: After step 1, navigate back/forward in the form tab. Confirm the form does NOT re-fill (storage key was cleared on first fill).
5. **Sanity — Copy buttons still work**: Click the Copy button next to either textarea. Confirm clipboard contains the textarea text — fallback path unchanged.
6. **Regression — existing i2c login content script still works**: Click `↗ i2c` from QuickActions on a ticket. Confirm the existing `wealthsimplecs.mycardplace.com` login form still auto-fills (this is a different content script, but make sure the new manifest entries don't break the existing one).

## Out of Scope

- Auto-populating Problem Area or Priority. Agent picks manually.
- Auto-submitting the form.
- Authentication / sign-in flow on `tracking.i2cinc.com`.
- Filling forms on JSM portals other than `tracking.i2cinc.com/servicedesk/customer/portal/*`.
- Cross-tab key disambiguation (UUID per click) for the rare multi-ticket-open case.
