import { navigate } from './navigation';
import { useConfirm } from './Confirm';
import { Select } from './Select';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AuditEntry,
  Member,
  OrganizationAdmin,
  Team,
  User,
} from '../shared/types';
import { api, post, errorText, dateLabel } from './api';
import { ErrorMessage, Loading, SettingsPage } from './ui';

type Change = (
  path: string,
  body: Record<string, unknown>,
  method?: string,
) => Promise<boolean>;
const formData = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return new FormData(e.currentTarget);
};

export function WorkspaceMembership({
  workspaceId,
  members,
  people,
  user,
  isAdmin,
  busy,
  change,
}: {
  workspaceId: string;
  members: Member[];
  people: User[];
  user: User;
  isAdmin: boolean;
  busy: boolean;
  change: Change;
}) {
  const confirm = useConfirm();
  const owners = members.filter((m) => m.directRole === 'owner');
  const base = `/workspaces/${workspaceId}`;
  return (
    <div className="administration-section">
      <p className="small muted">
        The highest role from direct membership and teams applies. Removing
        direct access keeps any access granted by a team.
      </p>
      <div className="member-admin-list">
        {members.map((m) => (
          <div className="administration-card member-admin-row" key={m.id}>
            <div className="member-identity">
              <strong>
                {m.name}
                {m.id === user.id ? ' (you)' : ''}
              </strong>{' '}
              <span className="pill">{m.role}</span>
              <small className="muted">{m.email}</small>
              {m.teams.length > 0 && (
                <p className="small">
                  Via {m.teams.map((t) => `${t.name} (${t.role})`).join(', ')}
                </p>
              )}
            </div>
            <form
              className="inline-form"
              onSubmit={(e) => {
                const data = formData(e);
                void change(`${base}/membership`, {
                  userId: m.id,
                  role: data.get('role') || null,
                });
              }}
            >
              <label>
                <span className="sr-only">Direct role for {m.name}</span>
                <Select
                  aria-label={`Direct role for ${m.name}`}
                  name="role"
                  defaultValue={m.directRole ?? ''}
                  key={m.directRole ?? ''}
                  disabled={busy}
                >
                  <option value="">No direct access</option>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </Select>
              </label>
              <button className="button" disabled={busy}>
                Save role
              </button>
            </form>
          </div>
        ))}
      </div>
      {isAdmin && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            const data = formData(e);
            void change(`${base}/membership`, {
              userId: data.get('userId'),
              role: data.get('role'),
            });
          }}
        >
          <label>
            Add organization member
            <Select
              searchable
              aria-label="Add organization member"
              name="userId"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Choose a person
              </option>
              {people
                .filter((p) => !members.some((m) => m.id === p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.email}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            Role
            <Select name="role">
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="owner">Owner</option>
            </Select>
          </label>
          <button className="button" disabled={busy}>
            Add member
          </button>
        </form>
      )}
      <section className="settings-section ownership-section">
        <h3>Transfer ownership</h3>
        <p className="small muted">
          The successor becomes an owner. The previous owner keeps editor
          access. Other owners stay in place.
        </p>
        <form
          className="stack-form"
          onSubmit={async (e) => {
            const data = formData(e);
            if (
              await confirm(
                'Transfer ownership? The previous owner will become an editor.',
              )
            )
              void change(`${base}/ownership`, {
                fromUserId: data.get('from'),
                toUserId: data.get('to'),
              });
          }}
        >
          <label>
            Current owner
            <Select searchable aria-label="Current owner" name="from" required>
              {owners
                .filter((p) => isAdmin || p.id === user.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            New owner
            <Select
              searchable
              aria-label="New owner"
              name="to"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Choose a successor
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.email}
                </option>
              ))}
            </Select>
          </label>
          <button className="button" disabled={busy}>
            Transfer ownership
          </button>
        </form>
      </section>
    </div>
  );
}

export function OrganizationSettings({
  user,
  onClose,
  onChanged,
}: {
  user: User;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [data, setData] = useState<OrganizationAdmin | null>(null);
  const sections = ['People', 'Teams', 'Workspaces', 'Agent keys', 'Audit log'];
  const readSection = () => {
    const value = new URLSearchParams(location.search).get('section');
    return value && sections.includes(value) ? value : 'People';
  };
  const [tab, selectTab] = useState(readSection);
  useEffect(() => {
    const read = () => selectTab(readSection());
    window.addEventListener('popstate', read);
    window.addEventListener('pw:navigate', read);
    return () => {
      window.removeEventListener('popstate', read);
      window.removeEventListener('pw:navigate', read);
    };
  }, []);
  const setTab = (tab: string) => {
    const url = new URL(location.href);
    url.searchParams.set('section', tab);
    navigate(url);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [team, setTeam] = useState<Team | 'new' | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [offboardId, setOffboardId] = useState<string | null>(null);
  const teamForm = useRef<HTMLFormElement>(null);
  const offboardForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!team) return;
    teamForm.current?.scrollIntoView({ block: 'start' });
    teamForm.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [team]);
  useEffect(() => {
    if (!offboardId) return;
    offboardForm.current?.scrollIntoView({ block: 'start' });
    offboardForm.current?.querySelector('h3')?.focus({ preventScroll: true });
  }, [offboardId]);
  const [expandedAudit, setExpandedAudit] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  async function loadAudit(before?: number) {
    const result = await api<{ entries: AuditEntry[]; next: number | null }>(
      `/organization/audit${before ? `?before=${before}` : ''}`,
    );
    setAudit((old) => (before ? [...old, ...result.entries] : result.entries));
    setCursor(result.next);
  }
  async function load() {
    setData(await api('/organization/admin'));
    await loadAudit();
  }
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, []);
  const change: Change = async (path, body, method = 'POST') => {
    if (!data || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ isAdmin: boolean }>(path, {
        method,
        body: JSON.stringify({ ...body, expectedVersion: data.version }),
      });
      onChanged();
      if (!result.isAdmin) {
        onClose();
        return true;
      }
      await load();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const active = data?.people.filter((p) => !p.disabledAt) ?? [];
  const workspace = data?.workspaces.find((w) => w.id === workspaceId);
  const person = data?.people.find((p) => p.id === offboardId);
  function describe(value: unknown): string {
    if (value === null) return 'None';
    if (Array.isArray(value)) return value.map(describe).join(', ') || 'None';
    if (typeof value === 'object')
      return Object.values(value as object)
        .map(describe)
        .join(' · ');
    return (
      data?.people.find((p) => p.id === value)?.name ??
      data?.workspaces.find((w) => w.id === value)?.name ??
      data?.teams.find((t) => t.id === value)?.name ??
      String(value)
    );
  }
  const detailLabels: Record<string, string> = {
    userId: 'Person',
    role: 'Role',
    previousRole: 'Previous role',
    fromUserId: 'Previous owner',
    toUserId: 'New owner',
    successorId: 'Successor',
    workspaceId: 'Workspace',
    transferredWorkspaceIds: 'Transferred workspaces',
    memberIds: 'People',
    workspaces: 'Workspace access',
    teamId: 'Team',
    tokenId: 'Key identifier',
    invitationId: 'Invitation identifier',
    scope: 'Access',
  };
  return (
    <SettingsPage title="Organization" onClose={onClose}>
      <div className="organization-settings">
        <p className="muted">
          {data?.name ?? 'Organization administration'}
        </p>
        <div
          className="administration-tabs"
          role="tablist"
          aria-label="Organization settings"
        >
          {['People', 'Teams', 'Workspaces', 'Agent keys', 'Audit log'].map(
            (t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={`button ${tab === t ? 'primary' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ),
          )}
        </div>
        <ErrorMessage message={error} />
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setError(null);
            void load().catch((e) => setError(errorText(e)));
          }}
        >
          Refresh settings
        </button>
        {!data ? (
          <Loading label="Loading organization…" />
        ) : (
          <div role="tabpanel" aria-label={tab}>
            {tab === 'People' && (
              <>
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    const form = formData(e);
                    void change('/organization', { name: form.get('name') });
                  }}
                >
                  <label>
                    Organization name
                    <input
                      name="name"
                      required
                      maxLength={100}
                      defaultValue={data.name}
                      key={data.name}
                    />
                  </label>
                  <button className="button" disabled={busy}>
                    Save name
                  </button>
                </form>
                <p className="small muted">
                  Open Members from your account menu to invite people to a workspace.
                  Administrators manage access across the organization; artifact
                  access still requires workspace membership.
                </p>
                <div className="member-admin-list">
                  {data.people.map((p) => (
                    <div
                      className="administration-card member-admin-row organization-person"
                      key={p.id}
                    >
                      <div className="member-identity">
                        <strong>
                          {p.name}
                          {p.id === user.id ? ' (you)' : ''}
                        </strong>
                        <small className="muted">{p.email}</small>
                      </div>
                      {p.disabledAt ? (
                        <>
                          <p className="small">
                            Offboarded {dateLabel(p.disabledAt)}. History
                            retained.
                          </p>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={async () => {
                              if (
                                await confirm(
                                  `Reactivate ${p.name}? Their previous memberships, sessions, and keys will stay revoked.`,
                                )
                              )
                                void change(
                                  `/organization/people/${p.id}/reactivate`,
                                  {},
                                );
                            }}
                          >
                            Reactivate account
                          </button>
                        </>
                      ) : (
                        <>
                          <form
                            className="inline-form"
                            onSubmit={(e) => {
                              const form = formData(e);
                              void change(`/organization/people/${p.id}/role`, {
                                role: form.get('role'),
                              });
                            }}
                          >
                            <label>
                              <span className="sr-only">
                                Organization role for {p.name}
                              </span>
                              <Select
                                aria-label={`Organization role for ${p.name}`}
                                name="role"
                                defaultValue={p.orgRole}
                                key={p.orgRole}
                              >
                                <option value="member">Member</option>
                                <option value="admin">Administrator</option>
                              </Select>
                            </label>
                            <button className="button" disabled={busy}>
                              Save organization role
                            </button>
                          </form>
                          {p.id !== user.id && (
                            <button
                              className="text-button danger"
                              disabled={busy}
                              onClick={() => setOffboardId(p.id)}
                            >
                              Offboard {p.name}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {person && (
                  <form
                    className="administration-card stack-form"
                    aria-label={`Offboard ${person.name}`}
                    ref={offboardForm}
                    onSubmit={async (e) => {
                      const form = formData(e);
                      const successorId = form.get('successor') as string;
                      if (
                        await confirm(
                          `Offboard ${person.name}? This revokes all sessions, agent keys, issued invitations, and memberships.`,
                        )
                      )
                        void change(
                          `/organization/people/${person.id}/offboard`,
                          successorId ? { successorId } : {},
                        ).then((ok) => {
                          if (ok) setOffboardId(null);
                        });
                    }}
                  >
                    <h3 tabIndex={-1}>Offboard {person.name}</h3>
                    <p>
                      Sign this person out everywhere, revoke their agent keys
                      and invitations, and remove direct and team access.
                      Artifacts, discussions, and review history remain.
                    </p>
                    <p className="small">
                      Solely owned workspaces:{' '}
                      {data.workspaces
                        .filter(
                          (w) =>
                            w.members.some(
                              (m) => m.id === person.id && m.role === 'owner',
                            ) &&
                            w.members.filter((m) => m.role === 'owner')
                              .length === 1,
                        )
                        .map((w) => w.name)
                        .join(', ') || 'None'}
                      .
                    </p>
                    <label>
                      Successor for owned workspaces
                      <Select
                        searchable
                        aria-label="Successor for owned workspaces"
                        name="successor"
                        defaultValue=""
                      >
                        <option value="">
                          Choose if this person is the only owner
                        </option>
                        {active
                          .filter((p) => p.id !== person.id)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} · {p.email}
                            </option>
                          ))}
                      </Select>
                    </label>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="button"
                        onClick={() => setOffboardId(null)}
                      >
                        Cancel offboarding
                      </button>
                      <button className="button danger" disabled={busy}>
                        Confirm offboarding
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
            {tab === 'Teams' && (
              <>
                <p className="small muted">
                  Teams grant editor or viewer access to selected workspaces.
                  The highest grant applies alongside direct membership.
                </p>
                {!data.teams.length && (
                  <p className="list-empty">
                    No teams yet. Create a team to manage shared workspace
                    access.
                  </p>
                )}
                {data.teams.map((t) => (
                  <div className="access-row" key={t.id}>
                    <div>
                      <strong>{t.name}</strong>
                      <small>
                        {t.memberIds.length} people · {t.workspaces.length}{' '}
                        workspaces
                      </small>
                    </div>
                    <button className="button" onClick={() => setTeam(t)}>
                      Edit {t.name}
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await confirm(
                            `Delete ${t.name}? Access granted through this team will be removed.`,
                          )
                        )
                          void change(
                            `/organization/teams/${t.id}`,
                            {},
                            'DELETE',
                          ).then((ok) => {
                            if (ok) setTeam(null);
                          });
                      }}
                    >
                      Delete {t.name}
                    </button>
                  </div>
                ))}
                <button className="button" onClick={() => setTeam('new')}>
                  Create team
                </button>
                {team && (
                  <form
                    key={team === 'new' ? 'new' : team.id}
                    ref={teamForm}
                    className="administration-card stack-form"
                    onSubmit={(e) => {
                      const form = formData(e);
                      const workspaces = data.workspaces.flatMap((w) => {
                        const role = form.get(`workspace:${w.id}`);
                        return role ? [{ workspaceId: w.id, role }] : [];
                      });
                      void change(
                        `/organization/teams${team === 'new' ? '' : `/${team.id}`}`,
                        {
                          name: form.get('name'),
                          memberIds: form.getAll('member'),
                          workspaces,
                        },
                      ).then((ok) => {
                        if (ok) setTeam(null);
                      });
                    }}
                  >
                    <label>
                      Team name
                      <input
                        name="name"
                        required
                        maxLength={100}
                        defaultValue={team === 'new' ? '' : team.name}
                      />
                    </label>
                    <fieldset>
                      <legend>People</legend>
                      {active.map((p) => (
                        <label className="administration-checkbox" key={p.id}>
                          <input
                            type="checkbox"
                            name="member"
                            value={p.id}
                            defaultChecked={
                              team !== 'new' && team.memberIds.includes(p.id)
                            }
                          />
                          {p.name} · {p.email}
                        </label>
                      ))}
                    </fieldset>
                    <fieldset className="stack-form">
                      <legend>Workspace access</legend>
                      {data.workspaces.map((w) => (
                        <label key={w.id}>
                          Team access to {w.name}
                          <Select
                            aria-label={`Team access to ${w.name}`}
                            name={`workspace:${w.id}`}
                            defaultValue={
                              team === 'new'
                                ? ''
                                : (team.workspaces.find(
                                    (g) => g.workspaceId === w.id,
                                  )?.role ?? '')
                            }
                          >
                            <option value="">No access</option>
                            <option value="viewer">Viewer</option>
                            <option value="editor">Editor</option>
                          </Select>
                        </label>
                      ))}
                    </fieldset>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="button"
                        onClick={() => setTeam(null)}
                      >
                        Cancel team changes
                      </button>
                      <button className="button primary" disabled={busy}>
                        Save team
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
            {tab === 'Workspaces' && (
              <>
                <label>
                  Manage workspace
                  <Select
                    searchable
                    aria-label="Manage workspace"
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                  >
                    <option value="">Choose a workspace</option>
                    {data.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                </label>
                {workspace && (
                  <WorkspaceMembership
                    workspaceId={workspace.id}
                    members={workspace.members}
                    people={active}
                    user={user}
                    isAdmin
                    busy={busy}
                    change={change}
                  />
                )}
              </>
            )}
            {tab === 'Agent keys' && (
              <>
                <p className="small muted">
                  Active personal and service account keys across the
                  organization. Secret values are never displayed here.
                </p>
                {data.credentials.length === 0 && (
                  <p className="list-empty">No active agent keys.</p>
                )}
                {data.credentials.map((t) => (
                  <div className="access-row" key={t.id}>
                    <div>
                      <strong>
                        {t.name} <span className="pill">{t.scope}</span>
                      </strong>
                      <small>
                        {t.userName} ·{' '}
                        {t.ownerType === 'service'
                          ? 'Workspace service account'
                          : 'Personal'}{' '}
                        · {t.workspaceName} · Expires {dateLabel(t.expiresAt)}
                      </small>
                    </div>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await confirm(`Revoke ${t.name} for ${t.userName}?`)
                        )
                          void change(
                            `/organization/credentials/${t.id}/revoke`,
                            {},
                          );
                      }}
                    >
                      Revoke {t.name}
                    </button>
                  </div>
                ))}
              </>
            )}
            {tab === 'Audit log' && (
              <>
                <p className="small muted">
                  Access, account, team, and credential changes, newest first.
                  Artifact and review history stays with each artifact.
                </p>
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Audit log entries"
                  tabIndex={0}
                >
                  <table className="data-table audit-table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">Target</th>
                        <th scope="col">Changed by</th>
                        <th scope="col">When</th>
                        <th scope="col">
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map((entry) => (
                        <Fragment key={entry.id}>
                          <tr>
                            <td>
                              <strong>
                                {entry.action
                                  .replaceAll('.', ' · ')
                                  .replaceAll('_', ' ')}
                              </strong>
                            </td>
                            <td>{describe(entry.target)}</td>
                            <td>{entry.actorName}</td>
                            <td>
                              <time>{dateLabel(entry.createdAt)}</time>
                            </td>
                            <td>
                              {Object.keys(entry.details).length > 0 && (
                                <button
                                  className="text-button"
                                  aria-expanded={expandedAudit === entry.id}
                                  aria-controls={`audit-details-${entry.id}`}
                                  onClick={() =>
                                    setExpandedAudit(
                                      expandedAudit === entry.id
                                        ? null
                                        : entry.id,
                                    )
                                  }
                                >
                                  {expandedAudit === entry.id
                                    ? 'Hide details'
                                    : 'Change details'}
                                </button>
                              )}
                            </td>
                          </tr>
                          {expandedAudit === entry.id && (
                            <tr
                              id={`audit-details-${entry.id}`}
                              className="audit-details"
                            >
                              <td colSpan={5}>
                                <dl>
                                  {Object.entries(entry.details).map(
                                    ([key, value]) => (
                                      <div key={key}>
                                        <dt>{detailLabels[key] ?? key}</dt>
                                        <dd>{describe(value)}</dd>
                                      </div>
                                    ),
                                  )}
                                </dl>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                      {!audit.length && (
                        <tr>
                          <td colSpan={5} className="muted">
                            No administrative changes yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {cursor !== null && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await loadAudit(cursor);
                      } catch (e) {
                        setError(errorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Load older changes
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </SettingsPage>
  );
}
