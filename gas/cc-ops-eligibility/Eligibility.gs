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
    var allowedStr = (props.getProperty('ELIG_ALLOWED_USERS') || '').trim();
    var allowed = allowedStr ? allowedStr.split(',').map(function (s) { return s.trim().toLowerCase(); }) : [];
    if (!allowedStr || allowed.indexOf(user) === -1) {
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

function eligList_() {
  var insurers = loadInsurers_();
  // Domains from the normalised addresses. (loadInsurerDomains_ splits the raw
  // "Name <x@y>" string and yields "y>", so it never matches — don't reuse it.)
  var domains = {};
  Object.keys(insurers).forEach(function (addr) {
    var d = addr.split('@')[1];
    if (d) domains[d.toLowerCase()] = true;
  });
  domains['wealthsimple.com'] = true;

  // I3: Build Gmail query with from-clause for insurer addresses.
  var fromClauses = Object.keys(insurers).map(function (a) { return 'from:' + a; }).join(' ');
  var query = 'in:inbox is:unread -label:sidekick-drafted {' + fromClauses + '}';

  var out = [];
  var skipped = 0;
  var totalSeen = 0;
  var start = 0;
  var pageSize = 100;
  var maxThreads = 500;

  // Page through results until we get fewer than 100 or hit the hard cap.
  while (totalSeen < maxThreads) {
    var threads = GmailApp.search(query, start, pageSize);
    if (!threads || threads.length === 0) break;

    threads.forEach(function (t) {
      // I3: Ignore draft messages.
      var msgs = t.getMessages().filter(function (m) { return !m.isDraft(); });
      if (msgs.length === 0) return; // Skip thread with no non-draft messages.

      var m = msgs[msgs.length - 1];
      if (!m.isUnread()) return;
      var fromEmail = extractEmailAddress_(m.getFrom());
      if (!insurers[fromEmail]) { skipped++; return; }
      out.push({
        threadId: t.getId(),
        messageId: m.getId(),
        from: m.getFrom(),
        fromEmail: fromEmail,
        subject: m.getSubject(),
        date: m.getDate().toISOString(),
        messageCount: msgs.length,
        plainBody: (m.getPlainBody() || '').substring(0, ELIG_BODY_CAP),
      });
    });

    totalSeen += threads.length;
    if (threads.length < pageSize) break; // Less than a full page, we're done.
    start += pageSize;
  }

  return {
    action: 'eligibilityRequestsListed',
    requests: out,
    excludedDomains: Object.keys(domains),
    skippedUnknownSender: skipped,
  };
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
      try {
        var existing = GmailApp.getDraft(storedDraftId);
        return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: storedDraftId, reused: true };
      } catch (err) {
        // I2: Draft was deleted; clean up stale properties.
        props.deleteProperty(propKey);
        props.deleteProperty('elig_draft_id_' + storedDraftId);
      }
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
      // C1: Verify the draft is owned by Sidekick.
      var threadId = props.getProperty('elig_draft_id_' + id);
      if (!threadId) {
        return { draftId: id, ok: false, error: 'Not a Sidekick draft — refusing to send' };
      }

      var sent = GmailApp.getDraft(id).send();
      var t = sent.getThread();
      t.markRead();
      t.removeLabel(drafted);
      t.addLabel(sentLabel);

      // C1: Delete both properties after successful send.
      props.deleteProperty('elig_draft_id_' + id);
      props.deleteProperty('elig_draft_thread_' + threadId);

      return { draftId: id, ok: true };
    } catch (err) {
      return { draftId: id, ok: false, error: String((err && err.message) || err) };
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
  Logger.log('requests=%s skippedUnknownSender=%s domains=%s', r.requests.length, r.skippedUnknownSender, r.excludedDomains.join(','));
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
