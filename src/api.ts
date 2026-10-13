import { getUserId, identityGeneration } from './identity';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const generation = identityGeneration();
  const userId = getUserId();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(userId ? { 'X-Workspace-User': userId } : {}),
        ...options.headers,
      },
      credentials: 'same-origin',
    });
  } catch (error) {
    window.dispatchEvent(new Event('pw:disconnected'));
    throw new Error(
      'Connection unavailable. Your draft is kept. Reconnect, then retry explicitly.',
    );
  }
  window.dispatchEvent(new Event('pw:connected'));
  const data = await response.json();
  if (
    ['unauthorized', 'session_changed'].includes(data.code) &&
    response.status === 401 &&
    userId &&
    generation === identityGeneration() &&
    !path.startsWith('/auth/login')
  )
    window.dispatchEvent(new Event('pw:session-expired'));
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.code,
      data.message ?? 'Request failed.',
    );
  return data as T;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
export const dateLabel = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
export function download(name: string, body: string) {
  const url = URL.createObjectURL(
    new Blob([body], {
      type: /\.html?$/i.test(name)
        ? 'text/html;charset=utf-8'
        : /\.mdx?$/i.test(name)
          ? 'text/markdown;charset=utf-8'
          : 'text/plain;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function artifactLabel(path: string) {
  const name = (path.split('/').pop() ?? path)
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}
export function relativeDate(date: string) {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(date));
}

export const artifactLocation = (path: string) =>
  [...path.split('/').slice(0, -1), artifactLabel(path)].join(' › ');
