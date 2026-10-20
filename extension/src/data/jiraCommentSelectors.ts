// DOM hooks the Jira content script's comment prefill relies on (see content/jira.ts). Kept in
// their own module so they can be adjusted against the live page, and unit-tested, without
// loading the content script.

/** Every DOM hook the prefill relies on, in one place so they can be adjusted against the live
 *  Jira page. Lists are tried in order. ALL ARE UNVERIFIED GUESSES until the live check. */
export const JIRA_COMMENT_SELECTORS = {
  /** The collapsed "Add a comment…" box shown before the new-comment editor is mounted. */
  placeholder: [
    '[data-testid="canned-comments.common.ui.comment-text-area-placeholder.textarea"]',
    '[data-testid*="comment-text-area-placeholder" i]',
    'textarea[placeholder^="Add a comment" i]',
    '[role="button"][aria-label^="Add a comment" i]',
  ],
  /** Text-content fallback for the placeholder when no selector above matches. */
  placeholderText: /^add a comment/i,
  /** Elements whose own text/placeholder/aria-label is checked against placeholderText. */
  placeholderTextCandidates: 'button, [role="button"], textarea, input, div[tabindex]',
  /** The new-comment container: wraps the placeholder and, once clicked, the new-comment editor.
   *  Only an editor inside one of these is ever written to. */
  newCommentContainer: [
    '[data-testid="issue.activity.comment.add-comment"]',
    '[data-testid*="add-comment" i]',
    '[data-testid*="addcomment" i]',
    '[data-testid*="new-comment" i]',
  ],
  /** An existing comment item (its Edit/Delete or, while editing, Save/Cancel belong to a posted
   *  comment). An editor with one of these between it and the container is never used. */
  existingCommentItem: [
    '[data-testid^="comment-base-item-" i]',
    '[data-testid*="comment-item" i]',
    '[data-testid*="edit-comment" i]',
  ],
  /** Markers only a posted comment carries (its permalink / timestamp). An ancestor holding one
   *  of these, below the container, is treated as an existing comment item. */
  existingCommentMarkers: 'a[href*="focusedCommentId"], time',
  /** Element ids of posted comments ("comment-12345"). */
  existingCommentId: /^comment-\d+$/,
  /** The ProseMirror contenteditable of an Atlassian editor. */
  editor: [
    '.ProseMirror[contenteditable="true"]',
    '#ak-editor-textarea[contenteditable="true"]',
  ],
  /** Editor decorations whose text is not the user's (placeholder hints, widgets, PM separators). */
  decorations: '.placeholder-decoration, .ProseMirror-widget, .ProseMirror-separator, [data-testid="placeholder-test-id"]',
  /** Non-text content that makes the box "not empty": images, media, emoji, mentions, any ADF node view. */
  contentNodes: 'img, [data-node-type], [data-mention-id], [data-emoji-id], [data-emoji-short-name], .mediaSingleView-content-wrap, .mediaView-content-wrap, .emojiView-content-wrap',
  /** Typeahead-specific popup. Also the ONLY selectors that allow the dismissing Escape. */
  typeaheadPopup: [
    '[data-testid="typeahead-popup"]',
    '[data-testid*="typeahead" i]',
    '[aria-label*="typeahead" i]',
  ],
  /** Where to look for the mention option: typeahead popups only. A bare [role="listbox"] is not
   *  a scope, so an unrelated open listbox (a field dropdown, a user picker) is never clicked. */
  mentionOptionScopes: [
    '[data-testid="typeahead-popup"]',
    '[data-testid*="typeahead" i]',
    '[aria-label*="typeahead" i]',
  ],
  /** Attributes on a typeahead option (or its descendant) that carry the user's accountId. */
  mentionIdAttributes: ['data-mention-id', 'data-id'],
  /** Click target around a matched element. */
  mentionOption: '[role="option"], [data-testid*="typeahead-item" i]',
  /** A mention pill inside the editor (used to confirm a pick landed). */
  insertedMention: '[data-mention-id]',
} as const;
