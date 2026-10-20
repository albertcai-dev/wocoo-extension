import { describe, expect, it } from 'vitest';
import type { DraftMove } from './agentDraftTypes';
import type { CreateMetaField } from '../api/jira';
import { DBO_ISSUE_TYPES } from './moveConfig';
import { hasIssueTypePicker, issueTypeIdFor, matchPrefillFields, toMovePrefill } from './movePrefill';

const move = (over: Partial<DraftMove>): DraftMove => ({
  destination: 'EOC',
  issue_type: 'Task',
  reason: 'Needs engineering investigation',
  sidekick_supported: true,
  ...over,
});

describe('toMovePrefill', () => {
  it('maps EOC', () => {
    expect(toMovePrefill(move({ comment: 'Moving to EOC', fields: { 'Problem Area': 'Funding', n: 5 } }))).toEqual({
      destination: 'EOC',
      issueTypeName: 'Task',
      fields: { 'Problem Area': 'Funding', n: '5' },
      reason: 'Needs engineering investigation',
      comment: 'Moving to EOC',
    });
  });

  it('null for WORS', () => {
    expect(toMovePrefill(move({ destination: 'WORS' }))).toBeNull();
  });

  it('null for BOTI', () => {
    expect(toMovePrefill(move({ destination: 'BOTI' }))).toBeNull();
  });

  it('null when sidekick_supported false', () => {
    expect(toMovePrefill(move({ sidekick_supported: false }))).toBeNull();
  });

  it('drops null comment and non-primitive field values', () => {
    const p = toMovePrefill(move({ comment: null, fields: { a: 'x', b: null, c: { z: 1 }, d: true } }));
    expect(p?.comment).toBeUndefined();
    expect(p?.fields).toEqual({ a: 'x', d: 'true' });
  });
});

describe('issueTypeIdFor', () => {
  it('resolves a DBO issue type by name, case-insensitively', () => {
    expect(issueTypeIdFor('DBO', ' credit limit increase ')).toBe('19051');
  });
  it('is undefined for unknown names and for EOC/CRED', () => {
    expect(issueTypeIdFor('DBO', 'Nope')).toBeUndefined();
    expect(issueTypeIdFor('EOC', 'Task')).toBeUndefined();
    expect(issueTypeIdFor('CRED', 'Task')).toBeUndefined();
    expect(issueTypeIdFor('DBO', undefined)).toBeUndefined();
  });
});

describe('matchPrefillFields', () => {
  const cfg = DBO_ISSUE_TYPES.find((t) => t.id === '19051')!;
  const idField = cfg.requiredFields[0];
  const amountField = cfg.requiredFields[1];
  const meta: CreateMetaField[] = [];

  it('matches by field id or by name, case-insensitively', () => {
    const out = matchPrefillFields(cfg.requiredFields, meta, {
      [amountField.fieldId.toUpperCase()]: '5000',
    }, {});
    expect(out).toEqual({ [amountField.fieldId]: '5000' });
    const byName = matchPrefillFields(cfg.requiredFields, meta, { 'amount of CREDIT limit increase requested': '7000' }, {});
    expect(byName).toEqual({ [amountField.fieldId]: '7000' });
  });

  it('does not overwrite a value already derived from the ticket', () => {
    const out = matchPrefillFields(cfg.requiredFields, meta, { [idField.fieldId]: 'agent-guess' }, { [idField.fieldId]: 'ticket-id' });
    expect(out).toEqual({});
  });

  it('ignores unknown fields and blank values', () => {
    expect(matchPrefillFields(cfg.requiredFields, meta, { nonsense: 'x', [amountField.fieldId]: '  ' }, {})).toEqual({});
  });

  it('maps option labels to option ids and leaves unmatched options blank', () => {
    const fields = [{ fieldId: 'customfield_1', name: 'Reason', type: 'option' as const }];
    const m: CreateMetaField[] = [{ fieldId: 'customfield_1', name: 'Reason', required: true, allowedValues: [{ id: '10', value: 'Alpha' }, { id: '11', name: 'Beta' }] }];
    expect(matchPrefillFields(fields, m, { Reason: 'beta' }, {})).toEqual({ customfield_1: '11' });
    expect(matchPrefillFields(fields, m, { Reason: '10' }, {})).toEqual({ customfield_1: '10' });
    expect(matchPrefillFields(fields, m, { Reason: 'Gamma' }, {})).toEqual({});
  });

  it('maps option-with-child as "Parent > Child"', () => {
    const fields = [{ fieldId: 'customfield_2', name: 'Area', type: 'option-with-child' as const }];
    const m: CreateMetaField[] = [{
      fieldId: 'customfield_2', name: 'Area', required: true,
      allowedValues: [{ id: '20', value: 'Cards', children: [{ id: '21', value: 'Reissue' }] }],
    }];
    expect(matchPrefillFields(fields, m, { Area: 'Cards > Reissue' }, {})).toEqual({ customfield_2: '20', customfield_2__child: '21' });
    expect(matchPrefillFields(fields, m, { Area: 'Cards' }, {})).toEqual({ customfield_2: '20' });
  });

  it('never fills fields Atlas owns', () => {
    const fields = [
      { fieldId: 'customfield_3', name: 'Cardholder Name', type: 'string' as const, prefillFrom: 'atlasName' as const },
      { fieldId: 'customfield_4', name: 'Shipping Address', type: 'paragraph' as const, prefillFrom: 'atlasAddress' as const },
      { fieldId: 'customfield_5', name: 'Note', type: 'string' as const },
    ];
    const out = matchPrefillFields(fields, [], { 'Cardholder Name': 'X', 'customfield_4': '1 Fake St', Note: 'hi' }, {});
    expect(out).toEqual({ customfield_5: 'hi' });
  });

  it('matches an option label before an id that equals another option label', () => {
    const fields = [{ fieldId: 'customfield_6', name: 'Pick', type: 'option' as const }];
    const m: CreateMetaField[] = [{
      fieldId: 'customfield_6', name: 'Pick', required: true,
      allowedValues: [{ id: '30', value: 'Other' }, { id: '31', value: '30' }],
    }];
    expect(matchPrefillFields(fields, m, { Pick: '30' }, {})).toEqual({ customfield_6: '31' });
  });
});

describe('hasIssueTypePicker', () => {
  it('is true for dynamic destinations only', () => {
    expect(hasIssueTypePicker('DBO')).toBe(true);
    expect(hasIssueTypePicker('EOC')).toBe(false);
    expect(hasIssueTypePicker('CRED')).toBe(false);
  });
});
