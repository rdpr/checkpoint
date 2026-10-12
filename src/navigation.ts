export function navigate(url: URL, replace = false) {
  if (url.origin !== location.origin) return;
  if (url.searchParams.has('document')) {
    if (!url.searchParams.has('artifact'))
      url.searchParams.set('artifact', url.searchParams.get('document')!);
    url.searchParams.delete('document');
  }
  if (url.href !== location.href) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  window.dispatchEvent(new Event('pw:navigate'));
}
export function artifactUrl(
  workspaceId: string,
  artifactId?: string | null,
  extra: Record<string, string> = {},
) {
  const url = new URL('/', location.origin);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  if (artifactId) url.searchParams.set('artifact', artifactId);
  for (const [key, value] of Object.entries(extra))
    url.searchParams.set(key, value);
  return url;
}
