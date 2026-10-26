# Sidekick Agent progress card: deploy note

Date: 2026-10-25
Spec: `2026-10-25-sidekick-agent-progress-card-design.md`
Branches: `feat/agent-progress` in `wocoo-draft-agent` (agent) and `wocoo-extension` (extension + native host)

## 1. Merge order

1. **Agent PR first**, into `~/projects/wocoo-draft-agent` (the live checkout launchd runs).
   Before merging or pulling:
   - pause the agent in Sidekick (Settings, Sidekick Agent, untick), and
   - make sure no tick is running: `~/projects/wocoo-draft-agent/state/run.lock` must not
     exist. If it does, wait for the tick to end (it removes the lock).

   The agent change is backwards compatible with the current extension: it only adds store_cli
   commands (`status`, `stage`, `step`, `tick`) and `state/tick.json`.
2. **Extension PR second.** A new host with the old agent is handled (the card hides itself on
   argparse's `invalid choice: 'status'`), but merging the agent first means the card works as
   soon as the extension is reloaded.

## 2. Native host: conflict with `feat/reply-threading`

The live native-host manifest,
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wealthsimple.wocoo_launcher.json`,
points at `/Users/albert.cai/projects/wocoo-extension-reply/native-host/wocoo_launcher.py`. That
is the unmerged `feat/reply-threading` worktree, which adds the `agent_team` action.

Both branches edit the same two places:

- `native-host/wocoo_launcher.py` `DRAFT_ACTIONS`: reply-threading adds `agent_team`, this
  branch adds `agent_status`.
- `extension/src/api/draftStore.ts` `NOT_SET_UP`, the `Unknown action` regex: each adds its own
  action name.

Resolve the conflict by keeping **both** `agent_team` and `agent_status` in each place (and the
dispatch for each in `draft_action`). Then run both branches' host tests:
`python3 -m unittest native-host/test_wocoo_launcher.py`.

Run `native-host/install.sh` **from the main extension checkout (`~/projects/wocoo-extension`)
only, and only after both branches are merged**, never from a worktree. Installing from a
worktree points the manifest at a checkout that will be deleted, and installing before both are
merged drops one of the two actions (Sidekick then shows an error or hides the card).

## 3. Rebuild and reload the extension

```
cd ~/projects/wocoo-extension/extension
npm test && npx tsc -b && npm run build
```

Then reload the unpacked extension in `chrome://extensions` and reopen the side panel.

## 4. Manual check

1. With the agent **running** (and a ticket in progress if possible), open Settings and compare
   the Sidekick Agent card with the mockup
   (`2026-10-25-sidekick-agent-progress-card-mockup.html`): current ticket with system tag,
   checklist, bar and timers ticking each second; Waiting on Compass if any; Up next with tags
   and "+N more".
2. Pause the agent and check the header flips to Paused, the "Finishing KEY, then stopping"
   line (if a ticket was in progress), then the Queued list.
3. In DevTools for the side panel, confirm the native `agent_status` calls (about every 5 s)
   **stop while the panel is hidden** (switch tabs or close the panel) and resume when shown.
