// The original wire send's reference, as RBC prints it in a returned wire's
// txdetail_rmtinfo_ustrd (e.g. "…//REF AVJJXHZEBVIA53DF CAD56,295.89//…"). It equals the
// send's e2e_identifier in Preset's "ALL wire sends created" table.

const REF_IN_TEXT = /\bREF[\s/:]*([A-Z0-9]{16})(?![A-Z0-9])/;
const BARE_REF = /^[A-Z0-9]{16}$/;

/** The 16-char REF from a pasted cell or a bare ref, uppercased; null if there isn't one. */
export function parseWireRef(input: string): string | null {
  const text = input.toUpperCase().replace(/\s+/g, ' ').trim().replace(/^"+|"+$/g, '').trim();
  const m = REF_IN_TEXT.exec(text);
  if (m) return m[1];
  return BARE_REF.test(text) ? text : null;
}
