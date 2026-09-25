import { describe, it, expect } from 'vitest';
import { buildI2cDraft, buildKohoDraft, stripZendeskPointer } from './messagingDrafts';
import type { WocooTicket } from './mockTicket';

function ticket(over: Partial<WocooTicket> = {}): WocooTicket {
  return {
    id: 'WOCOO-28153',
    summary: 'Negative Cash Back Balance',
    description: 'Hi team.\n\nClient owes a negative cash back balance.',
    clientEmail: 'ahmadmstto@outlook.com',
    ...over,
  } as WocooTicket;
}

describe('stripZendeskPointer', () => {
  it('drops the bulleted pointer Jira descriptions carry', () => {
    const out = stripZendeskPointer(
      'Client owes a balance.\n\n- Please see Zendesk Support tab for further comments and attachments.',
    );
    expect(out).toBe('Client owes a balance.');
  });

  it('drops the pointer without a bullet', () => {
    const out = stripZendeskPointer(
      'Client owes a balance.\n\nPlease see Zendesk Support tab for further comments and attachments.',
    );
    expect(out).toBe('Client owes a balance.');
  });

  it('matches regardless of case and indentation', () => {
    const out = stripZendeskPointer('Body.\n   * PLEASE SEE ZENDESK support tab for more.');
    expect(out).toBe('Body.');
  });

  it('leaves a description without the pointer untouched', () => {
    const body = 'Client owes a balance.\n\nThank you';
    expect(stripZendeskPointer(body)).toBe(body);
  });

  it('returns an empty string when the pointer is the only content', () => {
    expect(stripZendeskPointer('- Please see Zendesk Support tab for further comments.')).toBe('');
  });

  it('keeps a line that merely mentions Zendesk without being the pointer', () => {
    const body = 'The client replied in Zendesk saying the card still declines.';
    expect(stripZendeskPointer(body)).toBe(body);
  });

  it('handles an empty description', () => {
    expect(stripZendeskPointer('')).toBe('');
  });
});

describe('buildI2cDraft', () => {
  it('strips the pointer and appends the client email', () => {
    const d = buildI2cDraft(ticket({
      description: 'Card declines at one merchant.\n\n- Please see Zendesk Support tab for further comments and attachments.',
    }));
    expect(d.summary).toBe('Negative Cash Back Balance');
    expect(d.description).toBe('Card declines at one merchant.\n\nClient email: ahmadmstto@outlook.com');
  });

  it('omits the email line when the ticket has no client email', () => {
    const d = buildI2cDraft(ticket({ clientEmail: '', description: 'Card declines.' }));
    expect(d.description).toBe('Card declines.');
    expect(d.description).not.toContain('Client email');
  });

  it('still emits the email line when the description is empty', () => {
    const d = buildI2cDraft(ticket({ description: '' }));
    expect(d.description).toBe('Client email: ahmadmstto@outlook.com');
  });
});

describe('buildKohoDraft', () => {
  it('places the client email after the description and before the ask', () => {
    const d = buildKohoDraft(ticket({
      description: 'Card declines.\n\n- Please see Zendesk Support tab for further comments.',
    }));
    expect(d.subject).toBe('Negative Cash Back Balance');
    expect(d.body).not.toContain('Zendesk');
    const emailAt = d.body.indexOf('Client email: ahmadmstto@outlook.com');
    const descAt = d.body.indexOf('Card declines.');
    const askAt = d.body.indexOf('Could you please investigate');
    expect(descAt).toBeGreaterThan(-1);
    expect(emailAt).toBeGreaterThan(descAt);
    expect(askAt).toBeGreaterThan(emailAt);
  });

  it('omits the email line when the ticket has no client email', () => {
    const d = buildKohoDraft(ticket({ clientEmail: '' }));
    expect(d.body).not.toContain('Client email');
    expect(d.body).toContain('Could you please investigate');
  });

  it('falls back to a generic subject when the summary is blank', () => {
    expect(buildKohoDraft(ticket({ summary: '' })).subject).toBe('Prepaid Card Inquiry');
  });
});
