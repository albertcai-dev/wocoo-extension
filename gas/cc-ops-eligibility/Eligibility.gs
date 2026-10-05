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
  var html = '<!doctype html><html><body><script>window.top.postMessage(' + json + ', "*");</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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

  var threads = GmailApp.search('in:inbox is:unread -label:sidekick-drafted', 0, 100);
  var out = [];
  var skipped = 0;
  threads.forEach(function (t) {
    var msgs = t.getMessages();
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
  var thread = msg.getThread();
  if (eligHasLabel_(thread, ELIG_LABEL_DRAFTED)) {
    var existing = GmailApp.getDrafts().filter(function (d) {
      return d.getMessage().getThread().getId() === thread.getId();
    })[0];
    if (existing) return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: existing.getId(), reused: true };
  }
  var draft = msg.createDraftReply(body, { name: 'Cash and Card Operations' });
  thread.addLabel(eligLabel_(ELIG_LABEL_DRAFTED));
  return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: draft.getId(), reused: false };
}

function eligSendDrafts_(draftIds) {
  var drafted = eligLabel_(ELIG_LABEL_DRAFTED);
  var sentLabel = eligLabel_(ELIG_LABEL_SENT);
  var results = draftIds.map(function (id) {
    try {
      var sent = GmailApp.getDraft(id).send();
      var t = sent.getThread();
      t.markRead();
      t.removeLabel(drafted);
      t.addLabel(sentLabel);
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
      sheet.getRange(i + 2, 1, 1, 12).setValues(values);
      return { action: 'eligibilityResultLogged', rowNumber: i + 2 };
    }
  }
  sheet.getRange(last + 1, 1, 1, 12).setValues(values);
  return { action: 'eligibilityResultLogged', rowNumber: last + 1 };
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
  Logger.log('Idempotency OK; test draft deleted, label removed.');
}
