// Small "seen this" sets for the side panel, kept in memory and mirrored to
// chrome.storage.session so they survive a side panel reload (cleared when the browser closes).
// The side panel is a trusted extension context, so it can read storage.session directly.

export interface SessionMarks {
  /** Marks `id`. Memory is updated synchronously; the storage write is best-effort. */
  mark(id: string): Promise<void>;
  /** Memory first, then storage (a mark made before a panel reload). Never throws. */
  has(id: string): Promise<boolean>;
  hasInMemory(id: string): boolean;
  /** For tests: forget the in-memory marks (storage is left alone). */
  resetMemory(): void;
}

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null;
  } catch {
    return null;
  }
}

export function createSessionMarks(prefix: string): SessionMarks {
  const memory = new Set<string>();
  const storageKey = (id: string) => `${prefix}:${id}`;
  return {
    async mark(id) {
      memory.add(id);
      const area = sessionArea();
      if (!area) return;
      try {
        await area.set({ [storageKey(id)]: true });
      } catch (e) {
        console.debug('[sessionMarks] could not persist', prefix, e);
      }
    },
    async has(id) {
      if (memory.has(id)) return true;
      const area = sessionArea();
      if (!area) return false;
      try {
        const k = storageKey(id);
        const got = await area.get(k);
        if (got?.[k] === true) {
          memory.add(id);
          return true;
        }
      } catch (e) {
        console.debug('[sessionMarks] could not read', prefix, e);
      }
      return false;
    },
    hasInMemory: (id) => memory.has(id),
    resetMemory: () => memory.clear(),
  };
}
