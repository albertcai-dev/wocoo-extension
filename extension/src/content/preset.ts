export {}; // Treat as module → file-scoped declarations, no collision with i2c.ts.

import {
  clearStagedPresetIdentity,
  readPresetIdentity,
  type ResolvedPresetIdentity,
} from '../data/presetIdentity';

console.log('[wocoo-preset] content script loaded on', location.href);

// Content script for Preset (Superset SaaS) dashboards.
// Chain:
//   1. Clear the existing Identity Canonical ID filter chip(s)
//   2. Type the ticket's identity ID into the filter
//   3. Pick the matching option from the autocomplete dropdown
//   4. Click "Apply Filters"
//   5. Click the "Activity" tab, if this dashboard has one
//
// Which identity gets typed comes from data/presetIdentity: the identity a workflow
// button staged for this tab, or else the ticket the side panel currently has open.
//
// Preset uses Ant Design components under the hood, so selectors target Ant Design class
// names (.ant-select-selection-item, .ant-tabs-tab, etc.). If a selector misses, the
// content script falls back to text-based matching where possible.

async function loadPending(): Promise<ResolvedPresetIdentity | null> {
  try {
    return await readPresetIdentity();
  } catch { return null; }
}

async function clearPending() {
  try { await clearStagedPresetIdentity(); } catch { /* fine */ }
}

function log(msg: string, ...args: unknown[]) {
  // Prefix everything so it's easy to spot in console while iterating on selectors.
  console.log('[wocoo-preset]', msg, ...args);
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function isVisible(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ----- step 1: clear existing identity chip -----

function findIdentityChips(): HTMLElement[] {
  // Regular chips — visible identities, textContent starts with `identity-` / `identity_`.
  const regular = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-selection-item'))
    .filter((c) => /^identity[-_]/i.test((c.textContent || '').trim()));
  // Overflow chips — Ant renders `+ N ...` as `.ant-select-selection-overflow-item-rest`
  // when the chip strip is too narrow to show every selected value. Its text doesn't
  // contain the identity string but it still represents identities we need to clear.
  const overflow = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-selection-overflow-item-rest'))
    .filter(isVisible);
  return [...regular, ...overflow];
}

function fireFullClick(target: Element) {
  // Ant Design's chip × responds to mousedown more reliably than click — some Select
  // implementations close-and-prevent-default in the mousedown handler.
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  // SVGElement.click() doesn't exist in all browsers — fall back to a dispatched event.
  if (typeof (target as HTMLElement).click === 'function') {
    (target as HTMLElement).click();
  } else {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  }
}

/** Strategy 0: click the native-filter-bar "Clear All" button. This is Preset's own
 *  first-class "reset all filters" control — much more reliable than trying to nuke
 *  chips one by one, especially when Preset has rehydrated a saved state via
 *  `native_filters_key` and the chip is rendered in an overflow "+ N" form that the
 *  per-chip × selector can't target. */
async function clickClearAll(): Promise<boolean> {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, a, span[role="button"], [role="button"]'));
  const target = candidates.find((el) => {
    if (!isVisible(el)) return false;
    const txt = (el.textContent || '').trim();
    if (!/^clear\s*all$/i.test(txt)) return false;
    // Constrain to the native-filter bar area — otherwise we might click a chart-level
    // "Clear all" (e.g. an alert dismiss button). We check the closest ancestor for
    // any of Preset's filter-bar class fragments.
    const inFilterBar = !!el.closest('[class*="filter-bar" i], [class*="FilterBar" i], [class*="native-filters" i], [class*="NativeFilters" i]');
    return inFilterBar;
  });
  if (!target) return false;
  log('  → clicking "Clear All" in filter bar');
  fireFullClick(target);
  await sleep(400);
  return true;
}

async function clearIdentityChips(): Promise<boolean> {
  const chipsBefore = findIdentityChips();
  log('clearIdentityChips: found', chipsBefore.length, 'identity chip(s)');
  if (chipsBefore.length === 0) return true;

  // Run up to 4 rounds of clearing. Each round tries every strategy in order and exits
  // early the moment `findIdentityChips().length === 0`. Total budget ~4s per call.
  for (let round = 1; round <= 4; round++) {
    // Strategy 0: Preset's native "Clear All" button (added — the previous "Deselect all"
    // strategy only worked when the DROPDOWN was open, which is a different control).
    if (await clickClearAll()) {
      if (findIdentityChips().length === 0) return true;
    }

    // Open the dropdown — "Deselect all" is only rendered while the dropdown is open, and
    // Ant Select sometimes requires the listener-bound combobox to be focused before
    // chip-remove clicks land.
    const input = findFilterInput();
    if (input) {
      input.click();
      input.focus();
      await sleep(200);
    }

    // Strategy 1: "Deselect all" — single click that nukes every selected value at once.
    const deselectAll = Array.from(document.querySelectorAll<HTMLElement>('a, button, span, div'))
      .find((el) => /^Deselect\s+all/i.test((el.textContent || '').trim()) && isVisible(el));
    if (deselectAll) {
      log('  → clicking "Deselect all"');
      fireFullClick(deselectAll);
      await sleep(300);
      if (findIdentityChips().length === 0) return true;
    }

    // Strategy 2: per-chip × button.
    for (const chip of findIdentityChips()) {
      const removeBtn = chip.querySelector<HTMLElement>(
        '.ant-select-selection-item-remove, [aria-label*="close" i], [aria-label*="remove" i]'
      );
      if (removeBtn) {
        log('  → clicking × on', chip.textContent?.trim());
        fireFullClick(removeBtn);
        await sleep(200);
      }
    }
    if (findIdentityChips().length === 0) return true;

    // Strategy 3: focus the search input + send Backspace. Ant Select multi-select pops
    // the last selected tag when Backspace fires on an empty search input. Loop up to
    // 20 times so we drain overflow chips ("+ N …" rest indicators) as well as visible
    // ones.
    if (input) {
      log('  → trying Backspace key on search input (round', round + ')');
      input.focus();
      setValue(input, '');
      let attempts = 0;
      while (findIdentityChips().length > 0 && attempts < 20) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true }));
        await sleep(120);
        attempts++;
      }
    }
    if (findIdentityChips().length === 0) return true;
  }

  return findIdentityChips().length === 0;
}

// ----- step 2: type identity into filter input -----

function findFilterInput(): HTMLInputElement | null {
  // The Identity Canonical ID filter panel has an Ant Select with a search input. We
  // look for an input whose nearest preceding "Identity Canonical ID" label exists.
  const labels = Array.from(document.querySelectorAll<HTMLElement>('label, div, span'));
  for (const l of labels) {
    const t = (l.textContent || '').trim();
    if (!/^(Identity\s+Canonical\s+ID|identity_canonical_id|identity_id)\b/i.test(t)) continue;
    // Walk forward through siblings + ancestors looking for the search input
    const ancestor = l.closest('[class*="FilterControl"], [class*="filter"], form, div');
    const input = (ancestor || l.parentElement)?.querySelector<HTMLInputElement>('input.ant-select-selection-search-input, input[type="search"], input[type="text"]');
    if (input && isVisible(input)) return input;
  }
  // Fallback: any visible Ant Select search input on the page
  const any = Array.from(document.querySelectorAll<HTMLInputElement>('input.ant-select-selection-search-input'))
    .find((i) => isVisible(i));
  return any || null;
}

function fireEnter(target: EventTarget) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function fireEnterEverywhere(input: HTMLInputElement) {
  // Send Enter at every level Ant Select / Superset might be listening: the input itself,
  // the combobox parent (Ant Design wraps the input in role=combobox), and document
  // (React's synthetic event system is rooted there).
  fireEnter(input);
  const combobox = input.closest('[role="combobox"], .ant-select-selector, .ant-select');
  if (combobox && combobox !== input) {
    log('  → also firing Enter on combobox parent:', combobox.tagName, String((combobox as HTMLElement).className).split(' ')[0]);
    fireEnter(combobox);
  }
  fireEnter(document);
}

async function typeIdentity(identity: string): Promise<boolean> {
  const input = findFilterInput();
  if (!input) { log('no filter input found'); return false; }

  log('using filter input:', input.tagName, 'class=', input.className, 'id=', input.id || '(none)');

  // Open the dropdown / focus the field
  input.click();
  await sleep(150);
  input.focus();
  await sleep(50);

  // Clear any leftover search text via setValue only — don't fire deleteContentBackward,
  // since Ant Select interprets backspace-on-empty as "remove the last chip" and could
  // strip a chip from a prior pass.
  setValue(input, '');
  await sleep(50);

  // Char-by-char typing: pasting is faster but the dropdown's pre-highlighted "first
  // option" doesn't get cleared in time, so Enter selects that option instead of
  // committing the typed value as a tag. Typing one char at a time forces the dropdown
  // to filter all the way to "No Data" before Enter, so Enter then commits the typed
  // string as a custom tag.
  log('  → typing char-by-char:', identity);
  for (let i = 0; i < identity.length; i++) {
    const ch = identity[i];
    const partial = identity.substring(0, i + 1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    setValue(input, partial);
    input.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(15);
  }

  // Settle before Enter so the dropdown reflects the final search state ("No Data").
  await sleep(400);
  input.focus();

  log('pressing Enter (input + combobox + document) to commit', identity);
  fireEnterEverywhere(input);
  return true;
}

function hasMatchingChip(identity: string): boolean {
  const chips = findIdentityChips();
  for (const c of chips) {
    const raw = (c.textContent || '').trim();
    // Strip trailing whitespace + ellipsis (… or ...) + × + any other non-identity chars.
    const stripped = raw
      .replace(/\s+$/, '')
      .replace(/×+$/, '')
      .replace(/\s+$/, '')
      .replace(/(?:…|\.{1,})$/, '')
      .replace(/\s+$/, '');
    log('checking chip:', JSON.stringify(raw), '→ stripped:', JSON.stringify(stripped), 'vs identity:', JSON.stringify(identity));
    if (!stripped) continue;
    if (stripped === identity) return true;
    if (stripped.length >= 8 && identity.startsWith(stripped)) return true;
  }
  return false;
}

// ----- step 3: click the matching option in the open dropdown -----

async function selectMatchingOption(identity: string): Promise<boolean> {
  // Ant Design renders dropdown items as .ant-select-item-option, often inside a portal
  // mounted to body. Match exact text or prefix.
  const items = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option, [role="option"]'));
  for (const item of items) {
    const t = (item.textContent || '').trim();
    if (t === identity || t.startsWith(identity)) {
      log('clicking option', t);
      item.click();
      return true;
    }
  }
  return false;
}

// ----- step 4: click Apply Filters -----

async function clickApplyFilters(): Promise<boolean> {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
  for (const b of buttons) {
    const t = (b.textContent || '').trim();
    if (/^Apply\s*(Filters?)?$/i.test(t) && isVisible(b)) {
      log('clicking Apply', t);
      b.click();
      return true;
    }
  }
  return false;
}

// ----- step 5: click Activity tab -----

async function clickActivityTab(): Promise<boolean> {
  // Superset dashboard tabs use Ant Design tabs (.ant-tabs-tab) or sometimes a role=tab.
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('.ant-tabs-tab, [role="tab"], a, div'));
  for (const tab of tabs) {
    const t = (tab.textContent || '').trim();
    if (/^Activity$/i.test(t) && isVisible(tab)) {
      log('clicking Activity tab', t);
      tab.click();
      return true;
    }
  }
  return false;
}

// ----- orchestrator -----

type ChainStep = 'init' | 'cleared' | 'typed' | 'selected' | 'applied' | 'done' | 'error';
let chainStep: ChainStep = 'init';
let chainIdentity: string | null = null;
let clearAttempts = 0;
let typeAttempts = 0;
let activityAttempts = 0;

async function tick() {
  if (chainStep === 'done' || chainStep === 'error') return;
  if (!chainIdentity) {
    const resolved = await loadPending();
    if (!resolved) return;
    chainIdentity = resolved.identityId;
    log('chain start, identity =', chainIdentity,
        '(source =', resolved.source, ', ticket =', resolved.ticketKey || 'unknown', ')');
  }
  const id = chainIdentity;
  switch (chainStep) {
    case 'init': {
      const chips = findIdentityChips();
      if (chips.length === 0) {
        // No chip — wait for the dashboard to render the filter UI before advancing.
        const haveFilterUi = !!document.querySelector('.ant-select-selection-item, input.ant-select-selection-search-input, input[type="search"]');
        if (haveFilterUi) {
          await sleep(250);
          chainStep = 'cleared';
          log('step → cleared (no chip to remove)');
        } else {
          log('init: filter UI not ready yet');
        }
        break;
      }
      const cleared = await clearIdentityChips();
      clearAttempts++;
      if (cleared) {
        await sleep(300);
        chainStep = 'cleared';
        log('step → cleared');
      } else if (clearAttempts >= 10) {
        // Hard fail — if 10 rounds of every clear strategy still leave a chip on the
        // dashboard, typing the new identity would just ADD to the multi-select and end
        // up with two chips (or the popup toggling off the wrong one). Enter a terminal
        // error state so tick() stops spinning; the user has a visible stale-chip cue
        // and can retry.
        log('clear failed after 10 attempts — aborting chain');
        chainStep = 'error';
      } else {
        log('clear failed (attempt', clearAttempts, '/ 10) — retrying next tick');
      }
      break;
    }
    case 'cleared': {
      // If a chip was somehow added before we got here (e.g. dropdown autoselect),
      // skip typing entirely. Retyping the same identity can deselect an existing chip
      // because the dropdown highlights the matching option and Enter toggles selection.
      if (findIdentityChips().length > 0) {
        log('chip already present — skipping typeIdentity');
        chainStep = 'typed';
        break;
      }
      const typed = await typeIdentity(id);
      if (!typed) return;
      typeAttempts++;
      chainStep = 'typed';
      log('step → typed (attempt', typeAttempts, ')');
      break;
    }
    case 'typed': {
      // Poll briefly for the chip to render. ALWAYS advance after this — retrying the
      // type step can deselect the chip we just added (Enter on a highlighted-selected
      // option toggles it off). Trust that typing worked; Apply will surface failures.
      for (let i = 0; i < 8; i++) {
        if (findIdentityChips().length > 0) {
          log('step → selected (chip detected after', i * 200, 'ms)');
          break;
        }
        await sleep(200);
      }
      if (findIdentityChips().length === 0) {
        log('warning: no chip detected after polling — advancing anyway');
      }
      chainStep = 'selected';
      break;
    }
    case 'selected': {
      const applied = await clickApplyFilters();
      if (!applied) return;
      // Consume the staged identity here rather than after the Activity tab: plenty of
      // dashboards have no Activity tab, and gating the cleanup on that click left the
      // stage behind on every such run. The next Preset page then autofilled a long-dead
      // ticket's identity. The filter is already committed at this point, so nothing
      // downstream needs the staged value.
      await clearPending();
      // Don't wait for chart refresh — clicking Activity is independent of chart load.
      await sleep(300);
      chainStep = 'applied';
      log('step → applied (staged identity consumed)');
      break;
    }
    case 'applied': {
      const tabbed = await clickActivityTab();
      if (!tabbed) {
        // No Activity tab on this dashboard — the filter is applied, so the chain is
        // done. Returning here instead would spin until bootstrap's deadline.
        activityAttempts++;
        if (activityAttempts < 5) return;
        log('no Activity tab found after', activityAttempts, 'attempts — chain complete without it');
        chainStep = 'done';
        break;
      }
      chainStep = 'done';
      log('chain complete');
      break;
    }
  }
}

async function bootstrap() {
  // Preset is an SPA; the filter panel often appears a few hundred ms after first paint.
  // Poll for up to ~30s, then give up.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && chainStep !== 'done') {
    try { await tick(); } catch (e) { log('tick error', e); }
    await sleep(300);
  }
}

bootstrap();
