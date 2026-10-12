// Insurance Eligibility Confirmation Triage — bridge for Sidekick.
// Standalone Apps Script project owned by creditcardoperations@ (NOT part of the CC Ops Automation project).
// CC Ops Automation sheet (INSURERS_SHEET_ID): READS the Insurers tab, and WRITES only the "previous records"
// tab, only columns A–I (one row per drafted request; status flipped to READ_EMAIL on send). Nothing else in that
// sheet is touched, and a failure there never fails a draft or a send (it comes back as a per-item `warning`).
// The full 12-column audit row is still logged to the sheet in LOG_SHEET_ID.
// Both ids, plus ELIG_ALLOWED_USERS, are Script Properties — see README.
// Insurer senders: an address listed on the Insurers tab, OR any address on an insurer domain (the domain of a
// listed address, e.g. every crawco.ca adjuster once one is listed). Generic/internal domains (ELIG_GENERIC_DOMAINS,
// plus optional Script Property ELIG_EXCLUDED_DOMAINS, and their subdomains) never count; optional
// ELIG_EXTRA_INSURER_DOMAINS adds more.
// Deploy as a web app: Execute as = Me, Who has access = Anyone within Wealthsimple.
// Replies postMessage to window.top (NOT window.parent — GAS's inner wrapper drops them).

var ELIG_LABEL_DRAFTED = 'Sidekick/Drafted';
var ELIG_LABEL_SENT = 'Sidekick/Sent';
var ELIG_BODY_CAP = 20000;
var ELIG_EXTRA_COLS = ['match_method', 'draft_id', 'notes'];
/** Tab of the CC Ops Automation sheet (INSURERS_SHEET_ID) that gets one row per drafted request. Columns A–I only. */
var ELIG_PREVIOUS_RECORDS_TAB = 'previous records';
var ELIG_PREVIOUS_RECORDS_COLS = 9;

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

/**
 * "Name <x@y>" or bare address -> trimmed, lowercased address. Takes the LAST `<…>` (the real address), so a
 * display name like `"a@insurer.example <b>" <x@y>` can't pass for an insurer.
 */
function eligExtractEmail_(fromStr) {
  var s = String(fromStr || '');
  var all = s.match(/<[^>]+>/g);
  var addr = all ? all[all.length - 1].slice(1, -1) : s;
  return addr.trim().toLowerCase();
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

/** Domains that are never insurer domains (internal or generic mail providers), whatever the Insurers tab lists. */
var ELIG_GENERIC_DOMAINS = [
  'wealthsimple.com', 'gmail.com', 'googlemail.com', 'google.com', 'okta.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.ca', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me',
];

/** "a.com, @B.com ,," -> ['a.com', 'b.com'] (trimmed, lowercased, leading '@' dropped, blanks dropped). */
function eligDomainList_(s) {
  return String(s || '')
    .split(',')
    .map(function (d) { return d.trim().toLowerCase().replace(/^@+/, ''); })
    .filter(String);
}

/** Lowercased part after the last '@' of a "Name <x@y>" or bare address; '' when there is none. */
function eligDomainOf_(fromStr) {
  var email = eligExtractEmail_(fromStr);
  var at = email.lastIndexOf('@');
  return at >= 0 ? email.substring(at + 1) : '';
}

/**
 * Who counts as an insurer sender. `insurers` is the eligLoadInsurers_ map (normalised address -> true).
 * domains = the listed addresses' domains plus ELIG_EXTRA_INSURER_DOMAINS, minus ELIG_GENERIC_DOMAINS and
 * ELIG_EXCLUDED_DOMAINS and their subdomains (docs.google.com, x.okta.com, mail.wealthsimple.com) — an excluded
 * domain never becomes an insurer domain, even when listed as extra.
 * match(from) -> 'listed' (exact address on the tab) | 'domain' (address on an insurer domain, exact domain only)
 * | null.
 */
function eligInsurerMatcher_(insurers) {
  var props = PropertiesService.getScriptProperties();
  var excluded = ELIG_GENERIC_DOMAINS.concat(eligDomainList_(props.getProperty('ELIG_EXCLUDED_DOMAINS')));
  var isExcluded = function (d) {
    return excluded.some(function (g) { return d === g || d.slice(-(g.length + 1)) === '.' + g; });
  };
  var set = {};
  var add = function (d) { if (d && !isExcluded(d)) set[d] = true; };
  Object.keys(insurers).forEach(function (addr) { add(eligDomainOf_(addr)); });
  eligDomainList_(props.getProperty('ELIG_EXTRA_INSURER_DOMAINS')).forEach(add);
  return {
    domains: Object.keys(set),
    match: function (fromStr) {
      var email = eligExtractEmail_(fromStr);
      if (!email) return null;
      if (insurers[email]) return 'listed';
      var d = eligDomainOf_(email);
      return d && set[d] ? 'domain' : null;
    },
  };
}

/** Gmail search queries are kept under this many characters; a longer from-group is split across searches. */
var ELIG_QUERY_MAX = 1500;

/**
 * `from:` terms grouped into `{…}` clauses so that `longestBase + ' -' + group` stays within ELIG_QUERY_MAX.
 * A single term too long to share a group gets one of its own. No terms -> [] (never an empty `{}`, which
 * would match everything).
 */
function eligFromGroups_(terms, longestBase) {
  var room = ELIG_QUERY_MAX - String(longestBase).length - 4; // ' -{' + '}'
  var groups = [];
  var cur = [];
  var len = 0;
  terms.forEach(function (term) {
    var add = (cur.length ? 1 : 0) + term.length;
    if (cur.length && len + add > room) {
      groups.push(cur);
      cur = [];
      len = 0;
      add = term.length;
    }
    cur.push(term);
    len += add;
  });
  if (cur.length) groups.push(cur);
  return groups.map(function (g) { return '{' + g.join(' ') + '}'; });
}

/** One capped search per group (`base + ' ' + group`), threads unioned by id in order. Returns { threads, capped }. */
function eligSearchGroups_(base, groups, cap) {
  var seen = {};
  var threads = [];
  var capped = false;
  groups.forEach(function (g) {
    var r = eligSearchCapped_(base + ' ' + g, cap);
    if (r.capped) capped = true;
    r.threads.forEach(function (t) {
      var id = t.getId();
      if (seen[id]) return;
      seen[id] = true;
      threads.push(t);
    });
  });
  return { threads: threads, capped: capped };
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

/** Latest non-draft message of a thread, plus the non-draft count and list; null when the thread is all drafts. */
function eligLatest_(msgs) {
  var real = msgs.filter(function (m) { return !m.isDraft(); });
  if (!real.length) return null;
  return { m: real[real.length - 1], count: real.length, real: real };
}

/**
 * The panel's view of a thread. Follow-up threads (more than one non-draft message) also carry `originalBody`,
 * the body of the first insurer message (else the first message), so a terse follow-up can be matched on the
 * original request; `priorReplyFromUs` says whether the script owner (creditcardoperations@) already replied.
 * `matcher` is eligInsurerMatcher_'s; `senderMatch` says how the latest sender was recognised ('listed' | 'domain').
 */
function eligRequestShape_(t, latest, matcher, owner) {
  var m = latest.m;
  var real = latest.real || [m];
  var originalBody = '';
  if (real.length > 1) {
    var first = real.filter(function (x) { return matcher.match(x.getFrom()); })[0] || real[0];
    originalBody = (first.getPlainBody() || '').substring(0, ELIG_BODY_CAP);
  }
  return {
    threadId: t.getId(),
    messageId: m.getId(),
    from: m.getFrom(),
    fromEmail: eligExtractEmail_(m.getFrom()),
    subject: m.getSubject(),
    date: m.getDate().toISOString(),
    messageCount: latest.count,
    plainBody: (m.getPlainBody() || '').substring(0, ELIG_BODY_CAP),
    originalBody: originalBody,
    priorReplyFromUs: !!owner && real.some(function (x) { return eligExtractEmail_(x.getFrom()) === owner; }),
    senderMatch: matcher.match(m.getFrom()) || 'listed',
  };
}

function eligList_() {
  var t0 = Date.now();
  var insurers = eligLoadInsurers_();
  var matcher = eligInsurerMatcher_(insurers);
  var insurerAddrs = Object.keys(insurers);
  var props = PropertiesService.getScriptProperties();
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  // Addresses on these domains are never the client's: the insurer domains plus our own.
  // (Built from the normalised addresses — loadInsurerDomains_ splits the raw "Name <x@y>" string and yields
  // "y>", so it never matches; don't reuse it.)
  var domains = {};
  matcher.domains.forEach(function (d) { domains[d] = true; });
  domains['wealthsimple.com'] = true;

  var out = [];
  var drafted = [];
  var timings = { totalMs: 0, insurerScanMs: 0, draftedScanMs: 0, unknownScanMs: 0 };
  var reqBase = 'in:inbox is:unread -label:sidekick-drafted';
  var drBase = 'in:inbox is:unread label:sidekick-drafted -label:sidekick-sent';
  var unkBase = 'in:inbox is:unread -label:sidekick-drafted -label:sidekick-sent';
  // Every insurer domain (Gmail's `from:` matches a bare domain) plus the listed addresses not already covered by
  // one (e.g. on an excluded generic domain), split into groups that keep each query within ELIG_QUERY_MAX.
  var terms = insurerAddrs
    .filter(function (a) { return matcher.domains.indexOf(eligDomainOf_(a)) === -1; })
    .concat(matcher.domains)
    .map(function (a) { return 'from:' + a; });
  var groups = eligFromGroups_(terms, unkBase.length >= drBase.length ? unkBase : drBase);
  // Every thread the insurer scan returned, and those among them whose latest unread sender failed match().
  var insurerThreadIds = {};
  var unmatchedIds = {};
  var insurerScanCapped = false;

  // I4: with no insurers there is no from-clause to build — skip the insurer queries
  // entirely (an empty `{}` group would match everything).
  if (groups.length) {
    var tIns = Date.now();
    var reqSearch = eligSearchGroups_(reqBase, groups, ELIG_LIST_CAP);
    insurerScanCapped = reqSearch.capped;
    var reqThreads = reqSearch.threads;
    reqThreads.forEach(function (t) { insurerThreadIds[t.getId()] = true; });
    var reqMsgs = reqThreads.length ? GmailApp.getMessagesForThreads(reqThreads) : [];
    reqThreads.forEach(function (t, i) {
      var latest = eligLatest_(reqMsgs[i]);
      if (!latest || !latest.m.isUnread()) return;
      // Threads whose latest sender isn't an insurer (listed or on an insurer domain) are not offered for drafting.
      // Gmail's `from:` may have matched a subdomain, a look-alike or an earlier message; the query exclusion
      // hides these from the unknown-sender search, so they are counted as unknown here instead of vanishing.
      if (!matcher.match(latest.m.getFrom())) {
        if (!eligHasLabel_(t, ELIG_LABEL_SENT)) unmatchedIds[t.getId()] = true;
        return;
      }
      out.push(eligRequestShape_(t, latest, matcher, owner));
    });
    timings.insurerScanMs = Date.now() - tIns;

    // I1: drafted-but-unsent threads, so a lost panel session can still send them.
    var tDr = Date.now();
    var drThreads = eligSearchGroups_(drBase, groups, ELIG_DRAFTED_CAP).threads;
    var drMsgs = drThreads.length ? GmailApp.getMessagesForThreads(drThreads) : [];
    drThreads.forEach(function (t, i) {
      var draftId = props.getProperty('elig_draft_thread_' + t.getId());
      if (!draftId) return; // Not a draft this bridge owns.
      if (props.getProperty('elig_sent_' + draftId)) return; // Already sent; only the cleanup failed.
      var latest = eligLatest_(drMsgs[i]);
      if (!latest) return;
      if (!matcher.match(latest.m.getFrom())) return;
      var row = eligRequestShape_(t, latest, matcher, owner);
      row.draftId = draftId;
      drafted.push(row);
    });
    timings.draftedScanMs = Date.now() - tDr;
  }

  // I4: safety net — unread, untouched threads with no message from an insurer (listed address or insurer domain).
  // Count-only: the thread search alone (paged 100 at a time, up to 200), never loading messages.
  var tUnk = Date.now();
  var cand;
  if (groups.length <= 1) {
    cand = eligSearchCapped_(unkBase + (groups.length ? ' -' + groups[0] : ''), ELIG_UNKNOWN_CAP);
  } else {
    // Too many senders for one query: exclude the first group in the query, then drop the threads the insurer
    // scan already found for the other groups (it covers every unread, not-drafted insurer thread).
    cand = eligSearchCapped_(unkBase + ' -' + groups[0], ELIG_UNKNOWN_CAP + Object.keys(insurerThreadIds).length);
  }
  // Unknown = the search's threads the insurer scan didn't return, plus the scan's threads whose latest sender
  // failed match() (counted once by id, so a split search can't count one twice).
  var unknownIds = {};
  var unknownCount = 0;
  var addUnknown = function (id) { if (!unknownIds[id]) { unknownIds[id] = true; unknownCount++; } };
  cand.threads.forEach(function (t) { if (!insurerThreadIds[t.getId()]) addUnknown(t.getId()); });
  Object.keys(unmatchedIds).forEach(addUnknown);
  var unknown = {
    count: Math.min(unknownCount, ELIG_UNKNOWN_CAP),
    capped: cand.capped || insurerScanCapped || unknownCount >= ELIG_UNKNOWN_CAP,
  };
  var skipped = unknown.count;
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
  var matcher = eligInsurerMatcher_(eligLoadInsurers_());

  // I2: Wrap in lock for thread safety.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return eligCreateDraftCore_(messageId, body, matcher, {});
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates (or reuses) the Sidekick draft reply on `messageId`'s thread. The caller holds the script lock and
 * passes the preloaded eligInsurerMatcher_; `ctx` caches the Drafted label across a batch.
 */
function eligCreateDraftCore_(messageId, body, matcher, ctx) {
  if (!messageId || !body) throw new Error('messageId and body are required');
  var msg = GmailApp.getMessageById(messageId);

  // C1: Refuse unless the message's sender is an insurer (listed on the Insurers tab, or on an insurer domain).
  if (!matcher.match(msg.getFrom())) throw new Error('Message is not from a known insurer');

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
  var matcher = eligInsurerMatcher_(eligLoadInsurers_());
  var sheet = eligOpenLogSheet_();
  var ctx = {};
  var props = PropertiesService.getScriptProperties();
  // Opened on the first draft only (log-only batches never touch the CC Ops sheet), once per call.
  var previous = eligPreviousRecordsOpener_();

  var results = items.map(function (item) {
    var out = { messageId: String((item && item.messageId) || ''), ok: false };
    try {
      if (!item || !item.row || typeof item.row !== 'object') throw new Error('row is required');
      var row = item.row;
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        var needsPrevious = false;
        if (item.body) {
          var d = eligCreateDraftCore_(out.messageId, String(item.body), matcher, ctx);
          out.draftId = d.draftId;
          out.reused = d.reused;
          row.draft_id = d.draftId;
          row.status = 'DRAFTED';
          needsPrevious = true;
        } else if (row.draft_id && !props.getProperty('elig_prev_req_' + row.draft_id) &&
            props.getProperty('elig_draft_id_' + row.draft_id) === String(row.thread_id || '')) {
          // Log-only retry of an unsent Sidekick draft (on this thread) whose "previous records" row was never written.
          needsPrevious = true;
        }
        if (needsPrevious) {
          // Straight after the draft, so a later log failure (retried as log-only) can't skip it.
          // Never fails the item: a problem here is only a warning.
          try {
            eligUpsertPreviousRecord_(previous(), row);
            // The send-time READ_EMAIL flip touches only this row (never a coworker's row on the same thread).
            props.setProperty('elig_prev_req_' + row.draft_id, String(row.request_message_id));
          } catch (prErr) {
            out.warning = 'previous records not updated: ' + String((prErr && prErr.message) || prErr);
          }
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
  var previous = eligPreviousRecordsOpener_();

  /**
   * Flips this draft's own "previous records" row (recorded at create time) to READ_EMAIL, under the script lock.
   * Never changes `result.ok`; a problem is only a warning.
   */
  function markPrevious(result, draftId, threadId) {
    try {
      var requestId = props.getProperty('elig_prev_req_' + draftId);
      if (!requestId) throw new Error('no Sidekick row was recorded for this draft');
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        eligMarkPreviousRecordRead_(previous(), requestId, threadId);
      } finally {
        lock.releaseLock();
      }
      props.deleteProperty('elig_prev_req_' + draftId);
    } catch (err) {
      var w = 'previous records not updated: ' + String((err && err.message) || err);
      result.warning = result.warning ? result.warning + '; ' + w : w;
    }
    return result;
  }

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
      return markPrevious({ draftId: id, ok: true }, id, threadId);
    } catch (err) {
      return markPrevious({ draftId: id, ok: true, warning: 'Sent, but tidy-up failed: ' + String((err && err.message) || err) }, id, threadId);
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

// ---- CC Ops Automation "previous records" tab (columns A–I only) ----

/**
 * Returns a function that opens the "previous records" tab on its first call and returns the same sheet
 * (or rethrows the same error) on every later call, so a batch opens the spreadsheet at most once.
 */
function eligPreviousRecordsOpener_() {
  var state = null;
  return function () {
    if (!state) {
      try {
        var tab = SpreadsheetApp.openById(eligConfig_().insurersSheetId).getSheetByName(ELIG_PREVIOUS_RECORDS_TAB);
        if (!tab) throw new Error('"' + ELIG_PREVIOUS_RECORDS_TAB + '" tab not found in the sheet in INSURERS_SHEET_ID');
        state = { sheet: tab };
      } catch (err) {
        state = { error: err };
      }
    }
    if (state.error) throw state.error;
    return state.sheet;
  };
}

/**
 * Upserts a DRAFTED row into "previous records", keyed on column A (request_message_id). Writes A:I only: a new
 * row goes below the last row; an existing row is overwritten in A:I. Only the id cells (A, B) and the last4 cell
 * (F) are set to plain text (ids never parse as numbers, "0123" keeps its zero); other cells keep their format.
 * The caller holds the script lock.
 */
function eligUpsertPreviousRecord_(sheet, row) {
  var values = [[
    row.request_message_id, row.thread_id, row.insurer_email, row.client_email, 'DRAFTED',
    row.last4, row.is_delinquent, row.activation_date, row.card_product,
  ]];
  var id = String(row.request_message_id || '');
  if (!id) throw new Error('request_message_id is required');

  var last = sheet.getLastRow();
  var target = 0;
  if (last >= 2) {
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) { target = i + 2; break; }
    }
  }
  if (!target) {
    target = Math.max(last + 1, 2);
    if (target > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), target - sheet.getMaxRows());
  }
  sheet.getRange(target, 1, 1, 2).setNumberFormat('@');
  sheet.getRange(target, 6).setNumberFormat('@');
  sheet.getRange(target, 1, 1, ELIG_PREVIOUS_RECORDS_COLS).setValues(values);
  return target;
}

/**
 * Sets column E (status) to READ_EMAIL on the Sidekick row whose column A is `requestId` AND column B is `threadId`,
 * only while it still reads DRAFTED. Rows written by anyone else (same thread, other request id) are never touched.
 * The caller holds the script lock.
 */
function eligMarkPreviousRecordRead_(sheet, requestId, threadId) {
  if (!requestId || !threadId) throw new Error('no request/thread id for this draft');
  var last = sheet.getLastRow();
  var rows = last >= 2 ? sheet.getRange(2, 1, last - 1, 5).getValues() : [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(requestId) && String(rows[i][1]) === String(threadId)) {
      var status = String(rows[i][4]);
      if (status !== 'DRAFTED') throw new Error('row ' + (i + 2) + ' status is ' + (status || 'blank') + ', not DRAFTED — left as is');
      sheet.getRange(i + 2, 5).setValue('READ_EMAIL');
      return i + 2;
    }
  }
  throw new Error('no Sidekick row for request ' + requestId + ' on thread ' + threadId);
}

// ---- Editor test helpers (Run ▸ from the editor; read the Execution log) ----

function testListEligibilityRequests() {
  var r = eligList_();
  Logger.log('requests=%s drafted=%s skippedUnknownSender=%s%s domains=%s', r.requests.length, r.drafted.length,
    r.skippedUnknownSender, r.skippedUnknownSenderCapped ? '+' : '', r.excludedDomains.join(','));
  r.requests.slice(0, 3).forEach(function (q) { Logger.log('%s | %s | %s | %s', q.messageId, q.fromEmail, q.senderMatch, q.subject); });
  var byDomain = r.requests.filter(function (q) { return q.senderMatch === 'domain'; });
  if (byDomain.length) Logger.log('matched by insurer domain only (not on the Insurers tab): %s', byDomain.map(function (q) { return q.fromEmail; }).join(', '));
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
