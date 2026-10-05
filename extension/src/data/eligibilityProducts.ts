// i2c "Program" → card_product_id. Seed values come from confirmed matches (e.g. a client whose
// warehouse card_product_id and i2c Program were both visible). Unknown programs return null,
// which the resolver flags as unknown_product. Never guess.

export const I2C_PROGRAM_TO_PRODUCT: Record<string, string> = {
  'Wealthsimple Visa Infinite VIP 01 Physical': 'ws_visa_infinite_privilege',
};

export function mapI2cProgram(p: string | undefined): string | null {
  if (!p) return null;
  const key = p.replace(/\s+/g, ' ').trim();
  return I2C_PROGRAM_TO_PRODUCT[key] ?? null;
}
