// Parses one insurer eligibility-confirmation email into the fields the resolver needs.
// Pure: no chrome.*, no DOM. Spec section "2. Parser".

import type { EligibilityRequest, PersonName, RawEligibilityEmail } from './eligibilityTypes';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NAME_LABELS = ['Cardholder Name', 'Card Holder Name', 'Cardholder', 'Card Holder', 'Insured', 'Claimant', 'Name'];
const PHONE_LABELS = ['Phone', 'Telephone', 'Tel', 'Cell', 'Mobile'];
const DOL_LABELS = ['DOL', 'Date of Loss'];
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const LAST4_PATTERNS: RegExp[] = [
  /last\s*(?:4|four)\s*(?:digits)?(?:\s*of\s*the\s*card)?\s*(?:is|are|:|-|–)?\s*(\d{4})\b/gi,
  /ending\s+(?:in|with)\s+(\d{4})\b/gi,
  /\d{4,6}[*xX•]{3,}(\d{4})\b/g,
  /[*xX•]{4,}\s?(\d{4})\b/g,
];
const SUBJECT_NAME_RE = /^[A-Za-zÀ-ÿ''.-]+(?:\s+[A-Za-zÀ-ÿ''.-]+){1,3}$/;
const CLAIM_RE = /claim\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Z0-9-]{5,})/i;

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[']/g, "'")
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitName(raw: string): PersonName | null {
  const clean = raw.replace(/\s+/g, ' ').trim();
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1], raw: clean };
}

/** Drop quoted reply history: everything from an "On … wrote:" line, plus `>` lines. */
function stripQuoted(body: string): string {
  const cut = body.search(/^On .+wrote:\s*$/m);
  const head = cut >= 0 ? body.slice(0, cut) : body;
  return head
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n');
}

function labelled(body: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp('^\\s*' + label.replace(/\s+/g, '\\s*') + '\\s*[:\\-]\\s*(.+)$', 'im');
    const m = body.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function normalizePhone(s: string): string | null {
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

function findLast4s(text: string): string[] {
  const seen: string[] = [];
  for (const re of LAST4_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!seen.includes(m[1])) seen.push(m[1]);
    }
  }
  return seen;
}

function subjectName(subject: string): string | null {
  const segments = subject.split(/\s[-–—]\s/).map((s) => s.trim()).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && SUBJECT_NAME_RE.test(last) && !/claim|request|visa|wealthsimple/i.test(last) ? last : null;
}

function senderName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}

export function parseEligibilityEmail(raw: RawEligibilityEmail, excludedDomains: string[]): EligibilityRequest {
  const body = stripQuoted(raw.plainBody || '');
  const warnings: string[] = [];
  const excluded = new Set(excludedDomains.map((d) => d.toLowerCase()));
  const sender = raw.fromEmail.toLowerCase();

  // Emails: the labelled Email line first (it may list several), then the rest of the body.
  const emailLine = labelled(body, ['E-mail', 'Email Address', 'Email']) ?? '';
  const ordered = [...(emailLine.match(EMAIL_RE) ?? []), ...(body.match(EMAIL_RE) ?? [])];
  const emails: string[] = [];
  for (const e of ordered.map((x) => x.toLowerCase())) {
    const domain = e.split('@')[1] ?? '';
    if (e === sender || excluded.has(domain) || emails.includes(e)) continue;
    emails.push(e);
  }

  const nameRaw = labelled(body, NAME_LABELS) ?? subjectName(raw.subject || '');
  const cardholderName = nameRaw ? splitName(nameRaw) : null;

  const phoneLabel = labelled(body, PHONE_LABELS);
  const phoneMatch = (phoneLabel ?? '').match(PHONE_RE) ?? body.match(PHONE_RE);
  const phone = phoneLabel ? normalizePhone(phoneLabel) : phoneMatch ? normalizePhone(phoneMatch[0]) : null;

  const last4s = findLast4s(body);
  if (last4s.length > 1) warnings.push('Multiple last-4 values found: ' + last4s.join(', '));

  const claim = (raw.subject || '').match(CLAIM_RE) ?? body.match(CLAIM_RE);

  return {
    threadId: raw.threadId,
    messageId: raw.messageId,
    insurerEmail: sender,
    insurerName: senderName(raw.from),
    subject: raw.subject,
    receivedAt: raw.date,
    messageCount: raw.messageCount,
    cardholderName,
    emails,
    phone,
    last4: last4s[0] ?? null,
    claimNumber: claim ? claim[1] : null,
    dateOfLoss: labelled(body, DOL_LABELS),
    warnings,
  };
}
