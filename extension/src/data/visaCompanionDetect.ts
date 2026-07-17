// Heuristic to detect "client can't register for Visa Airport Companion" tickets.
// Mirrors the existing detector shape ([[wallet-triage-detect]] / [[cred-route-detect]]).
//
// Narrow signal set per the brainstorming decision (2026-06-24): only fire on
// Visa Companion / Airport Companion mentions. Broader Visa Infinite benefit
// detection (concierge, priority pass, lounge access) was scoped out.

export interface VisaCompanionDetection {
  matched: boolean;
  reasons: string[];
}

const SIGNALS = [
  'visa companion',
  'airport companion',
  'visa airport companion',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectVisaCompanion(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): VisaCompanionDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const hits = findMatches(text, SIGNALS);

  const reasons: string[] = [];
  if (hits.length) reasons.push(`Visa Companion signal: ${hits[0].trim()}`);

  return { matched: hits.length > 0, reasons };
}
