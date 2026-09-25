// Pure draft builders for the i2c copy-paste template and the Koho email.
//
// These moved out of sidepanel/MessagingCards.tsx so they can be unit-tested:
// vitest.config.ts only collects `src/**/*.test.ts`, so nothing in a .tsx is covered.
//
// Templates started as v3's (wocoo-triage-v3 app-core.js) and have since dropped v3's
// internal-metadata header block — the WOCOO link / Work Type / Priority lines were
// noise to the vendor (and the Atlassian link isn't theirs to follow), so that context
// stays in WOCOO.

import type { WocooTicket } from './mockTicket';

/**
 * Drop the "Please see Zendesk Support tab…" pointer Jira descriptions carry.
 *
 * Neither vendor can open our Zendesk, so the line is pure noise outbound. Matching is
 * line-scoped and anchored on "please see … zendesk" rather than any mention of Zendesk,
 * so a sentence that legitimately discusses the Zendesk thread survives.
 */
export function stripZendeskPointer(text: string): string {
  return (text || '')
    .split('\n')
    .filter((line) => !/^\s*[-*•]?\s*please\s+see\b.*\bzendesk\b/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `Client email: …`, or nothing when the ticket has no email — a dangling label is
 *  worse than an absent one, and the Jira field may stop being populated. */
function emailLine(t: WocooTicket): string {
  const email = (t.clientEmail || '').trim();
  return email ? `Client email: ${email}` : '';
}

// i2c reads this as a plain request from a colleague, so the draft is the ticket's own
// wording plus the client email and nothing else.
export function buildI2cDraft(t: WocooTicket): { summary: string; description: string } {
  const body = stripZendeskPointer(t.description || '');
  return {
    summary: t.summary || '',
    description: [body, emailLine(t)].filter(Boolean).join('\n\n'),
  };
}

// Same de-boilerplating as buildI2cDraft. The greeting and sign-off stay: unlike the i2c
// portal form, this one actually goes out as an email.
export function buildKohoDraft(t: WocooTicket): { subject: string; body: string } {
  const details = [stripZendeskPointer(t.description || ''), emailLine(t)]
    .filter(Boolean)
    .join('\n\n');
  return {
    subject: t.summary || 'Prepaid Card Inquiry',
    body:
      'Hi Koho Support team,\n\n' +
      'We have a client inquiry regarding the following:\n\n' +
      details + '\n\n' +
      'Could you please investigate and let us know your findings?\n\n' +
      'Thank you,\nAlbert Cai',
  };
}
