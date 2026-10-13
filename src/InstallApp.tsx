import { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { dismissInstall, installApp, useInstallation } from './installation';
import { ErrorMessage } from './ui';

export function AppMetadata() {
  const { resolvedMode } = useTheme();
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        resolvedMode === 'dark' ? '#14171d' : '#f7f8fa',
      );
  }, [resolvedMode]);
  return null;
}

export function InstallSuggestion() {
  const { prompt, installed, dismissed, busy, error } = useInstallation();
  if (installed || dismissed || (!prompt && !error)) return null;
  return (
    <aside className="install-suggestion" aria-label="Install Checkpoint">
      <img src="/brand/app-192.png" width="32" height="32" alt="" />
      <span role={error ? 'alert' : undefined}>
        {error ?? 'Keep Checkpoint in its own window.'}
      </span>
      {prompt && (
        <button
          className="button"
          disabled={busy}
          onClick={() => void installApp()}
        >
          <Download size={16} /> {busy ? 'Installing…' : 'Install Checkpoint'}
        </button>
      )}
      <button
        className="icon-button"
        aria-label="Dismiss install suggestion"
        onClick={dismissInstall}
      >
        <X size={17} />
      </button>
    </aside>
  );
}

export function InstallSettings() {
  const { prompt, installed, busy, error } = useInstallation();
  return (
    <section className="settings-section" aria-label="Install app">
      <h2>Install Checkpoint</h2>
      {installed ? (
        <p>Checkpoint is installed. Open it from your device’s apps.</p>
      ) : (
        <>
          <p className="muted">
            Open reviews in a dedicated window from your desktop or home screen.
          </p>
          {prompt && (
            <button
              className="button"
              disabled={busy}
              onClick={() => void installApp()}
            >
              <Download size={16} />{' '}
              {busy ? 'Installing…' : 'Install Checkpoint'}
            </button>
          )}
          <ErrorMessage message={error} />
          {!window.isSecureContext && (
            <p>Open Checkpoint over HTTPS to enable browser installation.</p>
          )}
          <details className="install-help">
            <summary>
              {prompt
                ? 'Other ways to install'
                : 'How to install in your browser'}
            </summary>
            <ul>
              <li>
                <strong>Chrome or Edge:</strong> use the install icon in the
                address bar or the browser’s app installation menu, when
                offered.
              </li>
              <li>
                <strong>iPhone or iPad:</strong> open the Share menu and choose
                Add to Home Screen.
              </li>
              <li>
                <strong>Safari on Mac:</strong> choose File → Add to Dock.
              </li>
            </ul>
            <p>
              Options vary by browser and device. If installation is
              unavailable, keep using Checkpoint in a browser tab.
            </p>
          </details>
        </>
      )}
      <p className="small muted">
        A connection to your Checkpoint server is required to load and save
        reviews.
      </p>
    </section>
  );
}
