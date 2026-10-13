import { useSyncExternalStore } from 'react';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const dismissalKey = 'checkpoint-install-dismissed-until';
const displayMode = window.matchMedia('(display-mode: standalone)');
const isStandalone = () =>
  displayMode.matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
let dismissedUntil = 0;
try {
  dismissedUntil = Number(localStorage.getItem(dismissalKey)) || 0;
} catch {}
let state = {
  prompt: null as InstallPrompt | null,
  installed: isStandalone(),
  dismissed: dismissedUntil > Date.now(),
  busy: false,
  error: null as string | null,
};
const listeners = new Set<() => void>();
function update(next: Partial<typeof state>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

// Capture the browser event before React mounts, including on deep links.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  update({ prompt: event as InstallPrompt, error: null });
});
window.addEventListener('appinstalled', () => {
  update({ installed: true, prompt: null, busy: false, error: null });
});
displayMode.addEventListener('change', () => {
  if (isStandalone()) update({ installed: true, prompt: null });
});

export function dismissInstall() {
  try {
    localStorage.setItem(dismissalKey, String(Date.now() + 30 * 86400_000));
  } catch {}
  update({ dismissed: true });
}

export async function installApp() {
  const prompt = state.prompt;
  if (!prompt || state.busy || state.installed) return;
  update({ busy: true, error: null });
  try {
    // Invoke directly from the click: the browser requires user activation.
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    update({
      prompt: null,
      installed: outcome === 'accepted' || state.installed,
    });
    if (outcome === 'dismissed') dismissInstall();
  } catch {
    update({
      prompt: null,
      error:
        'The installation prompt could not open. Use your browser’s install menu, or reload to try again.',
    });
  } finally {
    update({ busy: false });
  }
}

export function useInstallation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}
