// After an edited agent draft is posted: one gateway call proposes 1-3 lessons from the edit,
// shown as a "Learned: …" note. Keep saves a lesson for future drafts; Wrong records that it was
// rejected so the same proposal isn't kept by accident. Renders nothing for untouched drafts.

import { useEffect, useState } from 'react';
import { getLlmGatewayKey } from '../auth/credentials';
import { callLlmGateway } from '../api/llmGateway';
import { saveLesson } from '../api/draftStore';
import { buildLessonMessages, parseLessons, type ProposedLesson } from '../data/draftLessons';
import type { DraftEvidence } from '../data/agentDraftTypes';
import { secondaryButton } from './toolUi';

type Review =
  | { kind: 'thinking' }
  | { kind: 'ready'; lessons: ProposedLesson[] }
  | { kind: 'skip' }
  | { kind: 'failed'; error: string };

type Verdict = 'kept' | 'wrong' | 'saving' | 'error';

export function LessonReview(props: {
  ticketKey: string;
  workType: string;
  draft: string;
  posted: string;
  evidence: DraftEvidence[];
}) {
  const { ticketKey, workType, draft, posted, evidence } = props;
  const [review, setReview] = useState<Review>({ kind: 'thinking' });
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const key = await getLlmGatewayKey();
      if (!key) { if (!cancelled) setReview({ kind: 'skip' }); return; }
      try {
        const raw = await callLlmGateway(buildLessonMessages({
          workType,
          draft,
          posted,
          evidence: evidence.map((e) => `${e.kind}: ${e.label} — ${e.detail}`),
        }), key, { maxTokens: 600 });
        const lessons = parseLessons(raw);
        if (!cancelled) setReview(lessons.length ? { kind: 'ready', lessons } : { kind: 'skip' });
      } catch (e) {
        if (!cancelled) setReview({ kind: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
    // Runs once per post: the inputs are fixed once the comment has landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (i: number, lesson: ProposedLesson, status: 'kept' | 'wrong') => {
    setVerdicts((v) => ({ ...v, [i]: 'saving' }));
    try {
      await saveLesson({
        text: lesson.text,
        status,
        work_type: lesson.work_type_only ? workType : undefined,
        category: lesson.category,
        source_key: ticketKey,
      });
      setVerdicts((v) => ({ ...v, [i]: status }));
    } catch (e) {
      console.warn('Could not save the lesson', e);
      setVerdicts((v) => ({ ...v, [i]: 'error' }));
    }
  };

  if (review.kind === 'skip') return null;
  if (review.kind === 'thinking') return <div style={noteStyle}>Checking what your edit can teach the agent…</div>;
  if (review.kind === 'failed') return <div style={noteStyle}>Couldn't review your edit: {review.error}</div>;

  return (
    <div style={{ ...noteStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 600 }}>Learned from your edit:</div>
      {review.lessons.map((lesson, i) => {
        const v = verdicts[i];
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ color: 'var(--mint-fg-strong)', textDecoration: v === 'wrong' ? 'line-through' : undefined }}>
              {lesson.text}
              <span style={{ color: 'var(--mint-fg-soft)' }}>
                {' '}· {lesson.category.replace('_', ' ')}{lesson.work_type_only ? ' · this work type' : ''}
              </span>
            </div>
            {v === 'kept' ? <div>Kept — future drafts will follow it.</div>
              : v === 'wrong' ? <div>Thrown away.</div>
              : v === 'error' ? <div style={{ color: 'var(--mint-negative-fg-strong)' }}>Couldn't save — is the agent set up on this machine?</div>
              : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" disabled={v === 'saving'} style={secondaryButton} onClick={() => void decide(i, lesson, 'kept')}>Keep</button>
                  <button type="button" disabled={v === 'saving'} style={secondaryButton} onClick={() => void decide(i, lesson, 'wrong')}>Wrong</button>
                </div>
              )}
          </div>
        );
      })}
    </div>
  );
}

const noteStyle: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--mint-bg-subtle, rgba(0,0,0,0.04))',
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-soft)',
  lineHeight: 1.4,
};
