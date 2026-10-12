// Each page writes its own branch. An adopted branch is removed only if it has
// not changed since we read it, so two open tabs cannot erase each other's work.
const prefix = 'pw-local-draft:';
const pageId = crypto.randomUUID();
// Keep a branch owned by another open page. A crashed page can leave a marker;
// retaining an extra draft is safer than expiring a throttled background tab.
const pagePrefix = 'pw-draft-page:';
function registerPage() {
  try {
    localStorage.setItem(pagePrefix + pageId, 'open');
  } catch {}
}
registerPage();
window.addEventListener('pageshow', registerPage);
window.addEventListener('pagehide', () => {
  try {
    localStorage.removeItem(pagePrefix + pageId);
  } catch {}
});
function activePage(slot: string) {
  const id = slot.slice(slot.lastIndexOf(':') + 1);
  return localStorage.getItem(pagePrefix + id) !== null;
}
export type SavedDraft = { key: string; value: unknown; updatedAt: string };
const adopted = new Map<string, { slot: string; raw: string }>();
const branches = new Map<string, string>();
const ownSlot = (key: string) =>
  branches.get(key) ?? prefix + key + ':' + pageId;
export function savedDrafts(userId: string) {
  const result: (SavedDraft & { slot: string })[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const slot = localStorage.key(i)!;
    if (!slot.startsWith(prefix)) continue;
    try {
      const record = JSON.parse(localStorage.getItem(slot)!);
      if (
        typeof record.key === 'string' &&
        typeof record.updatedAt === 'string' &&
        record.key.split(':')[1] === userId &&
        record.value != null
      )
        result.push({ ...record, slot });
    } catch {
      /* Ignore unrelated or malformed browser data. */
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function readDraft<T>(key: string, empty: T): T {
  const own = ownSlot(key);
  const selected = sessionStorage.getItem('pw-selected-draft');
  const candidates = savedDrafts(key.split(':')[1]).filter(
    (d) => d.key === key,
  );
  const record =
    candidates.find((d) => d.slot === selected) ??
    candidates.find((d) => d.slot === own) ??
    candidates[0];
  if (record) {
    const raw = localStorage.getItem(record.slot)!;
    adopted.set(key, { slot: record.slot, raw });
    if (record.slot === selected) {
      sessionStorage.removeItem('pw-selected-draft');
      // Explicitly resuming another draft starts a branch without erasing the
      // current page's previous work, and makes that choice survive reload.
      if (record.slot !== own)
        branches.set(
          key,
          prefix + key + ':' + crypto.randomUUID() + ':' + pageId,
        );
      writeDraft(key, record.value);
    }
    return record.value as T;
  }
  const legacy = sessionStorage.getItem(key);
  if (legacy !== null) {
    const value = JSON.parse(legacy);
    writeDraft(key, value);
    sessionStorage.removeItem(key);
    return value;
  }
  return empty;
}
export function writeDraft(key: string, value: unknown) {
  const own = ownSlot(key);
  const previous = adopted.get(key);
  if (
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
    localStorage.removeItem(own);
  else
    localStorage.setItem(
      own,
      JSON.stringify({ key, value, updatedAt: new Date().toISOString() }),
    );
  if (
    previous &&
    previous.slot !== own &&
    !activePage(previous.slot) &&
    localStorage.getItem(previous.slot) === previous.raw
  )
    localStorage.removeItem(previous.slot);
  adopted.delete(key);
  sessionStorage.removeItem(key);
  window.dispatchEvent(new Event('pw:drafts'));
}
