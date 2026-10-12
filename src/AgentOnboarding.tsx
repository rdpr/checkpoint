import { Select } from './Select';
import { useEffect, useState } from 'react';
import type {
  AgentConnection,
  ServiceAccount,
  TokenInfo,
} from '../shared/types';
import { api, post, errorText, dateLabel } from './api';
import { ErrorMessage } from './ui';

export function AgentConnectionSetup({
  credential,
  workspaceId,
  onChecked,
}: {
  credential: string | null;
  workspaceId: string;
  onChecked: () => void;
}) {
  const [key, setKey] = useState(credential ?? ''),
    [result, setResult] = useState<AgentConnection | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    setKey(credential ?? '');
    setResult(null);
    setCopied(false);
  }, [credential]);
  const config = JSON.stringify(
    {
      mcpServers: {
        workspaces: {
          type: 'http',
          url: `${location.origin}/mcp`,
          headers: { Authorization: `Bearer ${key || '<YOUR_AGENT_KEY>'}` },
        },
      },
    },
    null,
    2,
  );
  async function check() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      async function rpc(id: number, method: string, params: unknown) {
        const response = await fetch('/mcp', {
          method: 'POST',
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok || data.error || data.result?.isError)
          throw new Error(
            data.message ??
              data.error?.message ??
              data.result?.content?.[0]?.text ??
              'MCP connection failed.',
          );
        return data.result;
      }
      await rpc(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'workspaces-connection-check', version: '1.0' },
      });
      const result = await rpc(2, 'tools/call', {
        name: 'connection_info',
        arguments: {},
      });
      const info = result.structuredContent?.result as AgentConnection;
      if (!info?.workspace)
        throw new Error('The server did not return connection information.');
      if (info.workspace.id !== workspaceId)
        throw new Error(
          `This key belongs to ${info.workspace.name}. Use a key for the current workspace.`,
        );
      setResult(info);
      onChecked();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="setup-card agent-onboarding">
      <h3>
        <span className="step-number">2</span>Connect your client
      </h3>
      <p className="small muted">
        Streamable HTTP MCP configuration for clients that accept mcpServers
        JSON. This configuration includes your secret when a key is entered;
        store it privately.
      </p>
      <label>
        Key to check
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setResult(null);
            setCopied(false);
          }}
          placeholder="Paste an existing key or create one above"
        />
      </label>
      <textarea
        aria-label="MCP connection configuration"
        readOnly
        value={config}
        spellCheck={false}
      />
      <div className="button-row">
        <button
          className="button"
          onClick={() =>
            void navigator.clipboard
              .writeText(config)
              .then(() => setCopied(true))
              .catch(() =>
                setError(
                  'Select and copy the configuration manually. Clipboard access is unavailable.',
                ),
              )
          }
        >
          {copied ? 'Configuration copied' : 'Copy connection configuration'}
        </button>
        <button
          className="button"
          disabled={!key.trim() || busy}
          onClick={() => void check()}
        >
          {busy ? 'Checking…' : 'Check connection'}
        </button>
      </div>
      <ErrorMessage message={error} />
      {result && (
        <p role="status">
          Connected to <strong>{result.workspace.name}</strong> ·{' '}
          {result.credential.scope === 'write'
            ? 'Read, edit, and comment'
            : 'Read only'}{' '}
          ·{' '}
          {result.credential.ownerType === 'service'
            ? 'Workspace service account'
            : 'Personal account'}
          : {result.credential.ownerName}. Key expires{' '}
          {dateLabel(result.credential.expiresAt)}.
        </p>
      )}
    </section>
  );
}
export function ServiceAccounts({
  workspaceId,
  onCredential,
}: {
  workspaceId: string;
  onCredential: (key: string) => void;
}) {
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null);
  const base = `/workspaces/${workspaceId}/service-accounts`;
  const load = () => api<ServiceAccount[]>(base).then(setAccounts);
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, [workspaceId]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      setConfirm(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="setup-card service-accounts">
      <h3>Workspace service accounts</h3>
      <p className="small muted">
        For unattended automation. Workspace owners and organization
        administrators manage these accounts. Their keys survive their creator’s
        departure; disabling an account revokes all its keys. They cannot sign
        in, manage access, or submit human approvals.
      </p>
      <ErrorMessage message={error} />
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = Object.fromEntries(new FormData(form));
          void action(async () => {
            await post(base, data);
            form.reset();
          });
        }}
      >
        <label>
          Service account name
          <input
            name="name"
            required
            maxLength={80}
            placeholder="e.g. Release automation"
          />
        </label>
        <label>
          Maximum access
          <Select name="scope">
            <option value="read">Read only</option>
            <option value="write">Read, edit, and comment</option>
          </Select>
        </label>
        <button className="button" disabled={busy}>
          Create service account
        </button>
      </form>
      {accounts.map((a) => (
        <section
          className="service-account"
          key={a.id}
          aria-label={`Service account ${a.name}`}
        >
          <strong>
            {a.name}{' '}
            <span className="pill">{a.disabledAt ? 'Disabled' : a.scope}</span>
          </strong>
          <p className="small muted">
            Workspace-managed · Created by {a.createdBy}
          </p>
          {!a.disabledAt && (
            <>
              <form
                className="token-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const data = Object.fromEntries(new FormData(form));
                  void action(async () => {
                    const result = await post<{ token: string }>(
                      `${base}/${a.id}/tokens`,
                      data,
                    );
                    onCredential(result.token);
                    form.reset();
                  });
                }}
              >
                <label>
                  Service key name
                  <input
                    name="name"
                    maxLength={80}
                    required
                    placeholder="e.g. Production runner"
                  />
                </label>
                <label>
                  Key access
                  <Select name="scope">
                    <option value="read">Read only</option>
                    {a.scope === 'write' && (
                      <option value="write">Read, edit, and comment</option>
                    )}
                  </Select>
                </label>
                <button className="button" disabled={busy}>
                  Create service key
                </button>
              </form>
              <div className="access-list">
                {a.tokens.map((t) => (
                  <div className="access-row" key={t.id}>
                    <div>
                      <strong>
                        {t.name} · {t.scope}
                      </strong>
                      <CredentialDates token={t} />
                    </div>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api(`${base}/${a.id}/tokens/${t.id}`, {
                            method: 'DELETE',
                          }),
                        )
                      }
                    >
                      Revoke key
                    </button>
                  </div>
                ))}
              </div>
              {confirm === a.id ? (
                <div>
                  <p>
                    Disable {a.name} and revoke every key immediately? Existing
                    artifact history remains.
                  </p>
                  <div className="button-row">
                    <button
                      className="button danger"
                      disabled={busy}
                      onClick={() =>
                        void action(() => post(`${base}/${a.id}/disable`))
                      }
                    >
                      Disable and revoke keys
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setConfirm(null)}
                    >
                      Keep account
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() => setConfirm(a.id)}
                >
                  Disable account
                </button>
              )}
            </>
          )}
        </section>
      ))}
    </section>
  );
}
export function CredentialDates({ token: t }: { token: TokenInfo }) {
  return (
    <small>
      Expires {dateLabel(t.expiresAt)} ·{' '}
      {t.lastUsedAt
        ? `Last connected ${dateLabel(t.lastUsedAt)}`
        : 'Not connected yet'}
    </small>
  );
}
