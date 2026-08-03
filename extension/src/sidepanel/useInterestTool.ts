// Shared launch state for the Interest Validation tool, used by both the QuickActions
// button and the InterestInvestigationCard so they behave identically (and so only one
// place knows about cold-start timing).

import { useState } from 'react';
import { openInterestTool } from '../api/interestTool';

export interface InterestToolNote {
  kind: 'info' | 'error';
  text: string;
}

export function useInterestTool() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<InterestToolNote | null>(null);

  const run = async (context: { identityId?: string; ticketId?: string }) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const outcome = await openInterestTool(context);
      if (outcome === 'started') {
        setNote({ kind: 'info', text: 'Interest Validation tool started — opened in a new tab.' });
      }
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return { busy, note, setNote, run };
}
