import { marked } from 'marked';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { artifactFormat } from '../shared/artifacts.ts';
// Parse links with the same Markdown parser used by the pinned UI. Code spans,
// fenced examples and images are not artifact navigation links.
export function artifactLinks(body: string, path = 'artifact.md') {
  const links = new Set<string>();
  if (artifactFormat(path) === 'html') {
    function visit(node: DefaultTreeAdapterMap['node']) {
      if (
        'tagName' in node &&
        (node.tagName === 'a' || node.tagName === 'area')
      ) {
        const href = node.attrs.find((attr) => attr.name === 'href')?.value;
        if (href && relativePath(href, path) !== null) links.add(href);
      }
      if ('childNodes' in node) node.childNodes.forEach(visit);
    }
    visit(parse(body));
    return [...links];
  }
  if (artifactFormat(path) !== 'markdown') return [];
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
