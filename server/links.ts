import { marked } from 'marked';
// Parse links with the same Markdown parser used by the pinned UI. Code spans,
// fenced examples and images are not document navigation links.
export function documentLinks(body: string) {
  const links = new Set<string>();
  marked.walkTokens(marked.lexer(body), (token) => {
    if (token.type === 'link' && relativePath(token.href, 'root.md') !== null)
      links.add(token.href);
  });
  return [...links];
}
export function relativePath(href: string, sourcePath: string): string | null {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) ||
    href.startsWith('//') ||
    href.startsWith('#') ||
    href.includes('\\')
  )
    return null;
  try {
    const url = new URL(href, `https://workspace.invalid/${sourcePath}`);
    if (url.origin !== 'https://workspace.invalid') return null;
    return decodeURIComponent(url.pathname).slice(1);
  } catch {
    return null;
  }
}
