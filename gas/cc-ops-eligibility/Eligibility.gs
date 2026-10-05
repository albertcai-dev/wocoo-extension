// Insurance Eligibility Confirmation Triage — bridge for Sidekick.
// Lives in the CC Ops Automation Apps Script project, owned by creditcardoperations@.
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
      default:
        return eligReply_({ error: 'Unknown action: ' + p.action });
    }
  } catch (err) {
    return eligReply_({ error: String((err && err.message) || err) });
  }
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
    fromEmail: extractEmailAddress_(m.getFrom()),
    subject: m.getSubject(),
    date: m.getDate().toISOString(),
    messageCount: latest.count,
    plainBody: (m.getPlainBody() || '').substring(0, ELIG_BODY_CAP),
  };
}

function eligList_() {
  var insurers = loadInsurers_();
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

  // I4: with no insurers there is no from-clause to build — skip the insurer queries
  // entirely (an empty `{}` group would match everything).
  if (insurerAddrs.length) {
    var fromGroup = '{' + insurerAddrs.map(function (a) { return 'from:' + a; }).join(' ') + '}';

    var reqThreads = eligSearchCapped_('in:inbox is:unread -label:sidekick-drafted ' + fromGroup, ELIG_LIST_CAP).threads;
    var reqMsgs = reqThreads.length ? GmailApp.getMessagesForThreads(reqThreads) : [];
    reqThreads.forEach(function (t, i) {
      var latest = eligLatest_(reqMsgs[i]);
      if (!latest || !latest.m.isUnread()) return;
      // Threads whose latest sender isn't an insurer are counted by the unknown-sender search below.
      if (!insurers[extractEmailAddress_(latest.m.getFrom())]) return;
      out.push(eligRequestShape_(t, latest));
    });

    // I1: drafted-but-unsent threads, so a lost panel session can still send them.
    var drThreads = eligSearchCapped_('in:inbox is:unread label:sidekick-drafted -label:sidekick-sent ' + fromGroup, ELIG_DRAFTED_CAP).threads;
    var drMsgs = drThreads.length ? GmailApp.getMessagesForThreads(drThreads) : [];
    drThreads.forEach(function (t, i) {
      var draftId = props.getProperty('elig_draft_thread_' + t.getId());
      if (!draftId) return; // Not a draft this bridge owns.
      if (props.getProperty('elig_sent_' + draftId)) return; // Already sent; only the cleanup failed.
      var latest = eligLatest_(drMsgs[i]);
      if (!latest) return;
      if (!insurers[extractEmailAddress_(latest.m.getFrom())]) return;
      var row = eligRequestShape_(t, latest);
      row.draftId = draftId;
      drafted.push(row);
    });
  }

  // I4: safety net — unread, untouched threads whose latest sender is NOT on the Insurers tab.
  var unknown = eligSearchCapped_('in:inbox is:unread -label:sidekick-drafted -label:sidekick-sent', ELIG_UNKNOWN_CAP);
  var unkMsgs = unknown.threads.length ? GmailApp.getMessagesForThreads(unknown.threads) : [];
  var skipped = 0;
  unknown.threads.forEach(function (t, i) {
    var latest = eligLatest_(unkMsgs[i]);
    if (!latest) return;
    if (!insurers[extractEmailAddress_(latest.m.getFrom())]) skipped++;
  });

  var result = {
    action: 'eligibilityRequestsListed',
    requests: out,
    drafted: drafted,
    excludedDomains: Object.keys(domains),
    skippedUnknownSender: skipped,
  };
  if (unknown.capped) result.skippedUnknownSenderCapped = true;
  return result;
}

function eligCreateDraft_(messageId, body) {
  if (!messageId || !body) throw new Error('messageId and body are required');
  var msg = GmailApp.getMessageById(messageId);

  // C1: Refuse unless the message's sender is an insurer.
  var fromEmail = extractEmailAddress_(msg.getFrom());
  if (!loadInsurers_()[fromEmail]) throw new Error('Message is not from a known insurer');

  // I2: Wrap in lock for thread safety.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
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
    thread.addLabel(eligLabel_(ELIG_LABEL_DRAFTED));

    return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: draftId, reused: false };
  } finally {
    lock.releaseLock();
  }
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

function eligLog_(row) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Requests');
  if (!sheet) throw new Error('Requests sheet not found');

  // I4: Guard sheet dimensions.
  if (sheet.getMaxColumns() < 12) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
  }

  // I4: Wrap the scan+write in lock.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
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
  } finally {
    lock.releaseLock();
  }
}

// ---- Editor test helpers (Run ▸ from the editor; read the Execution log) ----

function testListEligibilityRequests() {
  var r = eligList_();
  Logger.log('requests=%s drafted=%s skippedUnknownSender=%s%s domains=%s', r.requests.length, r.drafted.length,
    r.skippedUnknownSender, r.skippedUnknownSenderCapped ? '+' : '', r.excludedDomains.join(','));
  r.requests.slice(0, 3).forEach(function (q) { Logger.log('%s | %s | %s', q.messageId, q.fromEmail, q.subject); });
}

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
