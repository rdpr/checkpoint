import { createContext, useContext, useMemo } from 'react';
import { readDraft, writeDraft } from './drafts';
import type { ImageAttachment } from '@plannotator/ui/types';
import { getUserId } from './identity';

export const PopoverDraftScope = createContext('');
// The pinned popover has a private, memory-only draft store. The build adapter
// replaces only that store; upstream still owns the composer and attachments.
export function usePopoverDraftStore() {
  const scope = useContext(PopoverDraftScope);
  return useMemo(() => {
    const userId = getUserId();
    type Draft = { text: string; images: ImageAttachment[] };
    const cache = new Map<string, Draft | undefined>();
    const key = (id: string) =>
      `pw-popover-draft:${userId}:${scope}:${encodeURIComponent(id)}`;
    const save = (id: string, value: unknown) => {
      try {
        writeDraft(key(id), value);
      } catch {
        window.dispatchEvent(new CustomEvent('pw:draft-error'));
      }
    };
    return {
      get(id: string) {
        if (!cache.has(id)) {
          try {
            cache.set(id, readDraft<Draft | undefined>(key(id), undefined));
          } catch {
            /* Keep in-memory editing available. */
          }
        }
        return cache.get(id);
      },
      set(id: string, value: Draft) {
        cache.set(id, value);
        save(id, value);
      },
      delete(id: string) {
        cache.delete(id);
        save(id, null);
      },
    };
  }, [scope]);
}
