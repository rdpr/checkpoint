import {
  AgentConnectionSetup,
  ServiceAccounts,
  CredentialDates,
} from './AgentOnboarding';
import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Check, KeyRound, Link, Bot, Users } from 'lucide-react';
import type {
  Workspace,
  User,
  Member,
  TokenInfo,
  InviteInfo,
  Organization,
} from '../shared/types';
import { api, post, errorText, initials, dateLabel } from './api';
import { ErrorMessage, Modal } from './ui';
import { WorkspaceMembership } from './Organization';

export function Access({
  workspace,
  user,
  kind,
  onClose,
  onChanged,
}: {
  workspace: Workspace;
  user: User;
  kind: 'members' | 'agents';
  onClose: () => void;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]),
    [tokens, setTokens] = useState<TokenInfo[]>([]),
    [invites, setInvites] = useState<InviteInfo[]>([]);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [credential, setCredential] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const canManage = workspace.role === 'owner' || !!organization?.isAdmin;
  const base = `/workspaces/${workspace.id}`;
  async function load() {
    const org = await api<Organization>('/organization');
    setOrganization(org);
    if (kind === 'members') {
      setMembers(await api(`${base}/members`));
      const current = (await api<Workspace[]>('/workspaces')).find(
        (w) => w.id === workspace.id,
      );
      if (current?.role === 'owner' || org.isAdmin)
        setInvites(await api(`${base}/invitations`));
    } else setTokens(await api(`${base}/tokens`));
  }
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      onChanged();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    await action(async () => {
      const result = await post<{ token: string }>(
        `${base}/${kind === 'members' ? 'invitations' : 'tokens'}`,
        data,
      );
      setCredential(
        kind === 'members'
          ? `${location.origin}/#invite=${result.token}`
          : result.token,
      );
      setCopied(false);
      form.reset();
    });
  }
  return (
    <Modal
      title={
        kind === 'members' ? 'People in this workspace' : 'Connect your agent'
      }
      onClose={onClose}
    >
      <p className="muted">
        {kind === 'members'
          ? `${workspace.name} · Share a place to write, discuss, and decide.`
          : 'Give an agent access to this workspace through MCP or the HTTP API.'}
      </p>
      <ErrorMessage message={error} />
      {error && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void action(async () => {})}
        >
          Refresh access settings
        </button>
      )}
      {credential && (
        <div className="credential-box">
          <strong>
            {kind === 'members'
              ? 'Your invitation link'
              : 'Copy your agent key now'}
          </strong>
          <p>
            {kind === 'members'
              ? 'Single use. Expires in 48 hours. Share this link privately.'
              : 'Shown once. Expires in 90 days. Store it in your MCP client’s secret settings.'}
          </p>
          <div className="copy-row">
            <input
              readOnly
              aria-label={kind === 'members' ? 'Invitation link' : 'Agent key'}
              value={credential}
            />
            <button
              className="icon-button"
              aria-label="Copy credential"
              onClick={() => {
                navigator.clipboard
                  .writeText(credential)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError(
                      'Select and copy the value manually. Clipboard access is unavailable.',
                    ),
                  );
              }}
            >
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
        </div>
      )}
      {kind === 'members' ? (
        <>
          {canManage && organization ? (
            <WorkspaceMembership
              workspaceId={workspace.id}
              members={members}
              people={members}
              user={user}
              isAdmin={false}
              busy={busy}
              change={async (path, body) => {
                if (busy) return false;
                let ok = false;
                await action(async () => {
                  await post(path, {
                    ...body,
                    expectedVersion: organization.version,
                  });
                  ok = true;
                });
                return ok;
              }}
            />
          ) : (
            <div className="member-list">
              {members.map((m) => (
                <div className="member" key={m.id}>
                  <span className="avatar">{initials(m.name)}</span>
                  <div>
                    <strong>
                      {m.name}
                      {m.id === user.id ? ' (you)' : ''}
                    </strong>
                    <small>{m.email}</small>
                  </div>
                  <span className="pill">{m.role}</span>
                  {m.teams.length > 0 && (
                    <small>Via {m.teams.map((t) => t.name).join(', ')}</small>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage ? (
            <>
              <form onSubmit={create} className="inline-form">
                <label>
                  Invite someone as
                  <select name="role">
                    <option value="editor">Editor — write and discuss</option>
                    <option value="viewer">Viewer — read only</option>
                  </select>
                </label>
                <button className="button primary" disabled={busy}>
                  <Link size={16} />
                  Create invite link
                </button>
              </form>
              <p className="small muted">
                The recipient can create an account or sign in. Invitations
                grant access to this workspace only.
              </p>
              {invites.length > 0 && (
                <div className="access-list">
                  <h3>Pending invitations</h3>
                  {invites.map((i) => (
                    <div className="access-row" key={i.id}>
                      <Users size={16} />
                      <div>
                        <strong>{i.role} invitation</strong>
                        <small>Expires {dateLabel(i.expiresAt)}</small>
                      </div>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api(`${base}/invitations/${i.id}`, {
                              method: 'DELETE',
                            }),
                          )
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="small muted">
              The owner manages invitations and membership.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="connection-info">
            <Bot size={24} />
            <div>
              <strong>Streamable HTTP</strong>
              <code>{location.origin}/mcp</code>
              <small>Authorization: Bearer &lt;your agent key&gt;</small>
            </div>
          </div>
          <AgentConnectionSetup
            credential={credential}
            workspaceId={workspace.id}
            onChecked={() => void load().catch((e) => setError(errorText(e)))}
          />
          <h3>Personal agent key</h3>
          <form onSubmit={create} className="token-form">
            <label>
              Agent name
              <input
                name="name"
                placeholder="e.g. Planning agent"
                maxLength={80}
                required
              />
            </label>
            <label>
              Access
              <select name="scope">
                <option value="read">Read documents and discussions</option>
                {workspace.role !== 'viewer' && (
                  <option value="write">Read, edit, and comment</option>
                )}
              </select>
            </label>
            <button className="button primary" disabled={busy}>
              <KeyRound size={16} />
              Create agent key
            </button>
          </form>
          <p className="small muted">
            Agent changes are attributed to the key’s name and your account.
            Keys cannot manage members or create other keys.
          </p>
          <div className="access-list">
            <h3>Your agent keys</h3>
            {tokens.length ? (
              tokens.map((t) => (
                <div className="access-row" key={t.id}>
                  <KeyRound size={16} />
                  <div>
                    <strong>
                      {t.name} <span className="pill">{t.scope}</span>
                    </strong>
                    <small>Owned by {user.name} · Personal account</small>
                    <CredentialDates token={t} />
                  </div>
                  <button
                    disabled={busy}
                    className="text-button danger"
                    onClick={() =>
                      void action(() =>
                        api(`${base}/tokens/${t.id}`, { method: 'DELETE' }),
                      )
                    }
                  >
                    Revoke
                  </button>
                </div>
              ))
            ) : (
              <p className="muted small">
                No keys yet. Create one to bring an agent into the conversation.
              </p>
            )}
          </div>
          {canManage && (
            <ServiceAccounts
              workspaceId={workspace.id}
              onCredential={(key) => {
                setCredential(key);
                setCopied(false);
              }}
            />
          )}
        </>
      )}
    </Modal>
  );
}
