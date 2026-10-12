export function navigate(url: URL, replace = false) {
  if (url.origin !== location.origin) return;
  if (url.href !== location.href) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  window.dispatchEvent(new Event('pw:navigate'));
}
export function documentUrl(
  workspaceId: string,
  documentId?: string | null,
  extra: Record<string, string> = {},
) {
  const url = new URL('/', location.origin);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  if (documentId) url.searchParams.set('document', documentId);
  for (const [key, value] of Object.entries(extra))
    url.searchParams.set(key, value);
  return url;
}
