# WOCOO Triager Chrome Extension

Ticket-in-context Chrome extension for the WOCOO triage board (CXA — Credit Card, Banking, Account Info). Sticky sidepanel + 13 shipped workflows on top of Jira / Atlas / i2c / Ledge / Preset / Slack.

**PRD:** [WOCOO Triager Extension](https://docs.google.com/document/d/1WFs_H1904OqiyQHBLNVpcDo1-VGWLaNv4OZ2NCNXhu8/edit) · **Long-form vision:** `PRD.md`

## What it does

- **Ticket-in-context sidepanel** — auto-detects the current WOCOO key from the Jira tab (three URL patterns), fetches the ticket via Atlassian OAuth, renders identity / tier / status / email with copy chips. Sticky across tab switches.
- **13 workflows**: Clone/Move (EOC · DBO · CRED · FRAUD · PRR), Reverse Fee (regular + interest variant), Overpayment Triage, QC Fee Waiver, Retention Fee Waiver, Wallet Triage, Visa Companion RPIN, Create REIMB, Fetch Account# + Client Status (headless Atlas), Wires Pending Posting (Home tool), Mobile Cheque Validation (Home tool), Messaging (i2c / Koho).
- **Auto-detect recommendation cards** — 8 detectors surface a workflow based on ticket summary/description with mutually-exclusive vetoes so exactly one card fires per ticket.
- **Ticket Knowledge Loop (Phase 1)** — every Jira transition writes to a Google Sheet + inline note prompt.

## Prerequisites

- **Chrome** (Manifest V3)
- **Node.js 20+** and **npm**
- Signed in to these in your normal browser session (the extension reuses cookies passively):
  - `wealthsimple.atlassian.net` via Okta
  - `atlas.wealthsimple.com`
  - `wealthsimplecs.mycardplace.com` (i2c) — credentials entered once via the extension's Settings view
  - `ledge.wealthsimple.com`, `*.preset.io`, `app.slack.com` (as needed per workflow)
  - Google account (for the Apps Script bridge)

## Install

```bash
git clone git@github.com:albertcai-dev/wocoo-extension.git
cd wocoo-extension/extension
cp .env.example .env               # fill in values from 1Password → "WOCOO Triager > Atlassian OAuth 3LO"
npm install
npm run build                      # produces extension/dist/
```

Then in Chrome:

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select `extension/dist/`
4. Note the assigned extension ID — must match the one the Atlassian OAuth app is registered against (see **Gotchas** below)
5. Open the sidepanel via the WOCOO Triager toolbar icon → complete Atlassian OAuth flow → enter i2c credentials in Settings

## Development

```bash
npm run build       # one-off build
npm run watch       # rebuilds on file change; still requires manual reload
```

Manifest V3 doesn't hot-reload extension code. After each build, hit the ↻ reload button on the extension in `chrome://extensions` before your changes take effect. Content scripts also require a page reload on the target tab.

## Architecture

- **Manifest V3** with sidepanel API, content scripts on 8 domains, and a background service worker for tab-key routing.
- **Vite + React + TypeScript**, `@crxjs/vite-plugin@2-beta`, Mint DS Web 1.0 semantic tokens via CSS custom properties.
- **Auth**: Atlassian OAuth 2.0 (3LO) with PKCE via `chrome.identity.launchWebAuthFlow`; token in `chrome.storage.local` with auto-refresh ~60s before expiry.
- **Cross-context message bus**: sidepanel writes `pending_*` keys to `chrome.storage.local`, the target-domain content script picks them up and executes, results flow back via `chrome.storage.onChanged`.
- **Sticky ticket detection**: content script on `wealthsimple.atlassian.net` watches `history.pushState`/`replaceState`; sidepanel only overwrites on positive detection of a *different* WOCOO ticket.

### The Apps Script bridge (separate project — not in this repo)

Sheet writes, Gmail sends, and long-running server-side work happen via a published Google Apps Script webapp. **The GAS source lives in a separate script project in the Google Apps Script editor** (shared with the v3 Magic site's `wocoo-triage-v3`) — this repo only contains the client-side glue:

- `extension/src/api/bridge.ts` — opens the GAS webapp URL, dispatches actions, listens for postMessage replies. All Move/Clone-triggered calls run headless via `chrome.tabs.create({ active: false })` + auto-close so no `script.google.com` tabs flash on the operator.
- `extension/src/content/gasBridge.ts` — content script on `script.google.com` that forwards the sandbox iframe's postMessage into the extension via `chrome.runtime.sendMessage`.

Actions the bridge expects the GAS project to handle: `logMove`, `logTicket`, `updateTicketLog`, `sendKohoEmail`, `readPendingWires`, `markWirePosted`, `runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent`, `parseTranscript`. Changing any of these here without updating the GAS project (or vice-versa) will silently break the corresponding workflow.

## Repo layout

```
wocoo-extension/
├── README.md                       ← you are here
├── PRD.md                          long-form vision
├── PRD-workflow-launcher.md        alternative launcher idea (not built)
├── design-brief.md
├── claude-design-prompts.md
├── docs/superpowers/               specs + plans per workflow
└── extension/                      ← the Chrome extension itself
    ├── .env.example                copy to .env, fill from 1Password
    ├── manifest.json
    ├── package.json
    ├── vite.config.ts
    ├── public/icons/               extension icons
    └── src/
        ├── auth/                   Atlassian OAuth + i2c credential storage
        ├── api/                    jira.ts + bridge.ts (GAS client)
        ├── background/             service worker + schedulers
        ├── components/             shared UI atoms
        ├── content/                atlas · i2c · jira · koho · ledge · preset · slack · i2cservicedesk · gasBridge
        ├── data/                   detection heuristics + config (move, wires, retention, etc.)
        ├── sidepanel/              React app (workflows + cards + Home view)
        └── styles/                 Mint tokens
```

## Gotchas

- **Extension ID is path-derived.** Chrome computes the ID from the unpacked folder's absolute path. Moving `dist/` = new ID = the Atlassian OAuth callback URL (`https://<ext-id>.chromiumapp.org/`) no longer matches and sign-in breaks. Keep the folder in one place, or re-register the callback URL under the new ID at [developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/).
- **Sign into Okta first.** The Atlassian OAuth flow, Atlas identity lookups, and every other Wealthsimple-domain content script rely on Okta cookies in your normal browser session. If you haven't authenticated Okta on `wealthsimple.atlassian.net` in a normal tab, the extension's browser flows will fall over on a login page.
- **`.env` is git-ignored.** Real Atlassian OAuth CLIENT_ID + CLIENT_SECRET live in 1Password (`WOCOO Triager > Atlassian OAuth 3LO`). Copy to `extension/.env` before your first build; the extension throws at load time if either is missing.
- **Manifest V3 hot-reload is fragile.** Use `npm run build` or `npm run watch` and manually reload the extension in `chrome://extensions` after each rebuild.
- **GAS bridge is a separate project.** Bridge action names in `src/api/bridge.ts` must stay in sync with the deployed Apps Script webapp. If a bridge call times out, first check the deployment is live and the action name matches.

## Related

- [WOCOO Triager PRD](https://docs.google.com/document/d/1WFs_H1904OqiyQHBLNVpcDo1-VGWLaNv4OZ2NCNXhu8/edit) — canonical PRD
- v3 Magic site (predecessor, still runs the Apps Script bridge project): `magic.w10e.com/albert.cai/wocoo-triage-v3`
