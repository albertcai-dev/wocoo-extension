// Local persistence for Sidekick usage events (chrome.storage.local, this browser only).
// Every write is best-effort: tracking must never break the button it's attached to.

import type { TicketTransitionKind } from './ticketLogTypes';
import type { UsageButtonId, UsageEvent } from './usageStats';

export const USAGE_STORAGE_KEY = 'sidekick_usage_events';
const MAX_EVENTS = 20_000;

// Serialize appends so two near-simultaneous events don't read-modify-write over each other.
let queue: Promise<void> = Promise.resolve();

function append(evt: UsageEvent): void {
  queue = queue.then(async () => {
    try {
      const got = await chrome.storage.local.get(USAGE_STORAGE_KEY);
      const events: UsageEvent[] = Array.isArray(got[USAGE_STORAGE_KEY]) ? got[USAGE_STORAGE_KEY] : [];
      events.push(evt);
      await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: events.slice(-MAX_EVENTS) });
    } catch (e) {
      console.debug('[usage] record failed (non-fatal):', e);
    }
  });
}

export function recordClick(ticketId: string, button: UsageButtonId): void {
  append({ t: Date.now(), type: 'click', ticketId, button });
}

export function recordOutcome(ticketId: string, outcome: TicketTransitionKind, movedToBoard?: string): void {
  append({ t: Date.now(), type: 'outcome', ticketId, outcome, ...(movedToBoard ? { movedToBoard } : {}) });
}

export function recordCreated(ticketId: string, createdKey: string, createdKind: string): void {
  append({ t: Date.now(), type: 'created', ticketId, createdKey, createdKind });
}

export async function loadUsageEvents(): Promise<UsageEvent[]> {
  const got = await chrome.storage.local.get(USAGE_STORAGE_KEY);
  return Array.isArray(got[USAGE_STORAGE_KEY]) ? got[USAGE_STORAGE_KEY] : [];
}
