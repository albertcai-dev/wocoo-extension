/**
 * Email thread linking — ADDITIVE patch, 2026-09-14.
 *
 * Paste these functions into the WOCOO bridge Apps Script project as a new file and
 * redeploy. Nothing here modifies an existing function; the only change to existing
 * behaviour is the `awaitingMyReply` field that `checkForReplies` starts returning,
 * which older extension builds ignore.
 *
 * VERIFY BEFORE PASTING: this assumes the tracking sheet's `trackKey` column can hold a
 * hex Gmail thread id for `kind='email'` rows, and that the sheet has a header row with
 * the column names `wocooTicketId`, `kind`, `trackKey`. Confirm against the live sheet
 * and adjust the header.indexOf(...) lookups if the names differ.
 *
 * It also assumes three helpers already exist in the project: getReplyTrackingSheet_(),
 * appendReplyTrackingRow_(sheet, fields) and setReplyTrackingRow_(sheet, rowNumber,
 * lastSeenMsgId, acknowledged). If they are named differently, rename the calls below
 * rather than adding duplicates.
 *
 * Deployment caches at deploy time — redeploy after pasting, or the extension keeps
 * hitting the old code.
 */

/** Senders whose mail must never mean "they are waiting on you." Ported verbatim from
 *  AUTOMATED_SENDER in extension/src/data/emailLink.ts — keep the two in step. */
var AUTOMATED_SENDER_RE = /(noreply|no-reply|donotreply|do-not-reply|survey)/i;

function emailLink_extractAddress_(from) {
  var s = String(from || '');
  var m = s.match(/<([^>]+)>/);
  var candidate = (m ? m[1] : s).trim().toLowerCase();
  return candidate.indexOf('@') >= 0 ? candidate : '';
}

function emailLink_isSelfSender_(from, me) {
  var mine = emailLink_extractAddress_(me) || String(me || '').trim().toLowerCase();
  if (!mine) return false;
  return emailLink_extractAddress_(from) === mine;
}

function emailLink_me_() {
  var me = '';
  try { me = Session.getActiveUser().getEmail(); } catch (e) { me = ''; }
  if (!me) {
    try { me = Session.getEffectiveUser().getEmail(); } catch (e2) { me = ''; }
  }
  return me;
}

/** Inspect a thread and describe its last message. Returns null when the thread can't be
 *  read — deleted, or out of scope. Callers keep the row either way; an unreadable
 *  thread is far more likely to be transient than genuinely gone. */
function emailLink_describeThread_(threadId, me) {
  var thread = null;
  try { thread = GmailApp.getThreadById(threadId); } catch (e) { thread = null; }
  if (!thread) return null;

  var messages = thread.getMessages();
  if (!messages.length) return null;
  var last = messages[messages.length - 1];
  var from = last.getFrom();

  return {
    threadId: threadId,
    subject: thread.getFirstMessageSubject(),
    messageId: last.getId(),
    from: from,
    snippet: String(last.getPlainBody() || '').slice(0, 200),
    receivedAt: last.getDate().toISOString(),
    messageCount: messages.length,
    // An automated sender still counts as a new reply, but never as someone waiting.
    awaitingMyReply: !emailLink_isSelfSender_(from, me) && !AUTOMATED_SENDER_RE.test(from),
  };
}

/** action=searchEmailThreads&query=…&limit=…  →  reply=emailThreadsSearched
 *
 *  `threadId:<hex>` is handled specially: it isn't Gmail search syntax, it's how the
 *  extension asks "describe exactly this thread so the agent can confirm it." */
function handleSearchEmailThreads(params) {
  var query = String(params.query || '').trim();
  var limit = Math.min(Number(params.limit || 8) || 8, 20);
  var me = emailLink_me_();
  var out = [];

  var direct = query.match(/^threadId:([0-9a-f]{12,20})$/i);
  if (direct) {
    var one = emailLink_describeThread_(direct[1].toLowerCase(), me);
    if (one) out.push(one);
  } else if (query) {
    var threads = GmailApp.search(query, 0, limit);
    for (var i = 0; i < threads.length; i++) {
      var d = emailLink_describeThread_(threads[i].getId(), me);
      if (d) out.push(d);
    }
  }

  var linked = emailLink_linkedThreadIndex_();
  return {
    reply: 'emailThreadsSearched',
    threads: out.map(function (d) {
      return {
        threadId: d.threadId,
        subject: d.subject,
        from: d.from,
        lastFrom: d.from,
        lastDate: d.receivedAt,
        messageCount: d.messageCount,
        linkedTo: linked[d.threadId] || '',
      };
    }),
  };
}

/** threadId → wocooTicketId for every existing kind='email' row, so the picker can warn
 *  that a candidate is already attached elsewhere. */
function emailLink_linkedThreadIndex_() {
  var sheet = getReplyTrackingSheet_();   // existing helper in the bridge project
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var cKind = header.indexOf('kind');
  var cKey = header.indexOf('trackKey');
  var cTicket = header.indexOf('wocooTicketId');
  var index = {};
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][cKind]) === 'email') index[String(rows[r][cKey])] = String(rows[r][cTicket]);
  }
  return index;
}

/** action=linkEmailThread&wocooTicketId=…&threadId=…  →  reply=emailThreadLinked
 *
 *  acknowledged=TRUE and lastSeenMsgId=<current last> on purpose: linking a thread you
 *  are looking at must not manufacture a "new reply". An unanswered thread still goes
 *  red immediately, via awaitingMyReply. */
function handleLinkEmailThread(params) {
  var ticketId = String(params.wocooTicketId || '').trim();
  var threadId = String(params.threadId || '').trim().toLowerCase();
  if (!ticketId || !threadId) throw new Error('linkEmailThread needs wocooTicketId and threadId');

  var described = emailLink_describeThread_(threadId, emailLink_me_());
  if (!described) throw new Error('Could not read Gmail thread ' + threadId);

  var sheet = getReplyTrackingSheet_();
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var cKind = header.indexOf('kind');
  var cKey = header.indexOf('trackKey');
  var cTicket = header.indexOf('wocooTicketId');

  // Idempotent: re-linking the same thread to the same ticket updates rather than
  // appends, so a double-click can't create a duplicate card.
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][cTicket]) === ticketId
      && String(rows[r][cKind]) === 'email'
      && String(rows[r][cKey]) === threadId) {
      setReplyTrackingRow_(sheet, r + 1, described.messageId, true);   // existing helper
      return { reply: 'emailThreadLinked', threadId: threadId, updated: true };
    }
  }

  appendReplyTrackingRow_(sheet, {                                     // existing helper
    wocooTicketId: ticketId,
    kind: 'email',
    trackKey: threadId,
    lastSeenMsgId: described.messageId,
    acknowledged: true,
  });
  return { reply: 'emailThreadLinked', threadId: threadId, updated: false };
}

/** action=unlinkEmailThread&wocooTicketId=…&threadId=…  →  reply=emailThreadUnlinked
 *
 *  The only path that deletes a tracking row. The extension's archive is sticky by
 *  design, so without this a misclick in the picker would be permanent. */
function handleUnlinkEmailThread(params) {
  var ticketId = String(params.wocooTicketId || '').trim();
  var threadId = String(params.threadId || '').trim().toLowerCase();
  var sheet = getReplyTrackingSheet_();
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var cKind = header.indexOf('kind');
  var cKey = header.indexOf('trackKey');
  var cTicket = header.indexOf('wocooTicketId');

  for (var r = rows.length - 1; r >= 1; r--) {
    if (String(rows[r][cTicket]) === ticketId
      && String(rows[r][cKind]) === 'email'
      && String(rows[r][cKey]) === threadId) {
      sheet.deleteRow(r + 1);
      return { reply: 'emailThreadUnlinked', threadId: threadId, deleted: true };
    }
  }
  return { reply: 'emailThreadUnlinked', threadId: threadId, deleted: false };
}

/**
 * ===== THREE EDITS TO EXISTING FUNCTIONS =====
 *
 * (1) Router (doGet's action switch) — add three cases:
 *       case 'searchEmailThreads': return reply_(handleSearchEmailThreads(params));
 *       case 'linkEmailThread':    return reply_(handleLinkEmailThread(params));
 *       case 'unlinkEmailThread':  return reply_(handleUnlinkEmailThread(params));
 *
 * (2) checkForReplies — per tracking row, after the existing Koho/i2c matching:
 *       • kind === 'email': resolve via emailLink_describeThread_(trackKey, me).
 *         New reply when described.messageId !== row.lastSeenMsgId AND the sender is not
 *         self. A new reply writes acknowledged=FALSE. Write lastSeenMsgId back every
 *         poll either way. Return threadId, subject, awaitingMyReply alongside the
 *         existing fields.
 *       • kind === 'koho' or 'i2c' with a non-empty lastSeenMsgId: reach the thread via
 *         GmailApp.getMessageById(lastSeenMsgId).getThread().getId(), then the same
 *         emailLink_describeThread_ call, and return only its awaitingMyReply (do not
 *         overwrite the existing matching logic). A blank lastSeenMsgId means no thread
 *         to inspect: omit awaitingMyReply entirely so the extension reads it as
 *         undetermined rather than false.
 *       • Cap the Gmail work at 60 rows per invocation, newest row first. Uncapped, a
 *         long-lived sheet eventually exceeds the execution limit and the poll returns
 *         nothing at all — worse than returning the 60 freshest.
 *
 * (3) acknowledgeReply — it now receives an optional `trackKey` param. When present,
 *     match the row on wocooTicketId AND trackKey; when absent, keep matching on
 *     wocooTicketId alone. A ticket can hold several rows now, so without this an ack
 *     can clear the wrong one.
 */
