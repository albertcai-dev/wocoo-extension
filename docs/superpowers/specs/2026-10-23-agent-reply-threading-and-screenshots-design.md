# Sidekick Agent: threaded replies and pasted screenshots — design

Date: 2026-10-23

## Why

Albert answers WOCOO tickets from the Sidekick Agent's draft card. Today every
answer lands as a new comment at the bottom of the ticket, even when it answers
one specific comment, usually the CX agent's latest message. In Jira he'd use
**Reply** on that comment, so the answer threads under it and tags the person.
He sees this as the most important improvement.

Separately, he often adds a screenshot under his reply, typically a Preset
dashboard crop showing something the CX agent missed. He can only do that by
editing in Jira; the card has no way to carry an image.

## Goals

1. **Reply to the right comment.** When the draft answers someone's comment,
   both the card's **Post** and the automatic prefill in the Jira tab reply to
   that comment (threaded, with that person tagged) instead of adding a new
   bottom-level comment.
2. **Paste screenshots into the card.** The card's draft box accepts pasted
   images; Post puts them in the same comment, under the text.

## Non-goals

- **Draft length and voice.** Albert is happy with the lessons the agent already
  learns from his edits. No change.
- **The agent learning from screenshots.** They are only added to the comment.
  Nothing is stored or fed back.
- **Attachments other than images** (PDFs, files).
- **Changing who the agent drafts for** or any other agent behaviour beyond what
  the reply rule below needs.

## Anti-goals

- Replying to, or tagging, Albert or his own team on a ticket that's waiting on
  someone else.
- Posting twice, or leaving a half-posted comment (text without its images, or
  images orphaned as attachments) without telling him.
- A reply landing on the wrong comment, quietly.
- Account IDs or colleague names committed to this repo (it is public).

## The reply rule (Albert's, as he stated it)

Walk the ticket's comments **from newest to oldest**. Skip:

- comments by Albert or anyone on his **team**;
- comments by automation and bots, e.g. "Automation for Jira" (Atlas link,
  "ticket received" acknowledgements). *My call: Albert said "the most recent
  person", and a bot isn't one.* Detect them by the author's `accountType`
  (`app` = skip). Service-desk `customer` accounts count as people. *My call:*
  before relying on this, the builder checks recent WOCOO comments for any `app`
  account that posts a person's words (e.g. a sync integration); if one exists,
  stop and bring it back to Albert.

The first comment left is the **reply target**. That can be a CX agent, eng, a
team lead, or anyone else outside the team. The reply threads under it and tags
its author.

**Fallback:** if there are no comments, or every comment is from the team or a
bot, Post and prefill behave exactly as they do today: a normal bottom-level
comment, with whatever mention the draft already has (usually the reporter).

Cases Albert confirmed:

- Brand-new ticket, description only → fallback.
- Newest comment is Albert's (e.g. he asked a question that hasn't been
  answered) → skip it; the target is the outside comment before it.
- Several outside people on the thread → whoever commented most recently.

**The team** is four people, listed by Albert: himself and three colleagues.
Their names go in the draft agent's private config
(`~/projects/wocoo-draft-agent/config.json`, new `team` key). Match them by Jira
account ID, not display name, so renames don't break it. How the extension gets
the list (native host, Settings, or reading account IDs once from ticket people
and storing them in `chrome.storage.local`) is the builder's call, as long as no
IDs or names end up in this repo.

## What's already known (verified 2026-10-22/23)

- **Jira's Reply makes a real thread.** Replies are stored with a `parentId`
  pointing at the comment they answer, and render nested under it. WOCOO already
  has many, e.g. replies under a teammate's comments on WOCOO-30309 and
  WOCOO-30228.
- **Reading comments returns `parentId`.** `GET /rest/api/3/issue/{key}/comment`
  includes `parentId` on threaded replies (seen on WOCOO-29644, -30309, -30228,
  -29525, -29664), listed by creation time like any other comment. The target
  walk and `firstReplyAfterDraft` can use the existing comment fetch.
- **The REST API accepts `parentId`.** `POST /rest/api/3/issue/{key}/comment`
  with `{ body, parentId }` returned 201 with `parentId` set, and the comment
  rendered nested on the page (test on WOCOO-30437, deleted straight after).
  `parentId` is not in Atlassian's published schema, so treat it as undocumented
  and keep a check that the response echoes it back.
- **Sidekick's own OAuth token has `write:jira-work`**, which covers comments and
  attachments. The test used the browser's Jira session; the first build step
  should repeat it once with Sidekick's token (see Testing).
- **Jira's Reply editor** opens inside the target comment
  (`data-testid` `issue-view-activity-comment.comment-reply-editor.reply-editor`,
  inside `…comment-reply-wrapper.reply-container`, inside
  `comment-base-item-<id>`), and Jira pre-inserts an `@mention` of the comment's
  author. Its buttons are `comment-save-button` / `comment-cancel-button`. The
  Reply button is `issue-comment-base.ui.comment.custom-comment.reply-tooltip`.
- **The internal-note property was ignored.** Posting with
  `sd.public.comment: { internal: true }` still produced a public comment, so
  every test post emails the ticket's watchers.
- **Pasted images in Jira comments** are inline `mediaSingle` → `media` nodes
  whose `id` is a Media Services file UUID, not the numeric attachment ID. The
  attachment API (`/rest/api/3/attachment/{id}`) doesn't return that UUID.
- **Current code:** Post calls `postComment` (`api/jira.ts`) with no parent. The
  prefill (`content/jira.ts` + `data/jiraCommentSelectors.ts`) deliberately
  writes only to the bottom "Add a comment" box and refuses any editor inside an
  existing comment item. After a Post, `requestClearPrefill` empties the bottom
  box if it still holds the draft.

## How it should behave

### Card

- Under the draft, a line says who it's replying to, e.g. *"Replying to <name>'s
  comment"*, linked to that comment, or *"New comment"* in the fallback. *My
  call, so he can see the target before posting.*
- The draft box accepts pasted images (clipboard paste of one or more images).
  Each shows as a small thumbnail under the text with an × to remove it.
  Images only; anything else pasted behaves as today.
- Pasted images live only in the card's memory. Closing or reloading the card
  before posting drops them; the text draft persists as it does today.

### Post

1. Re-check for an existing reply from Albert, as today. Also re-compute the
   reply target from fresh comments. **If it differs from the target the card
   showed, don't post:** update the "Replying to" line, say that <name>
   commented since the draft was written, and wait for a second Post click.
   *My call, from the anti-goal "a reply landing on the wrong comment,
   quietly".* (A new outside comment also makes the poll re-queue the ticket, as
   today.)
2. If there are images: upload them as attachments
   (`POST /rest/api/3/issue/{key}/attachments`, multipart,
   `X-Atlassian-Token: no-check`).
3. Post the comment: with `parentId` = the target's id when there is a target,
   and with the images placed **under the text** in the same comment.
4. **Greeting and tag.** Albert's threaded replies open "Hi @Name," like the
   drafts do now (confirmed by Albert). So the posted comment keeps the draft's
   own greeting and adds **no** extra leading mention. If the draft's greeting
   tags someone other than the target (it was written before a new comment
   came in), swap that greeting mention for the target's author. If the draft
   has no mention at all, add "Hi @<target>, " in front. Other mentions further
   in the draft are left alone.
5. Then the existing flow: mark posted, clear the Jira tab's leftover prefill,
   transition, lesson review.

If the target comment has its own `parentId` (it's already a reply inside a
thread), the builder should check what Jira's own Reply does there (reply to the
thread root, or nest under the reply) and do the same.

### Prefill in the Jira tab

- **With a target:** open Reply on the target comment (scroll it into view, click
  its Reply button), wait for the reply editor, **remove Jira's pre-inserted
  mention**, then insert the draft, with the same greeting rule as Post (step 4),
  so the box reads exactly what Post would send. Never click Save.
- The "never write inside an existing comment" guard gets one narrow exception:
  the reply editor inside the **target** comment. Every other existing-comment
  editor stays off-limits.
- **Fallback:** today's behaviour, the bottom "Add a comment" box.
- All existing safety rules still apply (don't steal focus on an automatic
  prefill, don't overwrite a box the user typed in, Insert-draft forces it).
- **After a successful Post:** clear the leftover prefill wherever it is. For a
  reply editor still holding the draft unchanged, cancel it (Cancel button);
  if he's edited it, leave it alone, as today.
- Screenshots are **not** put into the Jira-tab prefill. If Albert finishes in
  Jira he pastes images there himself.

### Things that must not regress

- `checkExistingReply` / `firstReplyAfterDraft` must count Albert's threaded
  replies (comments with a `parentId`) as replies, so a draft he answered via
  Jira's Reply is never offered again.
- The added or Jira-inserted mention of the target must not count as an edit,
  anywhere posted text is compared to the draft: the lesson review
  (`worthReviewing`), and the `posted_text` the card records through
  `recordOutcome` → `store_cli.py` / `src/outcome.py`, which feeds the agent's
  `corrections`. Otherwise every threaded reply looks edited and the agent
  learns a habit that isn't his. *My call:* normalise once in the extension
  before both, and make `outcome.py` tolerant of the same difference for replies
  Albert saves directly in Jira.

## The screenshot route (open: the builder settles it)

Uploading is straightforward; putting the image **inline in the comment body**
is not, because a v3 ADF `media` node needs the Media Services UUID, which the
attachment API doesn't return. Try in this order and keep the first that works:

1. **Find the media UUID for an uploaded attachment** through a supported or
   stable route, then post v3 ADF with `mediaSingle` → `media { type: "file",
   id: <uuid>, collection: "" }` under the text.
2. **v2 comment with wiki markup.** `POST /rest/api/2/issue/{key}/comment` with
   a text body containing `!<filename>|thumbnail!` (or `!<filename>!`) for each
   uploaded attachment, plus `parentId`. Check that the mention, line breaks and
   links still render, and that `parentId` threads.
3. **Page route.** One comment can't be built half by API and half on the page,
   so when there are images the whole Post goes through the Jira tab: open Reply
   on the target (or the bottom box in the fallback), insert the text,
   paste the images into the editor (synthetic paste with `File` objects), click
   Save, then confirm via the API that a comment from Albert with the expected
   `parentId` and media now exists. Only available when a Jira tab shows the
   ticket; otherwise the card says so and doesn't post.

Posts **without** images always use the API route (Goal 1 works with no Jira
tab open).

If none of 1–3 works, stop and bring it back to Albert. Don't silently
downgrade to attachments without the images in the comment.

## Failure handling

- **Upload fails:** nothing is posted; the card shows the error and keeps the
  text and images for Retry.
- **Upload succeeds, comment fails:** the card says the screenshots were
  uploaded to the ticket but the comment wasn't posted. Retry reuses the
  uploaded attachments; it doesn't upload them again.
- **Target comment deleted between load and Post:** recompute; if there's no
  target now, use the fallback and say so on the card.
- **API response lacks `parentId`** when one was sent: show a warning on the card
  that the reply went in as a normal comment. Don't delete or repost.

## Constraints

- Public repo: no **new** names, account IDs, emails or ticket content beyond
  ticket keys in code, tests or docs. (`REIMB_APPROVERS` in `api/jira.ts`
  already holds three, from before this design; out of scope here.)
- Every live test post emails the ticket's watchers (internal notes don't work).
  Ask Albert before each one, use a ticket he names, label the text clearly as a
  test, and delete it right after.
- Builds go to `extension/dist`, which Chrome loads unpacked. After a rebuild,
  Albert has to click reload on `chrome://extensions` and reload Jira tabs.

## Left to the builder

- Where the team list lives for the extension (see "The team"), within the
  no-IDs-in-repo constraint.
- Image size and count limits, thumbnail styling, and how attachments are named.
- The exact wording of the card's "Replying to …" line and error messages.
- How to word the change, but **not whether**: the draft agent's prompt
  (`prompt/draft.md` Step 4, "work out who you are answering") must use the
  same reply-target rule and team list, so the draft greets the person it will
  thread under. This is in scope (agent repo, small prompt change). The card's
  greeting swap in Post step 4 is the safety net for a comment that arrived
  after drafting.

## Testing

- Unit tests for the reply-target rule: empty, team-only, bot-only, newest is
  Albert's, several outsiders, newest outsider is non-CX, target is itself a
  reply.
- Unit tests for the greeting rule (draft greets the target; greets someone
  else; has no mention; Jira's pre-inserted mention removed in prefill) and for
  the edit-comparison normalisation.
- Prefill selector tests in the existing style (`commentPrefill.test.ts`), plus
  the narrow reply-editor exception.
- **Live checks, each approved by Albert first:**
  1. One threaded text reply posted with Sidekick's own token.
  2. The chosen screenshot route, with one image.
  3. A prefill into a real ticket's Reply box, checked on the page, then
     cancelled (no save).
