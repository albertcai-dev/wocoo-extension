// Server-to-server entry point for the Tracecat insurance-eligibility workflow (staging POC).
// Lives in the same standalone "Sidekick Eligibility Bridge (POC)" project as Eligibility.gs and reuses its helpers.
//
// Deploy as a SEPARATE web app deployment: Execute as = Me (creditcardoperations@), Who has access = Anyone.
// "Anyone" is needed because Tracecat has no Google login; the shared secret below is the only key, so every
// action is narrow:
//   - tracecatListRequests: read-only (same data Sidekick's Fetch sees).
//   - tracecatSendReply: replies ONLY on a single-message, unread thread whose sender is an insurer (listed on
//     the Insurers tab — domain-only senders are refused), that neither Sidekick nor Tracecat has touched, and
//     only with a body in the exact CC Ops reply template. Never sends to a new address, never twice.
//   - tracecatLogRows: upserts rows into the "Eligibility POC Log" Requests tab (same as Sidekick).
// Script Property TRACECAT_TOKEN (>= 32 chars) must match the Tracecat secret; missing/short = every call refused.
// Sidekick's doGet is untouched. Replies are JSON (ContentService), not postMessage.

var ELIG_LABEL_TRACECAT = 'Tracecat/Sent';
var TRACECAT_REPLY_RE = new RegExp(
  '^Hi,\\n\\nHere are the requested details for client(?: [^\\s:@]+@[^\\s:@]+)?:\\n\\n' +
  '(?:• Last 4 digits of card: \\d{4}\\n• Status: the card is (?:not )?in good standing\\n' +
  '• Activation date: \\d{2}/\\d{2}/\\d{4}\\n• Product: [a-z_]+(?:\\n\\n(?=•))?)+' +
  '\\n\\nBest,\\nCash and Card Operations\\n\\n-- \\n$');
var TRACECAT_SEND_CAP = 25;

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var expected = String(PropertiesService.getScriptProperties().getProperty('TRACECAT_TOKEN') || '');
    if (expected.length < 32 || !tracecatSafeEquals_(String(body.token || ''), expected)) {
      return tracecatJson_({ ok: false, error: 'unauthorised' });
    }
    switch (body.action) {
      case 'tracecatListRequests':
        return tracecatJson_({ ok: true, data: eligList_() });
      case 'tracecatSendReply':
        return tracecatJson_(tracecatSendReply_(String(body.messageId || ''), String(body.body || ''), body.row));
      case 'tracecatLogRows':
        return tracecatJson_(tracecatLogRows_(body.rows));
      default:
        return tracecatJson_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return tracecatJson_({ ok: false, error: String((err && err.message) || err) });
  }
}

function tracecatJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

/** Constant-time string compare, so the token can't be guessed a character at a time. */
function tracecatSafeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Sends `body` as a reply on `messageId`'s thread, then marks it read, labels it Tracecat/Sent and logs `row`
 * (status SENT_BY_TRACECAT). Every guard runs under the script lock, so a retried call can't double-send.
 */
function tracecatSendReply_(messageId, body, row) {
  if (!messageId) return { ok: false, error: 'messageId is required' };
  if (!TRACECAT_REPLY_RE.test(body)) return { ok: false, error: 'body is not the CC Ops reply template' };
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props.getProperty('elig_tracecat_sent_' + messageId)) return { ok: true, alreadySent: true };
    var sentToday = Number(props.getProperty('elig_tracecat_sent_on_' + tracecatToday_()) || 0);
    if (sentToday >= TRACECAT_SEND_CAP) return { ok: false, error: 'daily send cap reached (' + TRACECAT_SEND_CAP + ')' };

    var msg = GmailApp.getMessageById(messageId);
    var insurers = eligLoadInsurers_();
    if (eligInsurerMatcher_(insurers).match(msg.getFrom()) !== 'listed') {
      return { ok: false, error: 'sender is not listed on the Insurers tab' };
    }
    var thread = msg.getThread();
    var real = thread.getMessages().filter(function (m) { return !m.isDraft(); });
    if (real.length !== 1 || real[0].getId() !== messageId) return { ok: false, error: 'thread is not a single unanswered message' };
    if (!msg.isUnread()) return { ok: false, error: 'message is already read (someone may be handling it)' };
    if (eligHasLabel_(thread, ELIG_LABEL_DRAFTED) || eligHasLabel_(thread, ELIG_LABEL_SENT) ||
        props.getProperty('elig_draft_thread_' + thread.getId())) {
      return { ok: false, error: 'Sidekick has a draft or reply on this thread' };
    }

    msg.reply(body, { name: 'Cash and Card Operations' });
    props.setProperty('elig_tracecat_sent_' + messageId, new Date().toISOString());
    props.setProperty('elig_tracecat_sent_on_' + tracecatToday_(), String(sentToday + 1));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    lock.releaseLock();
  }

  // The email is out; from here on nothing may read as "send failed".
  var out = { ok: true };
  try {
    thread.markRead();
    thread.addLabel(eligLabel_(ELIG_LABEL_TRACECAT));
  } catch (err) {
    out.warning = 'Sent, but tidy-up failed: ' + String((err && err.message) || err);
  }
  if (row && typeof row === 'object') {
    try {
      row.status = 'SENT_BY_TRACECAT';
      eligLog_(row);
    } catch (err) {
      out.warning = (out.warning ? out.warning + '; ' : '') + 'log failed: ' + String((err && err.message) || err);
    }
  }
  return out;
}

/** Upserts skipped/no-match rows into the log. A row for a message Tracecat already sent is never overwritten. */
function tracecatLogRows_(rows) {
  if (!Array.isArray(rows)) return { ok: false, error: 'rows must be an array' };
  if (rows.length > 200) return { ok: false, error: 'too many rows (max 200)' };
  var props = PropertiesService.getScriptProperties();
  var sheet = eligOpenLogSheet_();
  var logged = 0;
  var errors = [];
  rows.forEach(function (row) {
    try {
      if (!row || !row.request_message_id) throw new Error('request_message_id is required');
      if (props.getProperty('elig_tracecat_sent_' + row.request_message_id)) return;
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        eligLogTo_(sheet, row);
        logged++;
      } finally {
        lock.releaseLock();
      }
    } catch (err) {
      errors.push(String((row && row.request_message_id) || '?') + ': ' + String((err && err.message) || err));
    }
  });
  return { ok: errors.length === 0, logged: logged, errors: errors };
}

function tracecatToday_() {
  return Utilities.formatDate(new Date(), 'America/Toronto', 'yyyy-MM-dd');
}

// ---- Editor helpers ----

/** Run once from the editor: creates TRACECAT_TOKEN (if missing) and logs it so it can be copied into Tracecat. */
function setupTracecatToken() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TRACECAT_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TRACECAT_TOKEN', token);
  }
  Logger.log('TRACECAT_TOKEN = %s', token);
}

/** Checks the template guard against a known-good and a tampered body. No mail is touched. */
function testTracecatTemplateGuard() {
  var good = 'Hi,\n\nHere are the requested details for client a.b@example.com:\n\n' +
    '• Last 4 digits of card: 1763\n• Status: the card is in good standing\n• Activation date: 08/21/2026\n' +
    '• Product: ws_visa_infinite_privilege\n\nBest,\nCash and Card Operations\n\n-- \n';
  var two = good.replace('ws_visa_infinite_privilege\n\n', 'ws_visa_infinite_privilege\n\n' +
    '• Last 4 digits of card: 0042\n• Status: the card is not in good standing\n• Activation date: 01/02/2025\n' +
    '• Product: ws_visa_infinite_plus\n\n');
  var bad = good.replace('Best,', 'Click https://evil.example to verify.\n\nBest,');
  Logger.log('good=%s two=%s bad=%s', TRACECAT_REPLY_RE.test(good), TRACECAT_REPLY_RE.test(two), TRACECAT_REPLY_RE.test(bad));
  if (!TRACECAT_REPLY_RE.test(good) || !TRACECAT_REPLY_RE.test(two) || TRACECAT_REPLY_RE.test(bad)) {
    throw new Error('Template guard FAILED');
  }
}
