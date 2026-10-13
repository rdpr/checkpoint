import { diagramRenderKindForPath } from '@plannotator/core/annotatable';

export {
  isAnnotatableDocPath,
  ANNOTATABLE_EXTENSIONS_HINT,
} from '@plannotator/core/annotatable';

// Rendering is part of an artifact's identity. Renames cannot change this family,
// so every saved revision and its anchors keep the same interpretation.
export function artifactFormat(path: string) {
  if (/\.html?$/i.test(path)) return 'html';
  return (
    diagramRenderKindForPath(path) ??
    (/\.mdx?$/i.test(path) ? 'markdown' : 'text')
  );
}

export function artifactExtension(path: string) {
  return /\.env\.example$/i.test(path)
    ? '.env.example'
    : path.slice(path.lastIndexOf('.'));
}

export function sourceFence(body: string) {
  const fence = '`'.repeat(
    [...body.matchAll(/`+/g)].reduce(
      (length, m) => Math.max(length, m[0].length + 1),
      3,
    ),
  );
  return `${fence}text\n${body}\n${fence}`;
}
