// Insurance Eligibility Confirmation Triage — bridge for Sidekick.
// Standalone Apps Script project owned by creditcardoperations@ (NOT part of the CC Ops Automation project).
// Reads the Insurers tab of the CC Ops Automation sheet read-only (INSURERS_SHEET_ID) and logs to the
// sheet in LOG_SHEET_ID. Both ids, plus ELIG_ALLOWED_USERS, are Script Properties — see README.
// Deploy as a web app: Execute as = Me, Who has access = Anyone within Wealthsimple.
// Replies postMessage to window.top (NOT window.parent — GAS's inner wrapper drops them).

var ELIG_LABEL_DRAFTED = 'Sidekick/Drafted';
var ELIG_LABEL_SENT = 'Sidekick/Sent';
var ELIG_BODY_CAP = 20000;
var ELIG_EXTRA_COLS = ['match_method', 'draft_id', 'notes'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // C1: Access control — check user authorization.
    var user = String(Session.getActiveUser().getEmail() || '').toLowerCase();
    var props = PropertiesService.getScriptProperties();
    // A: trim + lowercase + drop blanks, so "a@ws.com," can't admit a blank getActiveUser().
    var allowed = String(props.getProperty('ELIG_ALLOWED_USERS') || '')
      .split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(String);
    if (!user || allowed.indexOf(user) === -1) {
      return eligReply_({ error: 'Not authorised for the eligibility bridge: ' + (user || 'unknown user') });
    }

    switch (p.action) {
      case 'listEligibilityRequests':
        return eligReply_(eligList_());
      case 'createEligibilityDraft':
        return eligReply_(eligCreateDraft_(p.messageId, p.body));
      case 'sendEligibilityDrafts':
        return eligReply_(eligSendDrafts_(String(p.draftIds || '').split(',').filter(String)));
      case 'logEligibilityResult':
        return eligReply_(eligLog_(JSON.parse(p.row)));
      case 'createAndLogEligibility':
        return eligReply_(eligCreateAndLog_(JSON.parse(p.items || '[]')));
      default:
        return eligReply_({ error: 'Unknown action: ' + p.action });
    }
  } catch (err) {
    return eligReply_({ error: String((err && err.message) || err) });
  }
}

/** Sheet ids from Script Properties. Throws a clear error when one is missing. */
function eligConfig_() {
  var props = PropertiesService.getScriptProperties();
  var cfg = { insurersSheetId: props.getProperty('INSURERS_SHEET_ID'), logSheetId: props.getProperty('LOG_SHEET_ID') };
  if (!cfg.insurersSheetId) throw new Error('Script property INSURERS_SHEET_ID is not set — see README.');
  if (!cfg.logSheetId) throw new Error('Script property LOG_SHEET_ID is not set — see README.');
  return cfg;
}

/** "Name <x@y>" or bare address -> trimmed, lowercased address. */
function eligExtractEmail_(fromStr) {
  var match = String(fromStr || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(fromStr || '')).trim().toLowerCase();
}

/** Insurer addresses from the Insurers tab (column A, from row 2) of the CC Ops Automation sheet. READ-ONLY. */
function eligLoadInsurers_() {
  var sheet = SpreadsheetApp.openById(eligConfig_().insurersSheetId).getSheetByName('Insurers');
  if (!sheet) throw new Error('Insurers tab not found in the sheet in INSURERS_SHEET_ID');
  var out = {};
  var last = sheet.getLastRow();
  if (last < 2) return out;
  sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
    var email = eligExtractEmail_(r[0]);
    if (email) out[email] = true;
  });
  return out;
}

function eligReply_(payload) {
  var json = JSON.stringify(payload).replace(/</g, '\\u003c');
  var html = '<!doctype html><html><body><script>window.top.postMessage(' + json + ', "https://script.google.com");</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function eligLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function eligHasLabel_(thread, name) {
  return thread.getLabels().some(function (l) { return l.getName() === name; });
}

var ELIG_LIST_CAP = 500;
var ELIG_DRAFTED_CAP = 200;
var ELIG_UNKNOWN_CAP = 200;
var ELIG_PAGE = 100;

/** GmailApp.search paged by 100 up to `cap` threads. Returns { threads, capped }. */
function eligSearchCapped_(query, cap) {
  var out = [];
  var start = 0;
  while (out.length < cap) {
    var want = Math.min(ELIG_PAGE, cap - out.length);
    var page = GmailApp.search(query, start, want);
    if (!page || page.length === 0) break;
    out = out.concat(page);
    if (page.length < want) return { threads: out, capped: false };
    start += page.length;
  }
  return { threads: out, capped: out.length >= cap };
}

/** Latest non-draft message of a thread, plus the non-draft count; null when the thread is all drafts. */
function eligLatest_(msgs) {
  var real = msgs.filter(function (m) { return !m.isDraft(); });
  if (!real.length) return null;
  return { m: real[real.length - 1], count: real.length };
}

function eligRequestShape_(t, latest) {
  var m = latest.m;
  return {
    threadId: t.getId(),
    messageId: m.getId(),
    from: m.getFrom(),
    fromEmail: eligExtractEmail_(m.getFrom()),
    subject: m.getSubject(),
    date: m.getDate().toISOString(),
    messageCount: latest.count,
    plainBody: (m.getPlainBody() || '').substring(0, ELIG_BODY_CAP),
  };
}

function eligList_() {
  var t0 = Date.now();
  var insurers = eligLoadInsurers_();
  var insurerAddrs = Object.keys(insurers);
  var props = PropertiesService.getScriptProperties();
  // Domains from the normalised addresses. (loadInsurerDomains_ splits the raw
  // "Name <x@y>" string and yields "y>", so it never matches — don't reuse it.)
  var domains = {};
  insurerAddrs.forEach(function (addr) {
    var d = addr.split('@')[1];
    if (d) domains[d.toLowerCase()] = true;
  });
  domains['wealthsimple.com'] = true;

  var out = [];
  var drafted = [];
  var timings = { totalMs: 0, insurerScanMs: 0, draftedScanMs: 0, unknownScanMs: 0 };
  var fromGroup = '';

  // I4: with no insurers there is no from-clause to build — skip the insurer queries
  // entirely (an empty `{}` group would match everything).
  if (insurerAddrs.length) {
    fromGroup = '{' + insurerAddrs.map(function (a) { return 'from:' + a; }).join(' ') + '}';

    var tIns = Date.now();
    var reqThreads = eligSearchCapped_('in:inbox is:unread -label:sidekick-drafted ' + fromGroup, ELIG_LIST_CAP).threads;
    var reqMsgs = reqThreads.length ? GmailApp.getMessagesForThreads(reqThreads) : [];
    reqThreads.forEach(function (t, i) {
      var latest = eligLatest_(reqMsgs[i]);
      if (!latest || !latest.m.isUnread()) return;
      // Threads whose latest sender isn't an insurer are not offered for drafting.
      if (!insurers[eligExtractEmail_(latest.m.getFrom())]) return;
      out.push(eligRequestShape_(t, latest));
    });
    timings.insurerScanMs = Date.now() - tIns;

    // I1: drafted-but-unsent threads, so a lost panel session can still send them.
    var tDr = Date.now();
    var drThreads = eligSearchCapped_('in:inbox is:unread label:sidekick-drafted -label:sidekick-sent ' + fromGroup, ELIG_DRAFTED_CAP).threads;
    var drMsgs = drThreads.length ? GmailApp.getMessagesForThreads(drThreads) : [];
    drThreads.forEach(function (t, i) {
      var draftId = props.getProperty('elig_draft_thread_' + t.getId());
      if (!draftId) return; // Not a draft this bridge owns.
      if (props.getProperty('elig_sent_' + draftId)) return; // Already sent; only the cleanup failed.
      var latest = eligLatest_(drMsgs[i]);
      if (!latest) return;
      if (!insurers[eligExtractEmail_(latest.m.getFrom())]) return;
      var row = eligRequestShape_(t, latest);
      row.draftId = draftId;
      drafted.push(row);
    });
    timings.draftedScanMs = Date.now() - tDr;
  }

  // I4: safety net — unread, untouched threads with no message from an Insurers-tab address.
  // Count-only: the thread search alone (paged 100 at a time, up to 200), never loading messages.
  var tUnk = Date.now();
  var unknownQuery = 'in:inbox is:unread -label:sidekick-drafted -label:sidekick-sent' + (fromGroup ? ' -' + fromGroup : '');
  var unknown = eligSearchCapped_(unknownQuery, ELIG_UNKNOWN_CAP);
  var skipped = unknown.threads.length;
  timings.unknownScanMs = Date.now() - tUnk;
  timings.totalMs = Date.now() - t0;

  var result = {
    action: 'eligibilityRequestsListed',
    requests: out,
    drafted: drafted,
    excludedDomains: Object.keys(domains),
    skippedUnknownSender: skipped,
    timings: timings,
  };
  if (unknown.capped) result.skippedUnknownSenderCapped = true;
  return result;
}

function eligCreateDraft_(messageId, body) {
  if (!messageId || !body) throw new Error('messageId and body are required');
  var insurers = eligLoadInsurers_();

  // I2: Wrap in lock for thread safety.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return eligCreateDraftCore_(messageId, body, insurers, {});
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates (or reuses) the Sidekick draft reply on `messageId`'s thread. The caller holds the script lock and
 * passes the preloaded insurer map; `ctx` caches the Drafted label across a batch.
 */
function eligCreateDraftCore_(messageId, body, insurers, ctx) {
  if (!messageId || !body) throw new Error('messageId and body are required');
  var msg = GmailApp.getMessageById(messageId);

  // C1: Refuse unless the message's sender is an insurer.
  var fromEmail = eligExtractEmail_(msg.getFrom());
  if (!insurers[fromEmail]) throw new Error('Message is not from a known insurer');

  var thread = msg.getThread();
  var threadId = thread.getId();
  var props = PropertiesService.getScriptProperties();
  var propKey = 'elig_draft_thread_' + threadId;

  // I2: Check if we have a stored draft for this thread.
  var storedDraftId = props.getProperty(propKey);
  if (storedDraftId) {
    var existing = null;
    try {
      existing = GmailApp.getDraft(storedDraftId);
    } catch (err) {
      existing = null;
    }
    if (existing) {
      return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: storedDraftId, reused: true };
    }
    // M5: Draft was deleted (getDraft threw or returned null); clean up stale properties.
    props.deleteProperty(propKey);
    props.deleteProperty('elig_draft_id_' + storedDraftId);
  }

  // Create a new draft.
  var draft = msg.createDraftReply(body, { name: 'Cash and Card Operations' });
  var draftId = draft.getId();

  // C1/I2: Store ownership tracking properties.
  props.setProperty(propKey, draftId);
  props.setProperty('elig_draft_id_' + draftId, threadId);
  if (!ctx.draftedLabel) ctx.draftedLabel = eligLabel_(ELIG_LABEL_DRAFTED);
  thread.addLabel(ctx.draftedLabel);

  return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: draftId, reused: false };
}

var ELIG_BATCH_CAP = 50;

/**
 * Batched Create drafts & log. items = [{ messageId, body ('' = log only), row }]. Config, insurers and the log
 * sheet load once per call; each item takes the script lock for its own create+log (short holds, so two panel
 * workers' batches interleave instead of timing out on one batch-long lock) and fails on its own.
 */
function eligCreateAndLog_(items) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  if (items.length > ELIG_BATCH_CAP) throw new Error('Too many items in one batch (max ' + ELIG_BATCH_CAP + ')');
  var insurers = eligLoadInsurers_();
  var sheet = eligOpenLogSheet_();
  var ctx = {};

  var results = items.map(function (item) {
    var out = { messageId: String((item && item.messageId) || ''), ok: false };
    try {
      if (!item || !item.row || typeof item.row !== 'object') throw new Error('row is required');
      var row = item.row;
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        if (item.body) {
          var d = eligCreateDraftCore_(out.messageId, String(item.body), insurers, ctx);
          out.draftId = d.draftId;
          out.reused = d.reused;
          row.draft_id = d.draftId;
          row.status = 'DRAFTED';
        }
        eligLogTo_(sheet, row);
        out.ok = true;
      } finally {
        lock.releaseLock();
      }
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
    return out;
  });
  return { action: 'eligibilityBatchDone', results: results };
}

function eligSendDrafts_(draftIds) {
  var drafted = eligLabel_(ELIG_LABEL_DRAFTED);
  var sentLabel = eligLabel_(ELIG_LABEL_SENT);
  var props = PropertiesService.getScriptProperties();

  var results = draftIds.map(function (id) {
    try {
      // I2: A draft we already sent (e.g. the reply to an earlier call was lost) is never sent twice.
      if (props.getProperty('elig_sent_' + id)) {
        return { draftId: id, ok: true, alreadySent: true };
      }

      // C1: Verify the draft is owned by Sidekick.
      var threadId = props.getProperty('elig_draft_id_' + id);
      if (!threadId) {
        return { draftId: id, ok: false, error: 'Not a Sidekick draft — refusing to send' };
      }

      var sent = GmailApp.getDraft(id).send();
    } catch (err) {
      return { draftId: id, ok: false, error: String((err && err.message) || err) };
    }

    // The email is out; from here on nothing may read as "Send failed".
    try {
      // I2: Record the send first, so a retry of this draftId answers alreadySent.
      props.setProperty('elig_sent_' + id, threadId);
      var t = sent.getThread();
      t.markRead();
      t.removeLabel(drafted);
      t.addLabel(sentLabel);
      // C1: Delete both ownership properties after successful send (elig_sent_ stays).
      props.deleteProperty('elig_draft_id_' + id);
      props.deleteProperty('elig_draft_thread_' + threadId);
      return { draftId: id, ok: true };
    } catch (err) {
      return { draftId: id, ok: true, warning: 'Sent, but tidy-up failed: ' + String((err && err.message) || err) };
    }
  });
  return { action: 'eligibilityDraftsSent', results: results };
}

/** The Requests tab of the sheet in LOG_SHEET_ID, widened to 12 columns when needed. */
function eligOpenLogSheet_() {
  var sheet = SpreadsheetApp.openById(eligConfig_().logSheetId).getSheetByName('Requests');
  if (!sheet) throw new Error('Requests tab not found in the sheet in LOG_SHEET_ID');

  // I4: Guard sheet dimensions.
  if (sheet.getMaxColumns() < 12) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
  }
  return sheet;
}

function eligLog_(row) {
  var sheet = eligOpenLogSheet_();

  // I4: Wrap the scan+write in lock.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return eligLogTo_(sheet, row);
  } finally {
    lock.releaseLock();
  }
}

/** Upserts `row` by request_message_id into `sheet`. The caller holds the script lock. */
function eligLogTo_(sheet, row) {
  var header = sheet.getRange(1, 1, 1, 12).getValues()[0];
  ELIG_EXTRA_COLS.forEach(function (name, i) {
    if (!header[9 + i]) sheet.getRange(1, 10 + i).setValue(name);
  });

  var values = [[
    row.request_message_id, row.thread_id, row.insurer_email, row.client_email, row.status,
    row.last4, row.is_delinquent, row.activation_date, row.card_product,
    row.match_method, row.draft_id, row.notes,
  ]];

  var last = sheet.getLastRow();
  var ids = last >= 2 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(row.request_message_id)) {
      var targetRange = sheet.getRange(i + 2, 1, 1, 12);
      // READ_EMAIL is logged with a minimal resolution when a draft from an earlier session is sent, so its
      // blank fields must not wipe the DRAFTED audit values. Merge for READ_EMAIL only: any other status
      // (e.g. NEEDS_REVIEW re-resolved to NO_MATCH) is a genuine re-resolution and must fully overwrite,
      // otherwise stale card data would survive.
      if (row.status === 'READ_EMAIL') {
        var existing = targetRange.getValues()[0];
        var merged = values[0].map(function (incoming, c) {
          var cur = existing[c];
          var incomingEmpty = incoming === '' || incoming === null || incoming === undefined;
          if (incomingEmpty) return cur;
          // notes is the last column (index 11): append when both differ.
          if (c === 11 && cur !== '' && cur !== null && cur !== undefined && String(cur) !== String(incoming)) {
            return cur + ' | ' + incoming;
          }
          return incoming;
        });
        values = [merged];
      }
      // I4: Set number format to text.
      targetRange.setNumberFormat('@').setValues(values);
      return { action: 'eligibilityResultLogged', rowNumber: i + 2 };
    }
  }

  // I4: Guard row insertion.
  var insertRow = last + 1;
  if (insertRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), insertRow - sheet.getMaxRows());
  }
  var targetRange = sheet.getRange(insertRow, 1, 1, 12);
  // I4: Set number format to text.
  targetRange.setNumberFormat('@').setValues(values);
  return { action: 'eligibilityResultLogged', rowNumber: insertRow };
}

// ---- Editor test helpers (Run ▸ from the editor; read the Execution log) ----

function testListEligibilityRequests() {
  var r = eligList_();
  Logger.log('requests=%s drafted=%s skippedUnknownSender=%s%s domains=%s', r.requests.length, r.drafted.length,
    r.skippedUnknownSender, r.skippedUnknownSenderCapped ? '+' : '', r.excludedDomains.join(','));
  r.requests.slice(0, 3).forEach(function (q) { Logger.log('%s | %s | %s', q.messageId, q.fromEmail, q.subject); });
}

// Creates and immediately deletes one test draft in the shared mailbox — optional; skip it during the read-only POC.
/** Drafts twice on the newest listed request and checks the second call reuses the draft. Deletes the draft afterwards. */
function testEligibilityIdempotency() {
  var r = eligList_();
  if (!r.requests.length) { Logger.log('No unread insurer requests to test on.'); return; }
  var id = r.requests[0].messageId;
  var a = eligCreateDraft_(id, 'TEST DRAFT — delete me');
  var b = eligCreateDraft_(id, 'TEST DRAFT — delete me');
  Logger.log('first=%s second=%s reused=%s', a.draftId, b.draftId, b.reused);
  if (a.draftId !== b.draftId || !b.reused) throw new Error('Idempotency FAILED');

  GmailApp.getDraft(a.draftId).deleteDraft();
  var t = GmailApp.getMessageById(id).getThread();
  t.removeLabel(eligLabel_(ELIG_LABEL_DRAFTED));

  // Delete the property-based tracking entries.
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('elig_draft_id_' + a.draftId);
  props.deleteProperty('elig_draft_thread_' + t.getId());

  Logger.log('Idempotency OK; test draft deleted, label removed, properties cleaned.');
}
