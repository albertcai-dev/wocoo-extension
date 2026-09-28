// Heuristic to detect Visa Airport Companion / DragonPass access tickets so the
// side panel can recommend the Visa Companion RPIN workflow. Mirrors the shape of
// [[wallet-triage-detect]].
//
// Deliberately narrow: generic lounge / Priority Pass mentions don't fire, only
// the Visa Companion program and DragonPass (which runs it).

export interface VisaCompanionDetection {
  matched: boolean;
  reasons: string[];
}

const SIGNALS = [
  'visa companion',
  'airport companion',
  'dragon pass',
  'dragonpass',
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
  if (hits.length) reasons.push(`Visa Companion signal: ${hits.join(', ')}`);

  return { matched: hits.length > 0, reasons };
}
