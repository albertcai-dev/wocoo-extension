// ADDITIVE. Paste at the end of the shared WOCOO bridge project. Do not edit or reorder
// any existing handler. Route both actions in the existing doGet dispatch (see bottom).

var TICKET_LOG_SHEET_ID = '1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw';

function _readTab_(tabName) {
  var sh = SpreadsheetApp.openById(TICKET_LOG_SHEET_ID).getSheetByName(tabName);
  if (!sh) return { header: [], rows: [] };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { header: values[0] || [], rows: [] };
  return { header: values[0], rows: values.slice(1) };
}

function _rowToObject_(header, row) {
  var o = {};
  for (var i = 0; i < header.length; i++) {
    var k = String(header[i] || '').trim();
    if (!k) continue;
    var v = row[i];
    o[k] = v instanceof Date ? v.toISOString() : String(v == null ? '' : v);
  }
  return o;
}

/** Prior resolved tickets for one work type, best match first.
 *  Exact match on original_work_type scores 2, substring scores 1, no match drops the
 *  row. Rows without a resolution_note carry no knowledge, so they are dropped too. */
function handleGetRecentLog(params) {
  var wantRaw = String(params.work_type || '');
  var want = wantRaw.toLowerCase().trim();
  var limit = Math.max(1, Math.min(100, parseInt(params.limit, 10) || 25));

  var data = _readTab_('Log');
  var scored = [];

  for (var i = 0; i < data.rows.length; i++) {
    var o = _rowToObject_(data.header, data.rows[i]);
    if (!String(o.resolution_note || '').trim()) continue;

    var owt = String(o.original_work_type || '').toLowerCase().trim();
    var score = 0;
    if (want && owt === want) score = 2;
    else if (want && owt && (owt.indexOf(want) >= 0 || want.indexOf(owt) >= 0)) score = 1;
    if (score === 0) continue;

    scored.push({ score: score, loggedAt: String(o.logged_at || ''), obj: o });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : 0;
  });

  var out = [];
  for (var j = 0; j < Math.min(limit, scored.length); j++) {
    var s = scored[j].obj;
    out.push({
      logged_at: s.logged_at || '',
      ticket_id: s.ticket_id || '',
      summary: s.summary || '',
      original_work_type: s.original_work_type || '',
      final_work_type: s.final_work_type || '',
      transition: s.transition || '',
      moved_to_board: s.moved_to_board || '',
      resolution_note: s.resolution_note || '',
      tools_used: s.tools_used || ''
    });
  }
  return { action: 'recentLog', rows: out };
}

/** Whole Playbook tab. Filtering is the extension's job. */
function handleGetPlaybook() {
  var data = _readTab_('Playbook');
  var out = [];
  for (var i = 0; i < data.rows.length; i++) {
    var o = _rowToObject_(data.header, data.rows[i]);
    if (!String(o.chunk_key || '').trim()) continue;
    out.push({
      page_id: o.page_id || '',
      page_title: o.page_title || '',
      parent_path: o.parent_path || '',
      chunk_key: o.chunk_key || '',
      chunk_text: o.chunk_text || '',
      updated_at: o.updated_at || ''
    });
  }
  return { action: 'playbook', chunks: out };
}

// The browser bridge only resolves on a postMessage from the rendered HTML page. A
// handler that returns JSON directly works under the Run button and hangs in the panel.
function _handleGetRecentLogFromGet_(e) {
  return _bridgeHtmlReply_(handleGetRecentLog(e.parameter));
}

function _handleGetPlaybookFromGet_(e) {
  return _bridgeHtmlReply_(handleGetPlaybook());
}

/** Mirrors the postMessage wrapper the existing handlers use.
 *
 *  IF THE PROJECT ALREADY HAS AN EQUIVALENT HELPER under a different name, call that one
 *  from the two functions above and delete this definition. Do not keep two copies.
 *
 *  window.top, not window.parent: window.parent hits Apps Script's own mae_html_user.js
 *  wrapper, which drops unrecognised messages and leaves the extension waiting for a
 *  reply that never arrives. */
function _bridgeHtmlReply_(payload) {
  var json = JSON.stringify(payload);
  return HtmlService.createHtmlOutput(
    '<script>window.top.postMessage(' + json + ', "*");</script>'
  );
}

// ---------------------------------------------------------------------------
// Add these two blocks to the existing doGet dispatch, immediately after the
// 'transitionTicket' block and before the final `return HtmlService.createTemplateFromFile`:
//
//   if (e && e.parameter && e.parameter.action === 'getRecentLog') {
//     return _handleGetRecentLogFromGet_(e);
//   }
//   if (e && e.parameter && e.parameter.action === 'getPlaybook') {
//     return _handleGetPlaybookFromGet_(e);
//   }
//
// Then: Deploy -> Manage deployments -> edit the active deployment -> Deploy.
// Apps Script snapshots code at deploy time; saving alone changes nothing.
// ---------------------------------------------------------------------------
