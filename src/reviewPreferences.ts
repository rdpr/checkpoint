import { useRef, useState } from 'react';
import { z } from 'zod';
import { getUserId } from './identity';
import type { StorageBackend } from '@plannotator/ui/utils/storage';

const preferencesSchema = z.object({
  layout: z.enum(['normal', 'wide', 'focus']).default('normal'),
  panelVisible: z.boolean().default(true),
  reviewMode: z
    .enum(['selection', 'comment', 'redline', 'quickLabel'])
    .default('comment'),
  inputMethod: z.enum(['drag', 'pinpoint']).default('drag'),
  showResolved: z.boolean().default(false),
  diffMode: z.enum(['clean', 'classic', 'raw']).default('clean'),
});
export type ReviewPreferences = z.infer<typeof preferencesSchema>;
const defaults = preferencesSchema.parse({});

export function useReviewPreferences(userId: string) {
  const key = `pw-review:${userId}`;
  const [preferences, setPreferences] = useState<ReviewPreferences>(() => {
    try {
      const parsed = preferencesSchema.safeParse(
        JSON.parse(localStorage.getItem(key) ?? '{}'),
      );
      return parsed.success ? parsed.data : defaults;
    } catch {
      return defaults;
    }
  });
  const [storageError, setStorageError] = useState<string | null>(null);
  const current = useRef(preferences);
  current.current = preferences;
  function updatePreferences(patch: Partial<ReviewPreferences>) {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStorageError(null);
    } catch {
      setStorageError(
        'Browser storage is unavailable. Your review preferences will reset when you reload.',
      );
    }
  }
  return { preferences, updatePreferences, storageError };
}

// Keep upstream's storage extension point, but isolate personal label presets
// by authenticated account. No settings or label definitions go to the server.
const labelsKey = 'plannotator-quick-labels';
const labelsSchema = z
  .array(
    z.object({
      id: z.string(),
      emoji: z.string(),
      text: z.string(),
      color: z.string(),
      tip: z.string().optional(),
    }),
  )
  .max(12);
const fallback = new Map<string, string | null>();
function keyFor(key: string) {
  return key === labelsKey
    ? `pw-ui:${getUserId() ?? 'anonymous'}:${key}`
    : `pw-ui:${key}`;
}
export const reviewStorageBackend: StorageBackend = {
  getItem(key) {
    const scoped = keyFor(key);
    let value = fallback.get(scoped) ?? null;
    try {
      if (!fallback.has(scoped)) value = localStorage.getItem(scoped);
    } catch {
      /* Session fallback below. */
    }
    if (key === labelsKey && value) {
      try {
        if (!labelsSchema.safeParse(JSON.parse(value)).success) return null;
      } catch {
        return null;
      }
    }
    return value;
  },
  setItem(key, value) {
    const scoped = keyFor(key);
    try {
      localStorage.setItem(scoped, value);
      fallback.delete(scoped);
    } catch {
      fallback.set(scoped, value);
      window.dispatchEvent(new Event('pw-label-storage-error'));
    }
  },
  removeItem(key) {
    const scoped = keyFor(key);
    try {
      localStorage.removeItem(scoped);
      fallback.delete(scoped);
    } catch {
      fallback.set(scoped, null);
      window.dispatchEvent(new Event('pw-label-storage-error'));
    }
  },
};
