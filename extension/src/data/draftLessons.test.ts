import { describe, expect, it } from 'vitest';
import { buildLessonMessages, parseLessons, worthReviewing } from './draftLessons';

describe('worthReviewing', () => {
  it('skips untouched drafts and tiny fixes', () => {
    expect(worthReviewing('Hi, it posted.', 'Hi, it posted.')).toBe(false);
    expect(worthReviewing('Hi, it posted.', 'hi,  it  posted.')).toBe(false);
    expect(worthReviewing('Hi, it posted on Oct 4.', 'Hi, it posted on Oct 5.')).toBe(false);
  });
  it('worthReviewing ignores the reply greeting', () => {
    const n = 'Jennifer Longname-Example';
    expect(worthReviewing(`Hi @${n}, ok`, `@${n} Hi @${n}, ok`)).toBe(true);
    expect(worthReviewing(`Hi @${n}, ok`, `@${n} Hi @${n}, ok`, n)).toBe(false);
  });
  it('reviews a real rewrite', () => {
    expect(worthReviewing(
      'Hi, KOHO replied. They found nothing, and also the debit backouts are unrelated, please retry at another ATM.',
      'Hi, KOHO replied and they have no record of the attempts.',
    )).toBe(true);
  });
});

describe('parseLessons', () => {
  it('reads up to three clean lessons', () => {
    const raw = JSON.stringify({ lessons: [
      { text: 'Relay a KOHO answer in 1-2 sentences.', category: 'tone', work_type_only: false },
      { text: 'Skip the CXO "for next time" link.', category: 'weird' },
      { text: 'relay a koho answer in 1-2 sentences.', category: 'tone' },
      { text: 'x'.repeat(400), category: 'tone' },
      { text: 'A', category: 'facts' }, { text: 'B', category: 'facts' }, { text: 'C', category: 'facts' },
    ] });
    const out = parseLessons(raw);
    expect(out.map((l) => l.text)).toEqual(['Relay a KOHO answer in 1-2 sentences.', 'Skip the CXO "for next time" link.', 'A']);
    expect(out[1].category).toBe('other');
  });
  it('tolerates prose around the JSON and garbage', () => {
    expect(parseLessons('Here you go: {"lessons": [{"text": "Be brief.", "category": "tone"}]}')).toHaveLength(1);
    expect(parseLessons('not json')).toEqual([]);
    expect(parseLessons('{"lessons": "nope"}')).toEqual([]);
  });
});

describe('buildLessonMessages', () => {
  it('carries the draft, the posted text and the evidence', () => {
    const [sys, user] = buildLessonMessages({ workType: 'Prepaid Card: Physical Card', draft: 'D', posted: 'P', evidence: ['i2c: x'] });
    expect(sys.content).toMatch(/never name the client/);
    expect(user.content).toContain('AGENT DRAFT:\nD');
    expect(user.content).toContain('WHAT THE SPECIALIST POSTED:\nP');
    expect(user.content).toContain('i2c: x');
  });
});
