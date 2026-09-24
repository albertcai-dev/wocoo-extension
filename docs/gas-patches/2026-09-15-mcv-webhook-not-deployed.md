# MCV: `sendMcvWebhook` is not in the live bridge (2026-09-15)

**Symptom.** v3 site → Cheque Validation → **Send digest DM** shows
`Bridge call timed out after 60s.` The record itself loads fine (Run now / Re-run work),
so the compute half of the pipeline is healthy.

**Root cause.** `sendMcvWebhook` does not exist in the deployed Apps Script project.
`McvWebhook.gs` was written into `wocoo-gas-bridge` but never pasted into the editor, and
no router line was added. `Code.gs`'s `doGet` ends with

```js
    return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      ...
```

so an unrecognised `action` does not error — it renders the dashboard's own `Index` page
inside the hidden iframe. That page never calls
`window.top.postMessage({action:'mcvWebhookSent', …})`, so
`callBridgeViaIframe("sendMcvWebhook", …, "mcvWebhookSent", 60000)` in `app-core.js`
waits out its full 60s and rejects. The timeout is the *symptom of a silent 404*.

Evidence: `gasExportViaDrive` output (`wocoo-bridge-source.json`, 2026-09-14 18:31) lists
9 files — `appsscript`, `Code`, `JiraAPI`, `Index`, `Config`, `ReplyTracking`,
`RefundLetter`, `I2cThreadLookup`, `CreateFraud`. No `McvWebhook`, and no `sendMcvWebhook`
anywhere in `Code.gs`. The observed failure mode corroborates that independently of the
export's age: `_handleSendMcvWebhookFromGet_` catches everything and replies
`{ok:false, error}`, so a *deployed* handler with an unset script property would surface
that error in about a second. Only an unrouted action can hang for the full 60s.

**Caveat on the export's age.** That same snapshot also lacks `CustomCcStatement`,
`IssueLinks` and `parseTranscript`, yet `getIssueLinks` is recorded as pasted and verified
on 2026-09-14 — so the export may predate later pastes that day. Re-run `gasExportViaDrive`
before treating those three as undeployed.

Steps 1–5 fix the DM. Step 6 is the reason this presented as a 60s hang instead of an
error, and is worth landing in the same paste.

## 1. Paste the module

New file in the bridge project, named `McvWebhook`, contents of
`wocoo-gas-bridge/McvWebhook.gs` verbatim.

## 2. Add the router line

In `Code.gs`'s `doGet`, next to the existing `markMobileChequeValidationSent` line:

```js
    if (e && e.parameter && e.parameter.action === 'sendMcvWebhook') {
      return _handleSendMcvWebhookFromGet_(e);
    }
```

## 3. Set the two script properties

Project Settings → Script properties. Values are the Slack Workflow Builder trigger URLs
already in the extension — copy them out of
`wocoo-extension/extension/src/data/chequeValidationConfig.ts`:

| Property | Source constant |
|---|---|
| `mcv_ready_webhook_url` | `MCV_READY_WEBHOOK_URL` (line 23) |
| `mcv_anomaly_webhook_url` | `MCV_ANOMALY_WEBHOOK_URL` (line 12) |

Keep the URLs in script properties only — they must not land in `wocoo-gas-bridge`.

## 4. Prove it from the editor

Run `testSendMcvWebhook`. It posts a real DM dated `January 1st, 1970` with all-zero
numbers; delete that DM afterwards. A failure here is a property or a WB variable-name
problem, not a router problem.

Then check the router itself, before spending a deployment — paste this into the editor and
run it:

```js
function whatDoesSendMcvWebhookReturn() {
  var out = doGet({ parameter: { action: 'sendMcvWebhook', kind: 'ready' } }).getContent();
  Logger.log(out.indexOf('mcvWebhookSent') !== -1 ? 'ROUTED' : 'FELL THROUGH TO DASHBOARD');
}
```

`FELL THROUGH TO DASHBOARD` means step 2 didn't land. This is the same check that caught the
identical `backfillI2cBatch` routing miss on 2026-08-03.

## 5. Redeploy — this is the step that actually publishes it

Deploy → **Manage deployments** → edit the existing deployment → **New version** →
Deploy. The `/exec` URL serves the code version pinned at deploy time, so pasting alone
changes nothing for the site or the extension. Editing the existing deployment keeps the
deployment ID, so `BRIDGE_URL` in `app-core.js` and `bridge.ts` stay valid.

## 6. Make the next missing action fail loudly

Replace the `doGet` fallthrough so a *present but unrecognised* action reports itself
instead of silently rendering the dashboard. An action-less `/exec` (the dashboard) and
the `code`+`state` OAuth callback are unaffected.

Was:

```js
    return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('WOCOO Triage Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
```

Now:

```js
    // A request that carries an `action` we don't route is always a bug — a module that
    // wasn't pasted, or a paste that wasn't redeployed. Rendering Index here makes it look
    // like a network hang: the client waits out its whole timeout because this page never
    // posts a reply message. Reply with the error instead. `replyAction` lets the caller
    // resolve it as its own expected message; without it the caller still times out, but
    // the Apps Script execution log now names the action.
    if (e && e.parameter && e.parameter.action) {
      var unknown = {
        action: e.parameter.replyAction || 'bridgeUnknownAction',
        ok: false,
        error: 'Bridge action "' + e.parameter.action + '" is not deployed. Paste its .gs ' +
               'module and router line, then Deploy → Manage deployments → New version.'
      };
      if (typeof _repliesReplyHtml_ === 'function') return _repliesReplyHtml_(unknown);
      return HtmlService.createHtmlOutput(
        '<!DOCTYPE html><html><body><script>var p=' +
        JSON.stringify(unknown).replace(/</g, '\\u003c') +
        ';try{window.top.postMessage(p,"*");}catch(e){}</script></body></html>'
      ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('WOCOO Triage Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
```

`replyAction` is optional and nothing sends it today; adding it to
`callBridgeViaIframe` / `callBridge` is a separate change, and until then step 6 buys a
named entry in the execution log rather than a faster client-side failure.
