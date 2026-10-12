import { readDraft, writeDraft } from './drafts';
import { useEffect, useRef, useState } from 'react';

// Drafts belong to this account and document, with independent branches per page.
// Write synchronously so navigation immediately after typing cannot lose a change.
export function useReviewDraft<T>(key: string, empty: T) {
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<T>(() => {
    try {
      return readDraft(key, empty);
    } catch {
      return empty;
    }
  });
  const current = useRef(value);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function update(next: T | ((previous: T) => T)) {
    // A request may finish after navigating away and reopening this document.
    // Apply its completion to the newest stored draft, not an unmounted copy.
    let previous = current.current;
    if (typeof next === 'function' && !mounted.current) {
      try {
        previous = readDraft(key, empty);
      } catch {
        // If storage is unavailable, the in-memory draft remains usable.
      }
    }
    const result =
      typeof next === 'function'
        ? (next as (previous: T) => T)(previous)
        : next;
    current.current = result;
    setValue(result);
    try {
      writeDraft(key, result);
      setError(null);
    } catch {
      setError(
        'Browser draft storage is unavailable. Keep this tab open and copy your unsaved feedback before leaving.',
      );
    }
  }
  return [value, update, error] as const;
}
