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
const SUBJECT_NAME_RE = /^[A-Za-zÀ-ÿ’'.,-]+(?:\s+[A-Za-zÀ-ÿ’'.,-]+){1,3}$/;
/** Outlook embedded-image CIDs look like `image001.jpg@01d54a7.ecf`. */
const IMAGE_CID_RE = /^[^@]+\.(?:jpe?g|png|gif|bmp|tiff?|webp)@/i;
const TLD_RE = /^[a-z]{2,24}$/i;
const CLAIM_RE = /claim\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Z0-9-]{5,})/i;

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitName(raw: string): PersonName | null {
  const clean = raw.replace(/\s+/g, ' ').trim();
  // Exactly one comma: "Last, First [Middle]" (the last name may be several words, e.g. "Lin Tai, Hung").
  const sides = clean.split(',');
  const oneComma = sides.length === 2;
  if (oneComma) {
    const [last, first] = sides.map((x) => x.trim());
    if (last && first) return { first, last, raw: clean };
  }
  const parts = (oneComma ? clean.replace(',', ' ') : clean).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1], raw: clean };
}

const REQUEST_KEYWORD_RE = /eligib|coverage|member\s+(?:coverage\s+)?query|\bclaim\b/i;

/**
 * An insurer email is an eligibility request when its subject or body uses request wording
 * (eligibility / coverage / member query / claim), or when a card last 4 can be found in it.
 */
export function isEligibilityRequest(raw: RawEligibilityEmail): boolean {
  if (REQUEST_KEYWORD_RE.test(raw.subject || '') || REQUEST_KEYWORD_RE.test(raw.plainBody || '')) return true;
  // A terse follow-up ("just checking in on the below") counts when the original request does.
  if (isFollowUp(raw) && REQUEST_KEYWORD_RE.test(raw.originalBody || '')) return true;
  return parseEligibilityThread(raw, []).last4 !== null;
}

/** Same person: first tokens of the first names and the full last names agree after normalisation. */
function sameCardholder(a: PersonName, b: PersonName): boolean {
  const first = (n: PersonName) => normalizeName(n.first).split(' ')[0];
  return first(a) === first(b) && normalizeName(a.last) === normalizeName(b.last);
}

function isFollowUp(raw: RawEligibilityEmail): boolean {
  return raw.messageCount > 1 && !!raw.originalBody;
}

/**
 * Like parseEligibilityEmail, but for a follow-up thread (more than one message, original body
 * supplied) the latest message and the original request are parsed separately and merged: the
 * latest message's values win, the original fills the gaps.
 */
export function parseEligibilityThread(raw: RawEligibilityEmail, excludedDomains: string[]): EligibilityRequest {
  const latest = parseEligibilityEmail(raw, excludedDomains);
  if (!isFollowUp(raw)) return latest;
  const original = parseEligibilityEmail({ ...raw, plainBody: raw.originalBody ?? '' }, excludedDomains);
  const warnings = [...latest.warnings, ...original.warnings];
  if (latest.last4 && original.last4 && latest.last4 !== original.last4) {
    warnings.push(`Follow-up and original email give different last-4 values: ${latest.last4}, ${original.last4}`);
  }
  // An insurer may reuse a thread for another cardholder: never pair the follow-up's person with the
  // original's card. (Both parses share the subject-name fallback, so a subject-only name compares equal.)
  const nameDiffers = !!latest.cardholderName && (!original.cardholderName || !sameCardholder(latest.cardholderName, original.cardholderName));
  if (latest.cardholderName && original.cardholderName && nameDiffers) {
    warnings.push(`Follow-up and original email name different cardholders: ${latest.cardholderName.raw}, ${original.cardholderName.raw}`);
  }
  const ownIdentity = nameDiffers
    || latest.emails.some((e) => !original.emails.includes(e))
    || (!!latest.phone && latest.phone !== original.phone);
  const borrowLast4 = !(ownIdentity && !latest.last4 && original.last4);
  if (!borrowLast4) warnings.push("Follow-up has no card last 4; not borrowing the original email's");
  return {
    ...latest,
    cardholderName: latest.cardholderName ?? original.cardholderName,
    emails: [...new Set([...latest.emails, ...original.emails])],
    phone: latest.phone ?? original.phone,
    last4: latest.last4 ?? (borrowLast4 ? original.last4 : null),
    claimNumber: latest.claimNumber ?? original.claimNumber,
    dateOfLoss: latest.dateOfLoss ?? original.dateOfLoss,
    warnings,
  };
}

/** Drop quoted reply history: everything from quote markers, plus `>` lines. */
function stripQuoted(body: string): string {
  let cut = -1;

  // Single-line Gmail: "On … wrote:"
  const singleLineGmail = body.search(/^On .+wrote:\s*$/m);
  if (singleLineGmail >= 0) cut = singleLineGmail;

  // Multi-line Gmail: "On …\nwrote:"
  if (cut < 0) {
    const multiLineGmail = body.search(/^On .+\nwrote:\s*$/m);
    if (multiLineGmail >= 0) cut = multiLineGmail;
  }

  // Outlook: "-----Original Message-----"
  if (cut < 0) {
    const outlook1 = body.search(/^-{5,}Original Message-{5,}\s*$/m);
    if (outlook1 >= 0) cut = outlook1;
  }

  // Outlook: "From: …" followed by "Sent:" or "Date:"
  if (cut < 0) {
    const outlook2 = body.search(/^From: .+\n(?:Sent|Date):/m);
    if (outlook2 >= 0) cut = outlook2;
  }

  // Forwarded: "---------- Forwarded message"
  if (cut < 0) {
    const forwarded = body.search(/^-{2,}\s*Forwarded message/m);
    if (forwarded >= 0) cut = forwarded;
  }

  const head = cut >= 0 ? body.slice(0, cut) : body;
  return head
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n');
}

/** A list bullet as Outlook / Gmail render it in text/plain (`*   `, `• `, `- `). */
const BULLET = '(?:[-*•·▪◦]\\s*)?';
/** A qualifier some insurers put after the label: "Phone number:", "Email address:", "Phone #:". */
const LABEL_SUFFIX = '(?:\\s*(?:number|no\\.?|#|address))?';

function labelled(body: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp('^\\s*' + BULLET + label.replace(/\s+/g, '\\s*') + LABEL_SUFFIX + '\\s*[:\\-]\\s*(.+)$', 'im');
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

const REQUEST_WORDING_RE = /claim|request|visa|wealthsimple|coverage|confirmation|eligib|query|member/i;

function looksLikeName(s: string): boolean {
  return SUBJECT_NAME_RE.test(s) && s.split(',').length <= 2 && !REQUEST_WORDING_RE.test(s);
}

/** The last name-like " - " segment: "Wealthsimple Coverage Confirmation - Vishal Rajgure - CA0-26-004978". */
function subjectName(subject: string): string | null {
  const segments = subject.split(/\s[-–—]\s/).map((s) => s.trim()).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (looksLikeName(segments[i])) return segments[i];
  }
  return null;
}

/** Unlabelled prose: "We have received a claim for the cardholder listed below: Vishal Rajgure". */
function cardholderPhraseName(body: string): string | null {
  const m = body.match(/\bcard\s*holder\b[^:\n]{0,30}:\s*(.+)$/im);
  const name = m ? m[1].trim() : '';
  return name && looksLikeName(name) ? name : null;
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
    if (IMAGE_CID_RE.test(e) || !TLD_RE.test(domain.split('.').pop() ?? '')) continue;
    if (e === sender || excluded.has(domain) || emails.includes(e)) continue;
    emails.push(e);
  }

  const nameRaw = labelled(body, NAME_LABELS) ?? cardholderPhraseName(body) ?? subjectName(raw.subject || '');
  const cardholderName = nameRaw ? splitName(nameRaw) : null;

  const phoneLabel = labelled(body, PHONE_LABELS);
  const phone = phoneLabel ? normalizePhone(phoneLabel) : null;

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
    ...(raw.priorReplyFromUs === true ? { priorReplyFromUs: true } : {}),
  };
}
