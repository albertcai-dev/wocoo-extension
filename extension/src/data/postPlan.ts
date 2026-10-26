// Post's last check before sending: the reply target is worked out again from fresh comments,
// and a target that differs from what the card showed is never posted to without a second click.

import type { ReplyTarget } from './replyTarget';

export type PostPlan =
  | { kind: 'post'; target: ReplyTarget | null }
  | { kind: 'targetChanged'; target: ReplyTarget | null };

/** `confirmedId`: the target the user has already been shown and clicked Post on again
 *  (its commentId, '' for "new comment"), or null. */
export function planPost(args: { shown: ReplyTarget | null; fresh: ReplyTarget | null; confirmedId: string | null }): PostPlan {
  const freshId = args.fresh?.commentId ?? '';
  const shownId = args.shown?.commentId ?? '';
  if (freshId === shownId || freshId === args.confirmedId) return { kind: 'post', target: args.fresh };
  return { kind: 'targetChanged', target: args.fresh };
}
