import React from 'react';
import { createRoot } from 'react-dom/client';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import './base.css';
import '@plannotator/ui/styles.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import 'katex/dist/katex.min.css';
import './style.css';
import { App } from './App';
import { identityProvider } from './identity';
import { reviewStorageBackend } from './reviewPreferences';
import { modKey } from '@plannotator/ui/utils/platform';
document.documentElement.style.setProperty(
  '--comment-save-shortcut',
  JSON.stringify(`${modKey} Enter`),
);
configurePlannotatorUI({
  imageSrcResolver: (path) =>
    /^(https?:|blob:)/.test(path) || /^\/api\/images\/[0-9a-f-]{36}$/.test(path)
      ? path
      : '',
  uploadTransport: {
    async upload(file) {
      const documentId = new URLSearchParams(location.search).get('document');
      if (!documentId)
        throw new Error('Open a document before attaching an image.');
      const response = await fetch(
        `/api/documents/${encodeURIComponent(documentId)}/images`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message ?? 'Image upload failed.');
      return { ...result, originalName: file.name };
    },
  },
  storageBackend: reviewStorageBackend,
  identityProvider,
  serverSync: () => {},
  webmcp: { enabled: false },
  skillCatalogTransport: async () => [],
});

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    return this.state.error ? (
      <main className="fatal-error">
        <h1>The document view could not load.</h1>
        <p>Your saved work is safe. Reload to try again.</p>
        <button className="button primary" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeProvider
      defaultTheme="light"
      defaultColorTheme="plannotator"
      storageKey="pw-theme"
      colorThemeStorageKey="pw-palette"
    >
      <App />
    </ThemeProvider>
  </ErrorBoundary>,
);
