import { describe, it, expect } from 'vitest';
import { detectVisaCompanion } from './visaCompanionDetect';

describe('detectVisaCompanion', () => {
  it('matches the WOCOO-28976 lounge-pass / DragonPass ticket', () => {
    const d = detectVisaCompanion(
      'CC Rewards',
      'Hi team, client is having trouble accessing the visa companion lounge passes / dragon pass with her credit card',
      'Credit Card: Rewards',
    );
    expect(d.matched).toBe(true);
    expect(d.reasons[0]).toContain('visa companion');
  });

  it('matches Airport Companion and DragonPass spellings', () => {
    expect(detectVisaCompanion('Visa Airport Companion enrollment', '', null).matched).toBe(true);
    expect(detectVisaCompanion('', 'Client cannot register on DragonPass', null).matched).toBe(true);
    expect(detectVisaCompanion('', 'dragon pass app says card not eligible', null).matched).toBe(true);
  });

  it('does not match unrelated Visa or lounge tickets', () => {
    expect(detectVisaCompanion('Prepaid Visa decline', 'ATM declined the card', null).matched).toBe(false);
    expect(detectVisaCompanion('Priority Pass lounge', 'client wants lounge access info', null).matched).toBe(false);
  });
});
