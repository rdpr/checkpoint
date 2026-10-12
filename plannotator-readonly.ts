import type { Plugin } from 'vite';

// Compatibility fix for @plannotator/ui 0.52.1: readOnly currently disables
// the highlighter itself, including restoration. Keep upstream rendering and
// restoration, but never install selection-creation listeners in read-only mode.
// Exact matches deliberately fail the build if an upstream upgrade changes it.
export function plannotatorReadonly(): Plugin {
  return {
    name: 'plannotator-readonly-restoration',
    enforce: 'pre',
    transform(source, id) {
      const viewer = id.endsWith('/@plannotator/ui/components/Viewer.tsx');
      const hook = id.endsWith(
        '/@plannotator/ui/hooks/useAnnotationHighlighter.ts',
      );
      const popover = id.endsWith(
        '/@plannotator/ui/components/CommentPopover.tsx',
      );
      if (!viewer && !hook && !popover) return;
      function replace(from: string, to: string) {
        if (source.split(from).length !== 2)
          throw new Error(`Recheck pinned Plannotator read-only fix: ${id}`);
        source = source.replace(from, to);
      }
      if (popover) {
        source = `import { usePopoverDraftStore } from '/src/popoverDrafts';\n${source}`;
        replace(
          'const draftStore = new Map<string, { text: string; images: ImageAttachment[] }>();',
          '',
        );
        replace(
          'function useCommentDraftSync(draftKey:',
          'function useCommentDraftSync(draftStore: ReturnType<typeof usePopoverDraftStore>, draftKey:',
        );
        replace(
          '  const initialDraft = draftKey ?',
          '  const draftStore = usePopoverDraftStore();\n  const initialDraft = draftKey ?',
        );
        replace(
          '  useCommentDraftSync(draftKey,',
          '  useCommentDraftSync(draftStore, draftKey,',
        );
      }
      if (viewer) replace('    enabled: !readOnly,', '    readOnly,');
      if (hook) {
        replace(
          '  enabled?: boolean;',
          '  enabled?: boolean;\n  readOnly?: boolean;',
        );
        replace('  enabled = true,', '  enabled = true,\n  readOnly = false,');
        replace(
          '    highlighter.on(Highlighter.event.CREATE,',
          `    if (readOnly) {
      const container = containerRef.current;
      const select = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const mark = event.target.closest<HTMLElement>('[data-highlight-id], [data-bind-id]');
        const id = mark?.dataset.highlightId ?? mark?.dataset.bindId;
        if (id && container.contains(mark)) onSelectAnnotationRef.current?.(id);
      };
      container.addEventListener('click', select);
      return () => {
        container.removeEventListener('click', select);
        highlighter.dispose();
        highlighterRef.current = null;
      };
    }

    highlighter.on(Highlighter.event.CREATE,`,
        );
        replace(
          '  }, [clearPendingSelection, enabled]);',
          '  }, [clearPendingSelection, enabled, readOnly]);',
        );
      }
      return { code: source, map: null };
    },
  };
}
