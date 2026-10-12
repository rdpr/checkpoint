import { useEffect, useState } from 'react';
import { api, post, errorText } from './api';
import { Modal, ErrorMessage, Loading } from './ui';
export function Account({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<{
    enabled: boolean;
    linked: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<typeof status>('/auth/identity')
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  }, []);
  return (
    <Modal title="Account" onClose={onClose}>
      <ErrorMessage message={error} />
      {!status ? (
        <Loading />
      ) : status.linked ? (
        <p>
          Your Microsoft account is connected. You can use Microsoft sign-in on
          this installation.
        </p>
      ) : !status.enabled ? (
        <p>Microsoft sign-in has not been configured for this installation.</p>
      ) : (
        <form
          className="stack-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const password = new FormData(e.currentTarget).get('password');
            setBusy(true);
            setError(null);
            try {
              const result = await post<{ url: string }>('/auth/entra/start', {
                mode: 'link',
                password,
              });
              location.assign(result.url);
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        >
          <p>
            Connect Microsoft to this account without changing your workspaces
            or permissions. Confirm your current password, then sign in with
            Microsoft.
          </p>
          <label>
            Current password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button primary" disabled={busy}>
            Connect Microsoft account
          </button>
        </form>
      )}
    </Modal>
  );
}
