// React hook — subscribes to the service worker's broadcast of the current WOCOO ticket key
// from chrome.storage.session, and re-renders the side panel whenever it changes.
//
// Returns [key, setKey]. The setter updates local state immediately AND writes through to
// chrome.storage.session so the value survives panel close + sync with the service worker.
// Use the setter from in-panel actions (e.g. clicking a ticket card on Home) so the UI
// doesn't have to wait for the storage event round-trip — otherwise the panel re-renders
// with the old key for a frame and falls back to Home.

import { useCallback, useEffect, useState } from 'react';

const CURRENT_KEY = 'current_ticket_key';

export function useCurrentTicketKey(): readonly [string | null, (key: string | null) => void] {
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    // Initial read
    chrome.storage.session.get(CURRENT_KEY).then((res) => {
      setKey((res[CURRENT_KEY] as string | null) ?? null);
    });

    // Subscribe to changes
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if (!(CURRENT_KEY in changes)) return;
      setKey((changes[CURRENT_KEY].newValue as string | null) ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const setCurrentKey = useCallback((newKey: string | null) => {
    setKey(newKey);
    if (newKey == null) {
      void chrome.storage.session.remove(CURRENT_KEY);
    } else {
      void chrome.storage.session.set({ [CURRENT_KEY]: newKey });
    }
  }, []);

  return [key, setCurrentKey] as const;
}
