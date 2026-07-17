// Slack content script — drives app.slack.com to type + send a templated message with
// real @mention pills (no app/webhook attribution). Used today by the Mobile Cheque
// Validation tool; designed so future tools can reuse.
//
// Queue-driven, mirrors the Ledge pattern: side panel writes a job to
// chrome.storage.local; this script picks it up, runs the DOM chain, writes the result.

export {}; // module scope

const PENDING_KEY  = 'pending_slack_post';
const RESULT_KEY   = 'slack_post_result';
const PROGRESS_KEY = 'slack_post_in_progress';

interface PostJob {
  jobId: string;
  channelName: string;     // sidebar text to navigate to (channel or person name)
  mode: 'channel' | 'dm';  // dm just changes the sidebar target ("Slackbot" by default)
  text: string;            // full message body; "@Name" tokens trigger autocomplete
  mentions: string[];      // names to autocomplete as real mention pills
  autoSend?: boolean;      // when false, type message but DON'T click Send — leave it in
                           // the composer for the human to review and send manually
}
interface PostResult { jobId: string; ok: boolean; reason?: string }

function log(...args: unknown[]) { console.log('[wocoo-slack]', ...args); }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(pred: () => T | null | false, timeoutMs = 10_000, intervalMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v as T;
    await delay(intervalMs);
  }
  return null;
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

// ----- navigation -----

/** Click a sidebar item by visible text (matches both channels and DMs). */
async function navigateToSidebarItem(name: string): Promise<boolean> {
  const target = name.toLowerCase();
  const link = await waitFor(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"], [role="link"], a, button'));
    return candidates.find((el) => {
      if (!isVisible(el)) return false;
      const txt = (el.innerText || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return txt.includes(target) || aria.includes(target);
    }) || null;
  }, 10_000);
  if (!link) {
    log('navigateToSidebarItem: did not find', name);
    return false;
  }
  link.click();
  await delay(900);
  return true;
}

/** Fall-back navigation: open Slack's Cmd+K quick switcher, type the name,
 *  press Enter on the top result. Works for DMs that aren't currently visible
 *  in the sidebar (collapsed DM section, virtualized off-screen, etc.). */
async function navigateViaQuickSwitcher(name: string): Promise<boolean> {
  log('navigateViaQuickSwitcher: trying', name);
  const openEvent: KeyboardEventInit = {
    key: 'k',
    code: 'KeyK',
    keyCode: 75,
    which: 75,
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  };
  document.dispatchEvent(new KeyboardEvent('keydown', openEvent));
  document.body.dispatchEvent(new KeyboardEvent('keydown', openEvent));

  const input = await waitFor(() => {
    const selectors = [
      'input[data-qa="quick_switcher_input"]',
      'input[aria-label*="switch" i]',
      'input[aria-label*="Jump" i]',
      'input[placeholder*="Jump" i]',
      'input[placeholder*="Search" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }, 3_000);

  if (!input) {
    log('navigateViaQuickSwitcher: input not found');
    return false;
  }

  input.focus();
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, name);
  else input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));

  await delay(900);

  const enterOpts: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
  input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

  await delay(1200);
  log('navigateViaQuickSwitcher: done');
  return true;
}

// ----- composer driving -----

/** Find Slack's message composer (a contenteditable div). */
async function findComposer(): Promise<HTMLElement | null> {
  return await waitFor(() => {
    const candidates = [
      'div[role="textbox"][data-qa="message_input"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-message-input]',
      'div[contenteditable="true"][role="textbox"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.isContentEditable && isVisible(el)) return el;
    }
    return null;
  }, 10_000);
}

/** Insert text into Slack's Quill composer. We use the legacy `execCommand('insertText')`
 *  path because it fires native `input` events that Slack's @-autocomplete module listens
 *  for. Synthetic `beforeinput` events (created with `new InputEvent(...)`) are NOT
 *  trusted, so Quill inserts the text but the mention popup never opens. execCommand,
 *  while deprecated, still produces trusted events in Chromium. */
function dispatchTextInsert(el: HTMLElement, text: string) {
  el.focus();
  document.execCommand('insertText', false, text);
}

function pressKey(el: HTMLElement, key: string, opts: KeyboardEventInit = {}) {
  const init: KeyboardEventInit = { key, code: key === 'Enter' ? 'Enter' : key, bubbles: true, cancelable: true, ...opts };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** Insert a newline inside the composer. Synthetic Shift-Enter KeyboardEvents aren't
 *  trusted, so we fall back to execCommand which fires trusted input events. Slack's
 *  Quill editor treats `\n` in an `insertText` command as a soft break. */
function insertNewline(composer: HTMLElement) {
  composer.focus();
  if (!document.execCommand('insertLineBreak')) {
    document.execCommand('insertText', false, '\n');
  }
}

const POPUP_SELECTORS = [
  'div[data-qa="autocomplete-list"]',
  '[role="listbox"]',
  '.c-autocomplete__list',
];
function findMentionPopup(): HTMLElement | null {
  for (const s of POPUP_SELECTORS) {
    const el = document.querySelector<HTMLElement>(s);
    if (el && isVisible(el)) return el;
  }
  return null;
}

/** Type @<first chars of name>, wait for the autocomplete popup, click the matching
 *  option. Re-focuses the composer aggressively because clicking a popup option shifts
 *  the activeElement off the composer, which causes subsequent execCommand calls to
 *  insert nowhere (losing the next `@` trigger char). */
async function typeMention(composer: HTMLElement, name: string): Promise<boolean> {
  composer.focus();
  await delay(60);

  // Build a disambiguating prefix the way a human would: full first name plus the first
  // letter of the last name (e.g. `Jonathan Fawcett` → type `@Jonathan F`). For single-
  // token configs (e.g. `Estelle`, `adriana`), type the whole first name. This narrows
  // Slack's autocomplete popup enough that common first names (Jon, Amanda, etc.) resolve
  // to the right user instead of whoever ranks first.
  const parts = name.split(' ').filter(Boolean);
  const firstName = parts[0];
  const lastInitial = parts.length > 1 ? ' ' + parts[1][0] : '';
  const prefix = '@' + firstName + lastInitial;

  for (const ch of prefix) {
    composer.focus();
    document.execCommand('insertText', false, ch);
    await delay(90);
  }

  let popup = await waitFor(findMentionPopup, 6_000);

  // Retry with one more last-name char if Slack hasn't surfaced the popup yet
  // (e.g. typing `@Jonathan F` failed → try `@Jonathan Fa`).
  if (!popup && parts.length > 1 && parts[1].length > 1) {
    composer.focus();
    document.execCommand('insertText', false, parts[1][1]);
    await delay(90);
    popup = await waitFor(findMentionPopup, 4_000);
  }

  if (!popup) {
    log('typeMention: no autocomplete popup for', name);
    return false;
  }

  // Tight selector — match only real option rows. The earlier `button, li` fallback
  // could match unrelated DOM nodes inside the popup container.
  const lower = name.toLowerCase();
  const options = Array.from(popup.querySelectorAll<HTMLElement>(
    '[role="option"], [data-qa="mentioned_user_option"]',
  )).filter((el) => isVisible(el));

  const nameMatch = options.find((o) => (o.innerText || '').toLowerCase().startsWith(lower));
  const selected = options.find((o) => o.getAttribute('aria-selected') === 'true');
  const target = nameMatch || selected || options[0] || null;

  if (!target) {
    log('typeMention: popup open but no option found for', name);
    return false;
  }
  target.click();

  // Wait for the popup to actually disappear — clicking the option triggers the pill
  // replacement asynchronously, and until it's done focus is on the popup item, not
  // the composer. Bounded at 1.2s in case the popup hangs.
  await waitFor(() => (findMentionPopup() === null ? true : null), 1_200, 80);

  // Re-claim composer focus before the trailing space, otherwise execCommand may insert
  // into the wrong target (or no-op).
  composer.focus();
  await delay(80);
  document.execCommand('insertText', false, ' ');
  return true;
}

/** Walk the job's `text`, inserting plain text and triggering autocomplete mentions
 *  whenever an "@Name" from `job.mentions` appears. Newlines are typed as Shift-Enter. */
async function typeMessage(composer: HTMLElement, job: PostJob): Promise<void> {
  const tokens = job.mentions.map((n) => ({ tok: '@' + n, name: n }));
  let remaining = job.text;
  while (remaining.length > 0) {
    let firstIdx = -1;
    let firstTok: { tok: string; name: string } | null = null;
    for (const t of tokens) {
      const i = remaining.indexOf(t.tok);
      if (i !== -1 && (firstIdx === -1 || i < firstIdx)) { firstIdx = i; firstTok = t; }
    }
    const plainEnd = firstIdx === -1 ? remaining.length : firstIdx;
    const plain = remaining.slice(0, plainEnd);
    if (plain) {
      const lines = plain.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) dispatchTextInsert(composer, lines[i]);
        if (i < lines.length - 1) insertNewline(composer);
      }
    }
    if (!firstTok) break;
    await typeMention(composer, firstTok.name);
    remaining = remaining.slice(firstIdx + firstTok.tok.length);
  }
}

/** Find and click Slack's Send button. */
async function clickSend(): Promise<boolean> {
  const btn = await waitFor(() => {
    const sels = [
      'button[data-qa="texty_send_button"]',
      'button[aria-label*="Send"]',
      'button[data-qa="message_send_button"]',
    ];
    for (const s of sels) {
      const el = document.querySelector<HTMLElement>(s);
      if (el && isVisible(el) && !(el as HTMLButtonElement).disabled) return el;
    }
    return null;
  }, 5_000);
  if (!btn) return false;
  btn.click();
  return true;
}

// ----- job loop -----

async function processJob(job: PostJob): Promise<PostResult> {
  log('processJob', job);
  try {
    const target = job.mode === 'dm' && job.channelName.toLowerCase() === 'self' ? 'Slackbot' : job.channelName;
    let navigated = await navigateToSidebarItem(target);
    if (!navigated) {
      // Target may not be visible in the rendered sidebar (collapsed section,
      // virtualized off-screen, channel not pinned). Fall back to Cmd+K quick
      // switcher — works for channels and DMs alike.
      navigated = await navigateViaQuickSwitcher(target);
    }
    if (!navigated) return { jobId: job.jobId, ok: false, reason: `Could not navigate to "${target}"` };
    const composer = await findComposer();
    if (!composer) return { jobId: job.jobId, ok: false, reason: 'Composer not found' };
    composer.focus();
    await typeMessage(composer, job);
    await delay(400);
    // autoSend === false → message stays in the composer for the human to review and click
    // Send themselves. Used for the MCV channel post so the agent can verify the rendered
    // mention pills and copy before anything goes out to the team.
    if (job.autoSend === false) {
      return { jobId: job.jobId, ok: true, reason: 'message typed; review in Slack tab and click Send' };
    }
    const sent = await clickSend();
    if (!sent) return { jobId: job.jobId, ok: false, reason: 'Send button not found / disabled' };
    return { jobId: job.jobId, ok: true };
  } catch (e: any) {
    return { jobId: job.jobId, ok: false, reason: e?.message || String(e) };
  }
}

async function pickUpAndProcess(): Promise<void> {
  try {
    const res = await chrome.storage.local.get([PENDING_KEY, PROGRESS_KEY]);
    if (res[PROGRESS_KEY]) return;
    const job = res[PENDING_KEY] as PostJob | undefined;
    if (!job || !job.jobId) return;
    await chrome.storage.local.set({ [PROGRESS_KEY]: job.jobId });
    await chrome.storage.local.remove([PENDING_KEY]);
    const result = await processJob(job);
    log('result', result);
    await chrome.storage.local.set({ [RESULT_KEY]: result });
    await chrome.storage.local.remove([PROGRESS_KEY]);
  } catch (e: any) {
    if (e?.message?.includes('Extension context invalidated')) {
      log('Extension reloaded — close + reopen this tab to re-attach.');
      return;
    }
    log('pickUpAndProcess error:', e?.message || e);
  }
}

async function bootstrap() {
  log('Slack content script loaded on', location.href);
  // Clear any stale in-progress marker from a previous session.
  try { await chrome.storage.local.remove([PROGRESS_KEY]); } catch { /* fine */ }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (PENDING_KEY in changes) void pickUpAndProcess();
  });
  await delay(500);
  void pickUpAndProcess();
}

void bootstrap();
