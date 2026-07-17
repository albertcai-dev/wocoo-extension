# Mobile Cheque Validation Implementation Plan

**Goal:** Build the Mobile Cheque Validation Tools tile end-to-end (Phases A–C).

**Architecture:** Hybrid — Apps Script bridge does Gmail email lookup, CSV parse, Sheet paste, totals read. Extension does Home tile, modal, and Slack post via slack.com content script.

**Tech Stack:** Apps Script (existing v3 bridge project), TypeScript / React side panel, Chrome MV3 content scripts.

---

## Phase A — Manual MVP

### Task A1: Apps Script — config block

**Files:** Apps Script (paste-and-redeploy; new top-level constants near the existing `ERRORS_SHEET_ID` etc.).

Add these constants (Albert fills in TBD cells during testing):

```js
// ====== Mobile Cheque Validation config ======
var MCV_TRACKER_SHEET_ID = 'TBD_TRACKER_SHEET_ID';
var MCV_MAIN_SHEET_TAB = 'Main';                      // adjust if different
var MCV_VALIDATION_SHEET_TAB = 'Validation Sheet';    // adjust if different
var MCV_DAY1_REJECTS_TAB = 'RBC | Mobile Cheque Returns (Day 1 Rejects)';
// A1-notation cells on the Main Sheet that hold each summary value:
var MCV_CELLS = {
  receivedCount:    'B2',  // TBD
  processedCount:   'B3',  // TBD
  day1Reversed:     'B4',  // TBD
  opsSlaBreach:     'B5',  // TBD
  riskSlaBreach:    'B6',  // TBD
};
// P/Q error scan range (yesterday's row block):
var MCV_PQ_ERROR_RANGE = 'P10:Q1000'; // TBD — scope to the yesterday rows
// Validation Sheet paste target (top-left):
var MCV_VALIDATION_PASTE_CELL = 'A1';
// Preset email search:
var MCV_PRESET_SUBJECT_PREFIX = 'Mobile Cheque Validation';
```

- [ ] Step 1: Paste the block above into the bridge project.
- [ ] Step 2: Run a one-off `function _testTrackerOpens() { var ss = SpreadsheetApp.openById(MCV_TRACKER_SHEET_ID); Logger.log(ss.getName()); }` from the Apps Script editor to confirm `MCV_TRACKER_SHEET_ID` resolves.
- [ ] Step 3: Inspect the live Main Sheet, find the five summary cells, update `MCV_CELLS`.
- [ ] Step 4: Confirm the Validation Sheet tab name + paste cell are right.

### Task A2: Apps Script — `runMobileChequeValidation_()`

```js
function runMobileChequeValidation_() {
  // 1. Determine target date (yesterday).
  var tz = Session.getScriptTimeZone() || 'America/Toronto';
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateKey = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');

  // 2. Find latest Preset email.
  var query = 'subject:"' + MCV_PRESET_SUBJECT_PREFIX + '" newer_than:1d';
  var threads = GmailApp.search(query, 0, 5);
  if (!threads.length) throw new Error('No Preset email found in last 24h matching: ' + query);
  var msg = threads[0].getMessages().pop(); // latest message
  var attachments = msg.getAttachments();
  var csvBlob = null;
  for (var i = 0; i < attachments.length; i++) {
    if (/\.csv$/i.test(attachments[i].getName())) { csvBlob = attachments[i]; break; }
  }
  if (!csvBlob) throw new Error('Preset email has no CSV attachment.');

  // 3. Paste into Validation Sheet.
  var csvData = Utilities.parseCsv(csvBlob.getDataAsString());
  var ss = SpreadsheetApp.openById(MCV_TRACKER_SHEET_ID);
  var vsheet = ss.getSheetByName(MCV_VALIDATION_SHEET_TAB);
  if (!vsheet) throw new Error('Validation Sheet tab not found.');
  vsheet.clear();
  if (csvData.length > 0 && csvData[0].length > 0) {
    vsheet.getRange(1, 1, csvData.length, csvData[0].length).setValues(csvData);
  }
  SpreadsheetApp.flush();
  Utilities.sleep(1500); // let Main Sheet formulas recompute

  // 4. Read totals from Main Sheet.
  var msheet = ss.getSheetByName(MCV_MAIN_SHEET_TAB);
  var totals = {
    receivedCount:  Number(msheet.getRange(MCV_CELLS.receivedCount).getDisplayValue())  || 0,
    processedCount: Number(msheet.getRange(MCV_CELLS.processedCount).getDisplayValue()) || 0,
    day1Reversed:   Number(msheet.getRange(MCV_CELLS.day1Reversed).getDisplayValue())   || 0,
    opsSlaBreach:   Number(msheet.getRange(MCV_CELLS.opsSlaBreach).getDisplayValue())   || 0,
    riskSlaBreach:  Number(msheet.getRange(MCV_CELLS.riskSlaBreach).getDisplayValue())  || 0,
  };

  // 5. Anomaly checks.
  var anomalies = [];
  if (totals.receivedCount !== totals.processedCount) {
    anomalies.push({ kind: 'count_mismatch', detail: totals.receivedCount + ' received / ' + totals.processedCount + ' processed' });
  }
  var pqRange = msheet.getRange(MCV_PQ_ERROR_RANGE).getValues();
  var pqErrorRows = [];
  for (var r = 0; r < pqRange.length; r++) {
    for (var c = 0; c < pqRange[r].length; c++) {
      var v = String(pqRange[r][c] || '');
      if (/^#(N\/A|REF!|VALUE!|ERROR!|NAME\?|NUM!|DIV\/0!)$/i.test(v)) {
        pqErrorRows.push(r + 1);
        break;
      }
    }
  }
  if (pqErrorRows.length) {
    anomalies.push({ kind: 'pq_errors', detail: pqErrorRows.length + ' rows with errors (first few: ' + pqErrorRows.slice(0, 5).join(', ') + ')' });
  }
  // Day 1 check: for each yesterday-dated row in the rejects tab, look up its funding_intent_id in csvData.
  var day1sheet = ss.getSheetByName(MCV_DAY1_REJECTS_TAB);
  if (day1sheet) {
    // Day 1 schema TBD: assume col B is date, col D is funding_intent_id (refine during implementation).
    var d1values = day1sheet.getRange(2, 1, day1sheet.getLastRow() - 1, day1sheet.getLastColumn()).getDisplayValues();
    var notReversed = [];
    var csvFundingCol = csvData[0].indexOf('funding_intent');
    var csvStateCol = csvData[0].indexOf('cheque_status');
    for (var dr = 0; dr < d1values.length; dr++) {
      var rowDateStr = String(d1values[dr][1] || '');
      var fid = String(d1values[dr][3] || '');
      if (!fid) continue;
      // Match by date (yesterday).
      var rowDate = new Date(rowDateStr);
      if (isNaN(rowDate.getTime())) continue;
      var rowDateKey = Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd');
      if (rowDateKey !== dateKey) continue;
      // Find in csvData.
      var matched = false;
      for (var ci = 1; ci < csvData.length; ci++) {
        if (csvData[ci][csvFundingCol] === fid) {
          var state = String(csvData[ci][csvStateCol] || '').toLowerCase();
          if (state === 'reversed') matched = true;
          break;
        }
      }
      if (!matched) notReversed.push(fid);
    }
    if (notReversed.length) {
      anomalies.push({ kind: 'day1_not_reversed', detail: notReversed.length + ' Day 1 entries not Reversed: ' + notReversed.slice(0, 3).join(', ') });
    }
  }

  var status = anomalies.length ? 'anomaly' : 'ready';
  var record = { date: dateKey, status: status, totals: totals, anomalies: anomalies, computedAt: new Date().toISOString(), sentAt: null };

  // 6. Persist.
  PropertiesService.getScriptProperties().setProperty('MCV_RECORD_' + dateKey, JSON.stringify(record));
  return record;
}
```

- [ ] Step 1: Paste the function into the bridge project.
- [ ] Step 2: Run it once from the Apps Script editor (auth grants if prompted). Confirm it returns a record without throwing.
- [ ] Step 3: Inspect Logger output (`View → Logs`) to verify totals and anomalies arrays look right.

### Task A3: Apps Script — bridge action handlers

```js
function _handleRunMobileChequeValidationFromGet_(e) {
  var ALLOW = HtmlService.XFrameOptionsMode.ALLOWALL;
  function postScript(msg) {
    var json = JSON.stringify(msg);
    return '<script>try{window.top.postMessage(' + json + ', "*");}catch(e){}' +
      'try{window.parent.postMessage(' + json + ', "*");}catch(e){}</script>';
  }
  try {
    var record = runMobileChequeValidation_();
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#16a34a;">✓ Validation run complete</p>' +
      postScript({ action: 'mobileChequeValidationRun', record: record }) +
      '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#991b1b;">Validation failed: ' + msg.replace(/</g, '&lt;') + '</p>' +
      postScript({ action: 'mobileChequeValidationRun', error: msg }) +
      '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  }
}

function _handleGetMobileChequeValidationStatusFromGet_(e) {
  var ALLOW = HtmlService.XFrameOptionsMode.ALLOWALL;
  function postScript(msg) {
    var json = JSON.stringify(msg);
    return '<script>try{window.top.postMessage(' + json + ', "*");}catch(e){}' +
      'try{window.parent.postMessage(' + json + ', "*");}catch(e){}</script>';
  }
  try {
    var tz = Session.getScriptTimeZone() || 'America/Toronto';
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var dateKey = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');
    var raw = PropertiesService.getScriptProperties().getProperty('MCV_RECORD_' + dateKey);
    var record = raw ? JSON.parse(raw) : null;
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#16a34a;">✓ Status: ' + (record ? record.status : 'none') + '</p>' +
      postScript({ action: 'mobileChequeValidationStatus', dateKey: dateKey, record: record }) +
      '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#991b1b;">Status fetch failed: ' + msg.replace(/</g, '&lt;') + '</p>' +
      postScript({ action: 'mobileChequeValidationStatus', error: msg }) +
      '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  }
}

function _handleMarkMobileChequeValidationSentFromGet_(e) {
  var ALLOW = HtmlService.XFrameOptionsMode.ALLOWALL;
  function postScript(msg) {
    var json = JSON.stringify(msg);
    return '<script>try{window.top.postMessage(' + json + ', "*");}catch(e){}' +
      'try{window.parent.postMessage(' + json + ', "*");}catch(e){}</script>';
  }
  try {
    var dateKey = (e.parameter.dateKey || '').trim();
    if (!dateKey) throw new Error('Missing dateKey');
    var raw = PropertiesService.getScriptProperties().getProperty('MCV_RECORD_' + dateKey);
    if (!raw) throw new Error('No record for ' + dateKey);
    var record = JSON.parse(raw);
    record.sentAt = new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('MCV_RECORD_' + dateKey, JSON.stringify(record));
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#16a34a;">✓ Marked sent</p>' +
      postScript({ action: 'mobileChequeValidationMarkSent', dateKey: dateKey }) +
      '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#991b1b;">Mark sent failed: ' + msg.replace(/</g, '&lt;') + '</p>' +
      postScript({ action: 'mobileChequeValidationMarkSent', error: msg }) +
      '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  }
}
```

Add the three `if` branches in `doGet(e)`:
```js
if (e && e.parameter && e.parameter.action === 'runMobileChequeValidation') {
  return _handleRunMobileChequeValidationFromGet_(e);
}
if (e && e.parameter && e.parameter.action === 'getMobileChequeValidationStatus') {
  return _handleGetMobileChequeValidationStatusFromGet_(e);
}
if (e && e.parameter && e.parameter.action === 'markMobileChequeValidationSent') {
  return _handleMarkMobileChequeValidationSentFromGet_(e);
}
```

- [ ] Step 1: Paste handlers + dispatch branches.
- [ ] Step 2: Deploy → Manage deployments → Edit → **New version** → Deploy.
- [ ] Step 3: Smoke test in browser tab: `<BRIDGE_URL>?action=runMobileChequeValidation` should return a green "✓ Validation run complete" page.

### Task A4: Extension — bridge.ts additions

```ts
export interface MCVTotals {
  receivedCount: number; processedCount: number; day1Reversed: number;
  opsSlaBreach: number; riskSlaBreach: number;
}
export interface MCVAnomaly { kind: string; detail: string; }
export interface MCVRecord {
  date: string; status: 'ready' | 'anomaly';
  totals: MCVTotals; anomalies: MCVAnomaly[];
  computedAt: string; sentAt: string | null;
}

export async function runMobileChequeValidationViaBridge(): Promise<MCVRecord> {
  const res = await callBridge('runMobileChequeValidation', {}, 'mobileChequeValidationRun');
  return res.record as unknown as MCVRecord;
}
export async function getMobileChequeValidationStatusViaBridge(): Promise<{ dateKey: string; record: MCVRecord | null }> {
  const res = await callBridge('getMobileChequeValidationStatus', {}, 'mobileChequeValidationStatus');
  return { dateKey: String(res.dateKey || ''), record: (res.record as MCVRecord | null) ?? null };
}
export async function markMobileChequeValidationSentViaBridge(dateKey: string): Promise<void> {
  await callBridge('markMobileChequeValidationSent', { dateKey }, 'mobileChequeValidationMarkSent');
}
```

- [ ] Step 1: Add the interfaces and three calls to `extension/src/api/bridge.ts`.
- [ ] Step 2: Run `npx tsc --noEmit` — passes cleanly.

### Task A5: Extension — `chequeValidationConfig.ts`

```ts
// extension/src/data/chequeValidationConfig.ts
export const MCV_CHANNEL_NAME = 'mobile-cheque-deposits-returns-working-group';
export const MCV_CC_NAMES = [
  'Estelle', 'Muaiz Khan', 'Jon', 'Vanessa', 'Nick Kiss', 'Eugene', 'Paula Bastos',
  'Odi', 'Taylor', 'Rose', 'adriana', 'Luke Gazmin', 'Albert', 'Ishan', 'Amanda Burke',
];
export const MCV_SLACK_WORKSPACE = 'wealthsimple'; // for `https://app.slack.com/client/T.../C...`

export function formatMCVDate(yyyyMmDd: string): string {
  // "2026-06-15" → "June 15th, 2026"
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const suffix = (n: number) => {
    if (n % 100 >= 11 && n % 100 <= 13) return 'th';
    if (n % 10 === 1) return 'st';
    if (n % 10 === 2) return 'nd';
    if (n % 10 === 3) return 'rd';
    return 'th';
  };
  return `${months[m - 1]} ${d}${suffix(d)}, ${y}`;
}

export function buildMCVMessage(dateKey: string, totals: { receivedCount: number; processedCount: number; day1Reversed: number; opsSlaBreach: number; riskSlaBreach: number }): string {
  return [
    `Hey Team, Here's a Validation update on mobile cheque deposit returns for ${formatMCVDate(dateKey)}.`,
    ``,
    `Cheque Returns: ✍️`,
    `Of the cheque ${totals.receivedCount} return images received, we have successfully processed ${totals.processedCount} ✅`,
    `Additionally ${totals.day1Reversed} "Day 1 Cheques" received via email have been reversed`,
    ``,
    `Breaches: 🤚`,
    `${totals.opsSlaBreach} Cheques breached Ops Reversal SLA`,
    `${totals.riskSlaBreach} Cheques breached Risk SLA`,
    ``,
    `cc: ${MCV_CC_NAMES.map((n) => '@' + n).join(' ')}`,
  ].join('\n');
}
```

- [ ] Step 1: Create the file.
- [ ] Step 2: Confirm with Albert that the channel slug and the 15 names are correct.

### Task A6: Extension — Slack content script (`content/slack.ts`)

This is the riskiest task. Slack's composer is a contenteditable powered by Draft.js — programmatic typing requires the right key/input events.

```ts
export {}; // module scope

const PENDING_KEY = 'pending_slack_post';
const RESULT_KEY = 'slack_post_result';
const PROGRESS_KEY = 'slack_post_in_progress';

interface PostJob {
  jobId: string;
  channelName: string;     // e.g. "mobile-cheque-deposits-returns-working-group"
  mode: 'channel' | 'dm';  // dm means "Slackbot self-DM to the current user"
  text: string;            // full message body (newlines preserved)
  mentions: string[];      // names that should be autocompleted as mention pills
}

interface PostResult { jobId: string; ok: boolean; reason?: string }

function log(...args: unknown[]) { console.log('[wocoo-slack]', ...args); }

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor<T>(pred: () => T | null | false, timeoutMs = 10_000, intervalMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v as T;
    await delay(intervalMs);
  }
  return null;
}

// Navigation: click the channel in the sidebar.
async function navigateToChannel(channelName: string): Promise<boolean> {
  // Slack sidebar items often have aria-label="<channel-name>".
  const link = await waitFor(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"], a, button'));
    return all.find((el) => {
      const txt = (el.innerText || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return txt.includes(channelName.toLowerCase()) || aria.includes(channelName.toLowerCase());
    }) || null;
  }, 10_000);
  if (!link) return false;
  link.click();
  await delay(800);
  return true;
}

// Find the message composer (Slack uses a contenteditable div).
async function findComposer(): Promise<HTMLElement | null> {
  return await waitFor(() => {
    const el = document.querySelector<HTMLElement>('div[role="textbox"][data-qa="message_input"]')
      || document.querySelector<HTMLElement>('div.ql-editor[contenteditable="true"]')
      || document.querySelector<HTMLElement>('div[contenteditable="true"][data-message-input]');
    return el && el.isContentEditable ? el : null;
  }, 10_000);
}

function dispatchTextInsert(el: HTMLElement, text: string) {
  // Slack listens for `beforeinput` with inputType `insertText` (Draft.js convention).
  el.focus();
  const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

async function typeMention(composer: HTMLElement, name: string): Promise<boolean> {
  // Type "@<first 4 chars>", wait for autocomplete, press Enter to select.
  const handle = '@' + name.split(' ')[0].slice(0, 4);
  for (const ch of handle) {
    dispatchTextInsert(composer, ch);
    await delay(35);
  }
  // Wait for the autocomplete popup to appear.
  const popup = await waitFor(() => document.querySelector<HTMLElement>('div[data-qa="autocomplete-list"], [role="listbox"]'), 3_000);
  if (!popup) return false;
  // Press Enter to select the first match.
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await delay(50);
  // A trailing space is conventional after a mention pill.
  dispatchTextInsert(composer, ' ');
  return true;
}

async function typeMessage(composer: HTMLElement, job: PostJob): Promise<void> {
  // Split the text on each cc name token "@<Name>" and on plain text segments.
  // The cc line is the last line; we type plain text up to each mention, then trigger autocomplete.
  const mentionTokens = job.mentions.map((n) => '@' + n);
  let remaining = job.text;
  while (remaining.length > 0) {
    let firstIdx = -1;
    let firstToken = '';
    for (const t of mentionTokens) {
      const i = remaining.indexOf(t);
      if (i !== -1 && (firstIdx === -1 || i < firstIdx)) { firstIdx = i; firstToken = t; }
    }
    if (firstIdx === -1) {
      // No more mentions; insert the rest as plain text (handle newlines as shift+enter).
      for (const line of remaining.split('\n')) {
        dispatchTextInsert(composer, line);
        if (line !== remaining.split('\n').slice(-1)[0]) {
          composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
        }
      }
      remaining = '';
      break;
    }
    // Insert plain text before the mention.
    const plain = remaining.slice(0, firstIdx);
    for (const line of plain.split('\n')) {
      dispatchTextInsert(composer, line);
      if (line !== plain.split('\n').slice(-1)[0]) {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
      }
    }
    // Type the mention (without the @-prefix consumed by the token).
    const name = firstToken.slice(1);
    await typeMention(composer, name);
    remaining = remaining.slice(firstIdx + firstToken.length);
  }
}

async function clickSend(): Promise<boolean> {
  const btn = await waitFor(() => document.querySelector<HTMLElement>('button[data-qa="texty_send_button"], button[aria-label*="Send"]'), 5_000);
  if (!btn) return false;
  btn.click();
  return true;
}

async function processJob(job: PostJob): Promise<PostResult> {
  try {
    if (job.mode === 'channel') {
      const ok = await navigateToChannel(job.channelName);
      if (!ok) return { jobId: job.jobId, ok: false, reason: 'Could not navigate to channel' };
    }
    // DM mode is left to a follow-up; for v1 we recommend opening the Slackbot DM manually.
    const composer = await findComposer();
    if (!composer) return { jobId: job.jobId, ok: false, reason: 'Composer not found' };
    composer.focus();
    await typeMessage(composer, job);
    await delay(500);
    const sent = await clickSend();
    if (!sent) return { jobId: job.jobId, ok: false, reason: 'Send button not found' };
    return { jobId: job.jobId, ok: true };
  } catch (e: any) {
    return { jobId: job.jobId, ok: false, reason: e?.message || String(e) };
  }
}

async function pickUpAndProcess() {
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
    if (e?.message?.includes('Extension context invalidated')) return;
    log('pickUpAndProcess error:', e?.message || e);
  }
}

async function bootstrap() {
  log('Slack content script loaded on', location.href);
  await chrome.storage.local.remove([PROGRESS_KEY]).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (PENDING_KEY in changes) void pickUpAndProcess();
  });
  await delay(500);
  void pickUpAndProcess();
}

void bootstrap();
```

- [ ] Step 1: Create file.
- [ ] Step 2: Add manifest content-script entry: matches `https://app.slack.com/*`.
- [ ] Step 3: Add host permission for `https://app.slack.com/*`.
- [ ] Step 4: Manually test in DevTools console first — open Slack, paste the `dispatchTextInsert` snippet into the console while focused on the composer, confirm text appears.

### Task A7: Extension — Home tile + modal

Add `MobileChequeValidationTile.tsx` and `MobileChequeValidationModal.tsx`.

Tile shows "Run validation now" as a button when no record exists. Modal shows the assembled message in an editable textarea with "Send to Slack" button.

- [ ] Step 1: Create tile component.
- [ ] Step 2: Create modal component.
- [ ] Step 3: Wire into `HomeView.tsx` Tools section.

### Task A8: Phase A smoke test

- [ ] Run `npm run build` → reload extension.
- [ ] Click the new Tools tile → "Run now".
- [ ] Confirm: Apps Script runs, returns totals, modal opens with the message preview.
- [ ] Click "Send to Slack" → Slack tab opens → message types + sends.
- [ ] Inspect the actual Slack post — check that all 15 cc'd names render as mention pills.

---

## Phase B — Scheduled trigger + status caching

### Task B1: Apps Script — install time trigger

```js
function enableMobileChequeValidationTrigger() {
  // Remove any existing trigger first.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runMobileChequeValidation_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('runMobileChequeValidation_').timeBased().atHour(9).everyDays(1).create();
}
```

- [ ] Step 1: Paste function.
- [ ] Step 2: Run `enableMobileChequeValidationTrigger()` once from the Apps Script editor.
- [ ] Step 3: Verify the trigger appears in **Triggers** (clock icon in left sidebar).

### Task B2: Extension — Home tile polls status

On Home view mount, the tile calls `getMobileChequeValidationStatusViaBridge()`. Renders:
- `null` record → "Waiting for daily run…" + a smaller "Run now" override button.
- `record.status === 'ready'` and `!sentAt` → green "Ready to post for {date}" + click opens modal.
- `record.status === 'ready'` and `sentAt` → soft green "✓ Sent today at HH:MM".
- `record.status === 'anomaly'` and `!sentAt` → amber "Validation needs attention — N issues" + click opens modal.
- `record.status === 'anomaly'` and `sentAt` → soft amber "✓ Sent to DM at HH:MM".

- [ ] Step 1: Add the polling effect.
- [ ] Step 2: Render the five states.
- [ ] Step 3: On send success, call `markMobileChequeValidationSentViaBridge(dateKey)` and re-poll.

---

## Phase C — Anomaly DM path

### Task C1: Modal renders anomaly mode

When `record.status === 'anomaly'`, the modal:
- Shows the anomalies list at the top with kind + detail.
- Hides the channel-post button and replaces it with **"Send DM to Albert"** (`mode: 'dm'` payload to Slack job).
- Pre-fills a different message template that describes the anomalies (no cc list).

```ts
// In chequeValidationConfig.ts:
export function buildMCVAnomalyDM(dateKey: string, anomalies: { kind: string; detail: string }[]): string {
  return [
    `⚠ Mobile Cheque Validation needs attention for ${formatMCVDate(dateKey)}.`,
    ``,
    `Channel post was NOT sent. Issues found:`,
    ...anomalies.map((a) => `• ${a.kind}: ${a.detail}`),
    ``,
    `Open the tracker sheet to investigate.`,
  ].join('\n');
}
```

- [ ] Step 1: Add `buildMCVAnomalyDM`.
- [ ] Step 2: Modal: branch on `record.status`.
- [ ] Step 3: Slack content script DM mode: navigate to Slackbot DM (or open a self-DM) and type. Skip mention autocomplete (no cc list in DM).

### Task C2: Slack DM navigation

Slackbot DM lives at `https://app.slack.com/client/{TEAM}/{D...}`. The simplest is to click the "Slackbot" entry in the sidebar (always present) — same approach as `navigateToChannel` but with `slackbot` as the target.

- [ ] Step 1: Generalize `navigateToChannel` to accept a sidebar item name; rename to `navigateToSidebarItem`.
- [ ] Step 2: For `mode: 'dm'`, navigate to `Slackbot`.
- [ ] Step 3: Send same way (composer + insert + send).

---

## Self-review

- Spec coverage: all Sections 1–6 of the design + the new hybrid architecture are covered.
- Placeholder scan: TBD cells in the Apps Script config are acknowledged in Task A1 (Albert fills in during testing).
- Type consistency: `MCVRecord`/`MCVTotals` shape is identical across Apps Script, bridge, and side panel.
- Scope: Phases A–C are independently shippable; D (Physical Ops cross-check) is explicitly deferred.

## Execution

Inline build per phase, with check-ins between phases:
1. Build Phase A → smoke test → fix any issues.
2. Then Phase B → check schedule fires next morning.
3. Then Phase C → verify DM mode end-to-end.
