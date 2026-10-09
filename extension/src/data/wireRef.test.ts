import { describe, expect, it } from 'vitest';
import { parseWireRef } from './wireRef';

const CELL = '/BNF/RETURN WIRE DATED 10 07 26 //REF AVJJXHZEBVIA53DF CAD56,295.89//. //LESS CHGS AS //8 00362 LESS CHG';

describe('parseWireRef', () => {
  it('pulls the REF out of a full txdetail_rmtinfo_ustrd cell', () => {
    expect(parseWireRef(CELL)).toBe('AVJJXHZEBVIA53DF');
  });
  it('accepts a bare ref, trimmed', () => {
    expect(parseWireRef('  AVJJXHZEBVIA53DF \n')).toBe('AVJJXHZEBVIA53DF');
  });
  it('uppercases lowercase input', () => {
    expect(parseWireRef('avjjxhzebvia53df')).toBe('AVJJXHZEBVIA53DF');
    expect(parseWireRef('//ref avjjxhzebvia53df cad1')).toBe('AVJJXHZEBVIA53DF');
  });
  it('accepts REF with no space, a colon, or a slash before the token', () => {
    expect(parseWireRef('//REFAVJJXHZEBVIA53DF CAD')).toBe('AVJJXHZEBVIA53DF');
    expect(parseWireRef('REF: AVJJXHZEBVIA53DF')).toBe('AVJJXHZEBVIA53DF');
    expect(parseWireRef('REF/AVJJXHZEBVIA53DF')).toBe('AVJJXHZEBVIA53DF');
  });
  it('handles a Sheets cell copied with surrounding quotes and line breaks', () => {
    expect(parseWireRef(`"/BNF/RETURN WIRE DATED 10 07 26\n//REF AVJJXHZEBVIA53DF\nCAD56,295.89"`)).toBe('AVJJXHZEBVIA53DF');
  });
  it('rejects a 16-char token with no REF in longer text (wrong column pasted)', () => {
    expect(parseWireRef('PAYMENT AVJJXHZEBVIA53DF THANKS')).toBeNull();
  });
  it('rejects tokens that are not exactly 16 chars', () => {
    expect(parseWireRef('AVJJXHZEBVIA53D')).toBeNull();
    expect(parseWireRef('//REF AVJJXHZEBVIA53DFX CAD')).toBeNull();
  });
  it('rejects junk and empty input', () => {
    expect(parseWireRef('')).toBeNull();
    expect(parseWireRef('hello')).toBeNull();
  });
});
