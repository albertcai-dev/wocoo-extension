import { describe, expect, it } from 'vitest';
import { isEligibilityRequest, normalizeName, parseEligibilityEmail, splitName } from './eligibilityParse';
import type { RawEligibilityEmail } from './eligibilityTypes';

function raw(over: Partial<RawEligibilityEmail>): RawEligibilityEmail {
  return {
    threadId: 't1',
    messageId: 'm1',
    from: 'Jane Adjuster <jane.adjuster@claims-co.example>',
    fromEmail: 'jane.adjuster@claims-co.example',
    subject: 'Eligibility Confirmation Request',
    date: '2026-10-02T17:08:00.000Z',
    messageCount: 1,
    plainBody: '',
    ...over,
  };
}

const EXCLUDED = ['claims-co.example', 'wealthsimple.com'];

const LABELLED = `Hello Team,

We are in receipt of a claim for a Wealthsimple Visa Infinite cardholder ending in the last 4 digits - 1763

Cardholder:  Priya Ramanathan
Email: wrong.address@example.com; priya.r1985@example.com
Phone: 416-555-0142
DOL: August 15, 2026

Please confirm the following:
Jane Adjuster
Claims Adjudicator
jane.adjuster@claims-co.example
`;

describe('normalizeName', () => {
  it('lowercases, strips accents and punctuation, collapses spaces', () => {
    expect(normalizeName("  Zoë  O'Neil ")).toBe("zoe o'neil");
    expect(normalizeName('Jean-François')).toBe('jean-francois');
    expect(normalizeName('Dr. Ana')).toBe('dr ana');
  });

  it('converts curly apostrophes to straight ones', () => {
    expect(normalizeName('Zoë O’Neil')).toBe("zoe o'neil");
  });
});

describe('splitName', () => {
  it('uses the last token as the last name', () => {
    expect(splitName('Mary Ann Smith')).toEqual({ first: 'Mary Ann', last: 'Smith', raw: 'Mary Ann Smith' });
  });
  it('returns null for a single token', () => {
    expect(splitName('Priya')).toBeNull();
  });
  it('reads a single comma as "Last, First"', () => {
    expect(splitName('Keiwan, Isaac')).toEqual({ first: 'Isaac', last: 'Keiwan', raw: 'Keiwan, Isaac' });
  });
  it('keeps a multi-word last name before the comma', () => {
    expect(splitName('Lin Tai, Hung')).toEqual({ first: 'Hung', last: 'Lin Tai', raw: 'Lin Tai, Hung' });
  });
  it('keeps middle names after the comma in first', () => {
    expect(splitName('Smith, Mary Ann')).toEqual({ first: 'Mary Ann', last: 'Smith', raw: 'Smith, Mary Ann' });
  });
  it('falls back to the comma-stripped string when a side is empty', () => {
    expect(splitName('Mary Smith,')).toEqual({ first: 'Mary', last: 'Smith', raw: 'Mary Smith,' });
    expect(splitName(', Priya')).toBeNull();
  });
  it('does not treat two commas as Last, First', () => {
    expect(splitName('Smith, Mary, Ann')).toEqual({ first: 'Smith, Mary,', last: 'Ann', raw: 'Smith, Mary, Ann' });
  });
});

describe('isEligibilityRequest', () => {
  it('matches on the subject alone', () => {
    expect(isEligibilityRequest(raw({ subject: 'Eligibility Confirmation Request', plainBody: 'Hello' }))).toBe(true);
  });
  it('matches on the body alone', () => {
    expect(isEligibilityRequest(raw({ subject: 'Claim 123456', plainBody: 'Please confirm eligibility for this card.' }))).toBe(true);
  });
  it('is false when neither mentions eligibility', () => {
    expect(isEligibilityRequest(raw({ subject: 'Claim 123456 - Update', plainBody: 'Please call us back.' }))).toBe(false);
  });
});

describe('parseEligibilityEmail', () => {
  it('reads every labelled field and keeps all client emails in order', () => {
    const r = parseEligibilityEmail(raw({ plainBody: LABELLED }), EXCLUDED);
    expect(r.cardholderName).toEqual({ first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' });
    expect(r.emails).toEqual(['wrong.address@example.com', 'priya.r1985@example.com']);
    expect(r.phone).toBe('4165550142');
    expect(r.last4).toBe('1763');
    expect(r.dateOfLoss).toBe('August 15, 2026');
    expect(r.insurerEmail).toBe('jane.adjuster@claims-co.example');
    expect(r.insurerName).toBe('Jane Adjuster');
    expect(r.warnings).toEqual([]);
  });

  it('takes the cardholder name and claim number from the subject when the body has no label', () => {
    const r = parseEligibilityEmail(
      raw({
        subject: 'Eligibility Confirmation Request – Wealthsimple Visa Infinite - EM Claim 4148347 - Priya Ramanathan',
        plainBody: 'Card ending in 1763. Email: priya.r1985@example.com',
      }),
      EXCLUDED,
    );
    expect(r.cardholderName?.raw).toBe('Priya Ramanathan');
    expect(r.claimNumber).toBe('4148347');
    expect(r.last4).toBe('1763');
  });

  it('reads masked card numbers', () => {
    const r = parseEligibilityEmail(raw({ plainBody: 'Card: 412650******0042' }), EXCLUDED);
    expect(r.last4).toBe('0042');
  });

  it('returns null last4 when none is present', () => {
    const r = parseEligibilityEmail(raw({ plainBody: 'Cardholder: Priya Ramanathan' }), EXCLUDED);
    expect(r.last4).toBeNull();
  });

  it('warns when two different last-4 values appear', () => {
    const r = parseEligibilityEmail(
      raw({ plainBody: 'last 4 digits - 1763\nPrevious card ending in 9921' }),
      EXCLUDED,
    );
    expect(r.last4).toBe('1763');
    expect(r.warnings).toEqual(['Multiple last-4 values found: 1763, 9921']);
  });

  it('ignores quoted reply text, insurer domains and wealthsimple.com', () => {
    const body = `Cardholder: Priya Ramanathan
Email: priya.r1985@example.com
last 4 digits - 1763

On Mon, Sep 29, 2026 at 9:00 AM Credit Card Operations <creditcardoperations@wealthsimple.com> wrote:
> Here are the requested details for client someone.else@example.com:
> • Last 4 digits of card: 5555
`;
    const r = parseEligibilityEmail(raw({ plainBody: body }), EXCLUDED);
    expect(r.emails).toEqual(['priya.r1985@example.com']);
    expect(r.last4).toBe('1763');
    expect(r.warnings).toEqual([]);
  });

  it('strips a leading 1 from an 11-digit phone and rejects short numbers', () => {
    expect(parseEligibilityEmail(raw({ plainBody: 'Tel: +1 (416) 555-0142' }), EXCLUDED).phone).toBe('4165550142');
    expect(parseEligibilityEmail(raw({ plainBody: 'Phone: 555-0142' }), EXCLUDED).phone).toBeNull();
  });

  it('ignores unlabelled phone numbers in signature blocks', () => {
    const body = `Cardholder: Priya Ramanathan
last 4 digits - 1763

Jane Adjuster
Office 905-555-0100`;
    const r = parseEligibilityEmail(raw({ plainBody: body }), EXCLUDED);
    expect(r.phone).toBeNull();
  });

  it('strips Outlook-style quoted sections', () => {
    const body = `Cardholder: Priya Ramanathan
Email: priya.r1985@example.com
last 4 digits - 1763

-----Original Message-----
From: Someone Else <someone.else@example.com>
Sent: Monday, September 29, 2026 9:00 AM
To: Jane Adjuster
Subject: RE: Eligibility Request

Here are the requested details:
Last 4 digits of card: 5555
ending in 7777`;
    const r = parseEligibilityEmail(raw({ plainBody: body }), EXCLUDED);
    expect(r.last4).toBe('1763');
    expect(r.warnings).toEqual([]);
    expect(r.emails).toEqual(['priya.r1985@example.com']);
  });

  it('strips two-line Gmail quoted sections', () => {
    const body = `Cardholder: Priya Ramanathan
Email: priya.r1985@example.com
last 4 digits - 1763

On Mon, Sep 29, 2026 at 9:00 AM Credit Card Operations <creditcardoperations@example.com>
wrote:
> Here are the requested details for client someone.else@example.com:
> • Last 4 digits of card: 5555`;
    const r = parseEligibilityEmail(raw({ plainBody: body }), EXCLUDED);
    expect(r.last4).toBe('1763');
    expect(r.warnings).toEqual([]);
    expect(r.emails).toEqual(['priya.r1985@example.com']);
  });

  it('drops Outlook inline-image pseudo-addresses', () => {
    const r = parseEligibilityEmail(raw({ plainBody: 'Email: lin531613@example.com\nimage001.jpg@01d54a7.ecf' }), EXCLUDED);
    expect(r.emails).toEqual(['lin531613@example.com']);
  });

  it('drops candidates whose TLD is not 2-24 letters', () => {
    const r = parseEligibilityEmail(raw({ plainBody: 'Email: a.b@example.com\nx@host.c2m' }), EXCLUDED);
    expect(r.emails).toEqual(['a.b@example.com']);
  });

  it('reads a "Last, First" name from the subject', () => {
    const r = parseEligibilityEmail(
      raw({ subject: 'Eligibility Confirmation Request – EM Claim 4148480 - Marmer, Steven', plainBody: 'Hello' }), EXCLUDED,
    );
    expect(r.cardholderName).toEqual({ first: 'Steven', last: 'Marmer', raw: 'Marmer, Steven' });
  });

  it('accepts cardholder name with curly apostrophe from subject line', () => {
    const r = parseEligibilityEmail(
      raw({
        subject: 'Eligibility Confirmation Request - Zoë O’Neil',
        plainBody: 'Card ending in 1763. Email: priya.r1985@example.com',
      }),
      EXCLUDED,
    );
    expect(r.cardholderName?.raw).toBe('Zoë O’Neil');
    expect(r.last4).toBe('1763');
  });
});
