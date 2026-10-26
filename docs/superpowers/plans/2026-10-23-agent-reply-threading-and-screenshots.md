# Sidekick Agent: threaded replies and pasted screenshots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent draft card's Post and the Jira-tab prefill reply under the right person's comment (threaded, greeted by name), and the card accepts pasted screenshots that land inline under the text of the same comment.

**Architecture:** One pure module (`replyTarget.ts`) decides the reply target and shapes the greeting; every caller (Post, prefill, outcome recording, lesson review) goes through it. Post stays on the REST API, adding `parentId` and, for images, an attachment upload plus an inline-image route chosen by a live spike (Task 6). The team list lives in the private draft agent repo's `config.json` and reaches the extension through a new native-host action.

**Tech Stack:** TypeScript, React, Chrome MV3, Vitest (`extension/`); Python 3 unittest (`native-host/`, `~/projects/wocoo-draft-agent`).

**Spec:** `docs/superpowers/specs/2026-10-23-agent-reply-threading-and-screenshots-design.md`

## Global Constraints

- Public repo (`wocoo-extension`): no **new** names, account IDs, emails or ticket content beyond ticket keys in code, tests or docs. Tests use made-up IDs like `acct-team-1`.
- Team account IDs live only in `~/projects/wocoo-draft-agent/config.json` (key `team`) — that repo is private.
- Every live post emails the ticket's watchers (internal notes don't work). **Ask Albert before each live post**, on a ticket he names, text clearly labelled as a test, deleted straight after.
- Never click Jira's Save in the prefill path; never post twice (keep the existing `checkExistingReplyLive` re-check).
- Build to `extension/dist` (Chrome loads it unpacked). After a rebuild, tell Albert to click reload on `chrome://extensions` and reload Jira tabs.
- Never edit `~/projects/wocoo-draft-agent/run.sh` while a tick is running (not needed by this plan).
- Test commands: extension `cd extension && npx vitest run <file>`; native host `cd native-host && python3 -m unittest test_wocoo_launcher -q`; agent `cd ~/projects/wocoo-draft-agent && python3 -m unittest discover -s tests -q`. Baseline 2026-10-23: 856 / OK / 277, all passing.

## Review Focus

1. **Bot comment that is the newest outside comment** (e.g. "Automation for Jira" acknowledgement right after a CX agent's message) → target is the CX agent, not the bot. Test: Task 1 `skips app accounts`.
2. **Target is itself a reply inside a thread** (`parentId` set) → `parentId` sent is whatever Jira's own Reply sends (decided in Task 6, step 1); test pins it. Test: Task 3 `reply to a reply uses …`.
3. **Comment arrives between card load and Post** → no post on first click, "Replying to" updates, second click posts to the new target. Test: Task 5 `targetChanged`.
4. **Draft greets the reporter but target is someone else** → greeting mention swapped, no double "@Name". Test: Task 1 `swaps greeting mention`.
5. **Upload succeeds, comment fails** → Retry reuses the uploaded attachments. Test: Task 7 `retry reuses uploads`.

---

## File Structure

| File | Repo | Change | Responsibility |
|---|---|---|---|
| `extension/src/data/replyTarget.ts` (+ `.test.ts`) | ext | create | Pure rules: pick target, shape greeting, strip leading mention for comparison |
| `extension/src/api/jira.ts` | ext | modify | `JiraCommentDetail` gains `parentId`, `authorName`, `authorAccountType`; `postComment` gains `parentId`; `uploadAttachments`; inline-image posting |
| `extension/src/api/jiraComments.test.ts` | ext | modify | Tests for the above |
| `extension/src/api/draftStore.ts` (+ test) | ext | modify | `getTeam()` via native host |
| `native-host/wocoo_launcher.py` (+ test) | ext | modify | `agent_team` action |
| `extension/src/data/outcomeCapture.ts`, `agentDraftView.ts`, `draftLessons.ts` (+ tests) | ext | modify | Compare posted text with the reply greeting normalised |
| `extension/src/sidepanel/AgentDraftCard.tsx` | ext | modify | "Replying to" line, target re-check, image paste + thumbnails, Post wiring |
| `extension/src/data/commentPrefill.ts`, `jiraCommentSelectors.ts`, `content/jira.ts` (+ tests) | ext | modify | Prefill into the target's Reply editor; clear it after Post |
| `~/projects/wocoo-draft-agent/config.json`, `src/store_cli.py`, `prompt/draft.md`, `tests/test_store_cli.py`, `tests/test_prompts.py` | agent | modify | `team` key, `team` CLI command, Step 4 uses the reply-target rule |

---

### Task 1: Reply-target and greeting rules (pure)

**Files:**
- Create: `extension/src/data/replyTarget.ts`, `extension/src/data/replyTarget.test.ts`
- Modify: `extension/src/api/jira.ts` (`JiraCommentDetail` interface ~L1211, `getIssueCommentsDetailed` ~L1261), `extension/src/api/jiraComments.test.ts`

**Interfaces:**
- Produces:
  - `JiraCommentDetail` adds `parentId: string | null; authorName: string; authorAccountType: string` (from `parentId`, `author.displayName`, `author.accountType`; missing → `null` / `''` / `''`).
  - `interface ReplyTarget { commentId: string; parentId: string | null; accountId: string; name: string }`
  - `pickReplyTarget(comments: JiraCommentDetail[], team: ReadonlySet<string>): ReplyTarget | null` — comments oldest-first in, walks newest→oldest, skips `team.has(authorAccountId)` and `authorAccountType === 'app'`; returns first remaining or `null`.
  - `greetTarget(segments: DraftSegment[], target: ReplyTarget): DraftSegment[]`
  - `stripReplyGreeting(text: string, targetName: string | null): string` — removes one leading `@<targetName>` (with optional following comma/space) for comparison only.

- [ ] **Step 1: Write failing tests** in `replyTarget.test.ts` (made-up IDs only):
  - `returns null for no comments` · `returns null when only team and app comments` · `skips the newest comment when it is the team's (Albert's question)` → target is the outside comment before it · `skips app accounts` (`authorAccountType: 'app'`) · `picks the most recent of several outsiders` · `a non-CX outsider still counts` · `customer accounts count as people` (`authorAccountType: 'customer'`).
  - `greetTarget`: `keeps a greeting that already tags the target` (segments `["Hi ", @T, ", I checked"]` unchanged) · `swaps greeting mention` (`["Hi ", @Reporter, ", …"]` → `["Hi ", @T, ", …"]`, mention carries `accountId` of T) · `adds a greeting when there is no mention` (`["I checked"]` → `["Hi ", @T, ", ", "I checked"]`) · `leaves later mentions alone` (a mention after the first sentence isn't touched).
  - The "greeting mention" is the first `mention` segment when every segment before it is `text` whose joined content matches `/^\s*(hi|hey|hello)?\s*$/i`. Otherwise the draft has no greeting mention.
  - `stripReplyGreeting`: `"@Jenn Hi, x"` with `Jenn` → `"Hi, x"`; `"Hi @Jenn, x"` unchanged; `null` name → unchanged.
  - In `jiraComments.test.ts`: `maps parentId, author name and account type` (raw `parentId: 6736037` → `'6736037'`; absent → `null`).
- [ ] **Step 2: Run** `npx vitest run src/data/replyTarget.test.ts src/api/jiraComments.test.ts` → FAIL (module missing / fields missing). Existing `maps ADF comments to detail rows` must be updated to expect the new fields.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command → PASS; then `npx vitest run` → all pass.
- [ ] **Step 5: Commit** `feat(agent-card): reply-target and greeting rules`

---

### Task 2: Team list from the private agent repo

**Files:**
- Modify: `~/projects/wocoo-draft-agent/config.json`, `src/store_cli.py`, `tests/test_store_cli.py`
- Modify: `native-host/wocoo_launcher.py`, `native-host/test_wocoo_launcher.py`
- Modify: `extension/src/api/draftStore.ts`, `extension/src/api/draftStore.test.ts`

**Interfaces:**
- Produces:
  - `config.json` key `"team": [{"name": "...", "account_id": "..."}]` — four people (Albert + three colleagues). Fill in by reading account IDs from WOCOO comments via `GET /rest/api/3/issue/{key}/comment` on tickets they commented on; **show Albert the four names + IDs and get a yes before saving.**
  - `store_cli.py team` → `{"team": ["<account_id>", ...]}` (IDs only).
  - Native host action `agent_team` → `{"ok": true, "team": [...]}`; add to `DRAFT_ACTIONS`.
  - `getTeam(): Promise<Set<string>>` in `draftStore.ts`, cached for the panel's lifetime. On failure throws `DraftStoreUnavailable` (callers fall back — see Task 5).

- [ ] **Step 1: Failing tests:** agent `test_team_returns_ids_only` (config with two entries → `{"team": ["a1","a2"]}`) and `test_team_missing_key_is_empty`; native host `test_agent_team_shells_to_store_cli`; extension `getTeam returns a set and caches` (one native call for two `getTeam()` calls).
- [ ] **Step 2: Run** the three suites → the new tests FAIL.
- [ ] **Step 3: Implement**, including the `config.json` entry after Albert confirms it.
- [ ] **Step 4: Run** all three suites → PASS.
- [ ] **Step 5: Commit** in each repo: agent `feat: team list for reply targeting`; extension `feat(native-host): agent_team action`.
- [ ] **Step 6:** Tell Albert to re-run `native-host/install.sh` (pending from 2026-10-20 anyway) so Chrome gets the new host.
- [ ] **Step 7: Bot check (read-only).** Over the last 30 days of WOCOO comments, list every author with `accountType: 'app'` and a sample of their text. If any app account posts a person's own words (e.g. a Zendesk sync), **stop and bring it to Albert** before Task 5; skipping `app` accounts would then hide real people.

---

### Task 3: Post as a threaded reply (text only)

**Files:**
- Modify: `extension/src/api/jira.ts` (`postComment` ~L622), `extension/src/api/jiraComments.test.ts`

**Interfaces:**
- Consumes: `ReplyTarget` (Task 1).
- Produces: `postComment(ticketKey: string, segments: CommentSegment[], opts?: { multiline?: boolean; parentId?: string }): Promise<{ id: string; parentId: string | null }>` — sends `parentId` as a **number** when given (that's what the 2026-10-23 test sent and Jira echoed). Returns the created comment's `id` and echoed `parentId`. Existing callers ignore the return value.
- Produces: `replyParentId(target: ReplyTarget): string` in `replyTarget.ts` — the `parentId` to send (decided in Task 6 step 1; until then returns `target.commentId`).

- [ ] **Step 1: Failing tests:** `postComment sends parentId as a number` (request body has `parentId: 6736037`) · `postComment without parentId sends no parentId key` · `returns echoed parentId` · `reply to a reply uses replyParentId` (placeholder expectation `commentId`; Task 6 updates it if Jira does otherwise).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS, full suite PASS.
- [ ] **Step 5: Commit** `feat(jira): postComment can reply under a comment`

---

### Task 4: Normalise the greeting wherever posted text is compared

**Files:**
- Modify: `extension/src/data/outcomeCapture.ts` (`firstReplyAfterDraft` ~L20, `buildJiraOutcomeRow` ~L37), `extension/src/data/agentDraftView.ts` (`buildOutcomeRow` ~L82), `extension/src/data/draftLessons.ts` (`worthReviewing` ~L23) and their tests.

**Interfaces:**
- Consumes: `stripReplyGreeting` (Task 1).
- Produces: `buildOutcomeRow(..., opts: { via?; assignedAt?; replyTargetName?: string | null })` and `buildJiraOutcomeRow(..., replyTargetName?: string | null)` both store `posted_text` with `stripReplyGreeting` applied. `worthReviewing(draft, posted, replyTargetName?: string | null)`.
- No change in `~/projects/wocoo-draft-agent/src/outcome.py`: every outcome row is built by these two functions, so cleaning here covers the agent's `corrections` too. *(The spec suggested also loosening `outcome.py`; not needed — note this in the commit message.)*

- [ ] **Step 1: Failing tests:** `firstReplyAfterDraft counts a threaded reply` (Albert's comment with `parentId` set after the draft is returned) · `jira outcome row strips Jira's leading mention` (posted `"@Jenn Hi @Jenn, ok"`, name `Jenn` → `"Hi @Jenn, ok"`) · `worthReviewing ignores the reply greeting` (draft `"Hi @Jenn, ok"`, posted `"@Jenn Hi @Jenn, ok"` → `false`).
- [ ] **Step 2: Run** → the new tests FAIL (threaded-reply test may already pass; keep it as a guard).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS, full suite PASS.
- [ ] **Step 5: Commit** `fix(outcomes): reply greeting isn't an edit`

---

### Task 5: Card — "Replying to" line, target re-check, Post wiring (text)

**Files:**
- Modify: `extension/src/sidepanel/AgentDraftCard.tsx`
- Create: `extension/src/data/postPlan.ts`, `extension/src/data/postPlan.test.ts` (keeps the decision testable outside React)

**Interfaces:**
- Consumes: `pickReplyTarget`, `greetTarget`, `replyParentId` (Tasks 1, 3), `getTeam` (Task 2), `postComment` (Task 3), Task 4 opts.
- Produces: `planPost(args: { shown: ReplyTarget | null; fresh: ReplyTarget | null; confirmedId: string | null }): { kind: 'post'; target: ReplyTarget | null } | { kind: 'targetChanged'; target: ReplyTarget | null }` — returns `targetChanged` when `fresh?.commentId !== shown?.commentId` and `fresh?.commentId !== confirmedId`.
- Card behaviour:
  - On mount (alongside the existing gate check) compute the target from `checkExistingReplyLive(...).comments` and `getTeam()`. Show under the draft: `Replying to <name>'s comment` linked to `<ticket url>?focusedCommentId=<commentId>`, or `New comment`. If `getTeam()` fails, show `New comment` and a small note `Couldn't load your team list, so this posts as a new comment.` — never guess a target without the team list.
  - On Post: after the existing reply re-check, recompute; `planPost` → on `targetChanged`, update the line, set `confirmedId`, stop, and show `<name> commented since this draft was written. Post again to reply to them.` — or, when the new target is `null` (the comment was deleted), `The comment this was replying to is gone. Post again to send it as a new comment.` On `post`: `postComment(ticket.id, target ? greetTarget(segments, target) : segments, { multiline: true, parentId: target ? replyParentId(target) : undefined })`. If a `parentId` was sent and the response's `parentId` is `null`, show the warning `Posted, but Jira didn't thread it: it went in as a normal comment.` and carry on (don't delete or repost).
  - Pass `replyTargetName` into `buildOutcomeRow`, `buildJiraOutcomeRow` and `worthReviewing`.

- [ ] **Step 1: Failing tests** for `planPost`: `same target posts` · `targetChanged when a new outsider commented` · `second click with confirmed target posts` · `null to target counts as changed` · `target to null counts as changed`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `planPost` and the card wiring.
- [ ] **Step 4: Run** `npx vitest run` → PASS; `npm run build` (from `extension/`) → no type errors.
- [ ] **Step 5: Live check — ask Albert first.** Build to `dist`, have him reload the extension, then on a ticket he names: Post a reply labelled `[Test by Albert, deleting now — please ignore]`. Verify via `GET …/comment` that the new comment has the expected `parentId` and starts with `Hi @<target>`; delete it (`DELETE …/comment/<id>`); confirm deletion. Report to Albert.
- [ ] **Step 6: Commit** `feat(agent-card): post replies under the right comment`

---

### Task 6: Screenshot route spike (live, throwaway)

Decides two open points. Code from this task is throwaway; only the decision and any test-pinned constants are kept.

**Files:** none kept except a note appended to the spec under "The screenshot route": `Chosen route (2026-10-…): <1|2|3>, because …` and the reply-to-a-reply finding.

- [ ] **Step 1: Reply to a reply.** On a WOCOO ticket that already has a threaded reply (e.g. WOCOO-30309), open Jira's Reply on the *reply* comment in the page and read (without saving) what the reply editor's container ties it to; if unclear, ask Albert before a live post to see the stored `parentId`. Update `replyParentId` + its Task 3 test to match. Commit `fix(jira): reply-to-reply parent matches Jira`.
- [ ] **Step 2: Route 1 — media UUID.** With one throwaway attachment on a ticket Albert names (ask first), look for a stable way to get its Media Services file UUID (attachment `content`/`thumbnail` redirects, the issue's `renderedFields`, or the media API the page itself calls). Works if a v3 comment with `mediaSingle → media{type:'file', id:<uuid>, collection:''}` renders the image inline.
- [ ] **Step 3: Route 2 — v2 wiki markup** (only if Route 1 fails). Post via `POST /rest/api/2/issue/{key}/comment` with `[~accountid:<id>]` mention, text, `!<filename>|thumbnail!`, and `parentId`. Works if it threads, the mention renders as a pill, and the image renders inline.
- [ ] **Step 4: Route 3 — page route** (only if 1 and 2 fail). Confirm a synthetic paste of a `File` into the Reply editor uploads and shows the image (no Save).
- [ ] **Step 5:** Delete every test comment and attachment; confirm via API. Record the chosen route in the spec. If none works, **stop and bring it to Albert.**

---

### Task 7: Card — paste screenshots, post them inline

**Files:**
- Modify: `extension/src/api/jira.ts` (+ test), `extension/src/sidepanel/AgentDraftCard.tsx`
- Create: `extension/src/data/pastedImages.ts`, `extension/src/data/pastedImages.test.ts`

**Interfaces:**
- Consumes: the route chosen in Task 6; `postComment` (Task 3).
- Produces:
  - `uploadAttachments(ticketKey: string, files: File[]): Promise<Array<{ id: string; filename: string }>>` — multipart `POST /rest/api/3/issue/{key}/attachments`, header `X-Atlassian-Token: no-check`.
  - `imagesFromClipboard(e: ClipboardEvent | React.ClipboardEvent): File[]` — `image/*` items only; non-images return `[]` so normal text paste is untouched.
  - One posting function for the chosen route, e.g. `postCommentWithImages(ticketKey, segments, uploads, opts)` (Route 1/2) or a content-script message (Route 3), returning the same `{ id, parentId }` shape as `postComment`.
- Card: images held in component state only (`File[]` + object URLs, revoked on unmount/remove). Thumbnails under the textarea, each with an × button. Posts with no images use Task 5's path unchanged. Retry after "upload ok, comment failed" reuses the stored uploads (no second upload). Errors:
  - upload failed: `Couldn't upload the screenshots, so nothing was posted: <error>`
  - comment failed after upload: `The screenshots were uploaded to the ticket, but the comment wasn't posted: <error>. Retry won't upload them again.`
- Route 3 only: if no Jira tab shows the ticket, disable Post while images are attached with `Open this ticket in Jira to post screenshots.`

- [ ] **Step 1: Failing tests:** `imagesFromClipboard keeps only images` · `imagesFromClipboard returns [] for text` · `uploadAttachments sends multipart with no-check header` · `retry reuses uploads` (post-plan helper: given stored uploads, the retry path calls the comment poster and not the uploader) · route test(s) pinning the body shape chosen in Task 6 (e.g. ADF has text paragraphs then `mediaSingle` nodes in order, with `parentId`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` → PASS; `npm run build` → OK.
- [ ] **Step 5: Live check — ask Albert first.** One threaded reply with one pasted image on his chosen ticket; verify it threads, greets the target, and the image renders inline under the text; delete comment and attachment; confirm.
- [ ] **Step 6: Commit** `feat(agent-card): paste screenshots into the draft`

---

### Task 8: Prefill into the target's Reply box

**Files:**
- Modify: `extension/src/data/jiraCommentSelectors.ts`, `extension/src/data/commentPrefill.ts` (+ `commentPrefill.test.ts`), `extension/src/content/jira.ts`, `extension/src/sidepanel/AgentDraftCard.tsx`

**Interfaces:**
- Consumes: `ReplyTarget`, `greetTarget` (Task 1).
- Produces:
  - `PrefillCommentMessage` and `ClearPrefillMessage` gain `replyTo?: { commentId: string }`. Card sends `greetTarget(segments, target)` and `replyTo` when there's a target; otherwise unchanged messages.
  - Selectors (verified live 2026-10-23): `replyButton: '[data-testid="issue-comment-base.ui.comment.custom-comment.reply-tooltip"]'`, `replyContainer: '[data-testid="issue-view-activity-comment.comment-reply-wrapper.reply-container"]'`, `replyEditor: '[data-testid="issue-view-activity-comment.comment-reply-editor.reply-editor"]'`, comment item `[data-testid="comment-base-item-<id>"]`, cancel `[data-testid="comment-cancel-button"]`.
  - Pure helper `stripLeadingMention(editorText: string): ...` or equivalent DOM step: after Reply opens, delete Jira's pre-inserted mention node (first `[data-mention-id]` at the start of the reply editor) before inserting, so the box reads exactly what Post would send.
  - Content script: with `replyTo`, scroll `comment-base-item-<id>` into view, click its Reply button via `el.click()` (background-tab clicks need it), wait ≤5 s for the reply editor **inside that item**, strip the mention, insert with the existing paste path. The `insideExistingComment` guard gets one exception: the reply editor inside `comment-base-item-<replyTo.commentId>`. Every other existing-comment editor stays off-limits. Never click Save.
  - Clear after Post: with `replyTo`, look in that item's reply editor; if `boxHoldsDraft`, click its Cancel; else leave it.
  - Screenshots are never sent in prefill messages.

- [ ] **Step 1: Failing tests** in `commentPrefill.test.ts`: `reply editor inside the target item is allowed` · `reply editor inside another comment is refused` · `bottom box still used when replyTo is absent` · `leading mention removed before insert` · `boxHoldsDraft matches a reply box holding the greeted draft`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` → PASS; `npm run build` → OK.
- [ ] **Step 5: Live check (no posting).** Albert reloads the extension; open a ticket with a pending draft and an outside comment; confirm the target's Reply box opens with `Hi @<target>, …` and no doubled mention, and the bottom box stays empty; click Cancel. Then check a ticket with no outside comment still prefills the bottom box.
- [ ] **Step 6: Commit** `feat(prefill): fill the target comment's Reply box`

---

### Task 9: Agent drafts greet the reply target

**Files:**
- Modify: `~/projects/wocoo-draft-agent/prompt/draft.md` (Step 4 ~L242, Step 3 ~L238), `tests/test_prompts.py`

**Interfaces:**
- Consumes: `python3 src/store_cli.py team` (Task 2). Add it to the prompt's `allowed-tools` line if Bash is narrowed there (`test_bash_is_narrowed_and_covers_every_command` will fail otherwise).
- Produces: Step 4 text, replacing "normally the reporter, or the last person (not Albert, not `Automation for Jira`) who asked something":
  > Work out who you are answering: walk the comments from newest to oldest, skip anyone in `store_cli.py team` and any automation/bot account, and answer the first person left. If nobody is left, answer the reporter. Open with "Hi " + an @mention of that person, as Albert does in threaded replies.
  - Remove the conflicting line at ~L715 ("Use an @mention segment only if his replies on similar tickets mention the person") or narrow it to mentions after the greeting.

- [ ] **Step 1: Failing test** in `test_prompts.py`: `test_draft_prompt_answers_reply_target` asserts `draft.md` contains `store_cli.py team` and `newest to oldest`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_prompts -q` → FAIL.
- [ ] **Step 3: Edit the prompt.**
- [ ] **Step 4: Run** the full agent suite → OK.
- [ ] **Step 5: Commit** in the agent repo `prompt: drafts greet the comment they'll reply under`

---

### Task 10: Wrap-up

- [ ] **Step 1:** Full suites in all three places pass; `npm run build` writes `extension/dist`.
- [ ] **Step 2:** Tell Albert: reload the extension on `chrome://extensions`, reload Jira tabs, re-run `native-host/install.sh` if not done in Task 2.
- [ ] **Step 3:** Update memory `WOCOO Draft Agent.md` with: reply rule + team list location, `parentId` behaviour, chosen screenshot route, internal-note gotcha.
- [ ] **Step 4:** Use superpowers:finishing-a-development-branch.
