import { navigate, documentUrl } from './navigation';
import { Drafts } from './Drafts';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Plus,
  FileText,
  Search,
  Users,
  Bot,
  LogOut,
  ChevronRight,
  FolderOpen,
  ClipboardCheck,
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  Building2,
  UserRound,
  Bell,
} from 'lucide-react';
import type {
  User,
  Organization,
  Workspace,
  DocumentSummary,
  ReviewRequest,
  Document,
} from '../shared/types';
import { api, post, errorText, initials, dateLabel } from './api';
import { Auth } from './Auth';
import { Account } from './Account';
import { MyReviews } from './ReviewRequests';
import { SearchDocuments, Notifications } from './Discovery';
import { Access } from './Access';
import { OrganizationSettings } from './Organization';
import { DocumentView } from './DocumentView';
import { Brand, ErrorMessage, Loading, Modal } from './ui';
import { setIdentity } from './identity';
import { useReviewPreferences } from './reviewPreferences';

export function App() {
  const [status, setStatus] = useState<{
    user: User | null;
    needsSetup: boolean;
    setupAllowed: boolean;
    entraEnabled: boolean;
    requireSso: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(() =>
      new URLSearchParams(location.search).get('signinError'),
    ),
    [invitation, setInvitation] = useState(() =>
      new URLSearchParams(location.hash.slice(1)).get('invite'),
    );
  const [expired, setExpired] = useState(false);
  const [disconnected, setDisconnected] = useState(!navigator.onLine);
  useEffect(() => {
    const expire = () => {
      setExpired(true);
      setIdentity(null);
      try {
        sessionStorage.setItem(
          'pw-return',
          JSON.stringify({
            url: location.pathname + location.search,
            userId: status?.user?.id,
          }),
        );
      } catch {}
    };
    const offline = () => setDisconnected(true),
      connected = () => setDisconnected(false);
    const online = () => {
      void api('/auth/status').catch(() => {});
    };
    window.addEventListener('pw:session-expired', expire);
    window.addEventListener('pw:disconnected', offline);
    window.addEventListener('pw:connected', connected);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('pw:session-expired', expire);
      window.removeEventListener('pw:disconnected', offline);
      window.removeEventListener('pw:connected', connected);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [status?.user?.id]);
  const [inviteName, setInviteName] = useState<string | null>(null);
  useEffect(() => {
    api<typeof status>('/auth/status')
      .then((next) => {
        if (next?.user) {
          try {
            const pending = JSON.parse(
              sessionStorage.getItem('pw-return') ?? 'null',
            );
            if (
              pending &&
              (!pending.userId || pending.userId === next.user.id)
            ) {
              const target = new URL(pending.url, location.origin);
              if (target.origin === location.origin)
                history.replaceState(null, '', target);
            }
            sessionStorage.removeItem('pw-return');
          } catch {}
        }
        setStatus(next);
        setIdentity(next?.user ?? null);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (invitation)
      post<{ name: string }>('/invitations/inspect', { token: invitation })
        .then((i) => setInviteName(i.name))
        .catch((e) => setError(errorText(e)));
  }, [invitation]);
  if (!status)
    return (
      <div className="boot">
        <Brand />
        {error ? (
          <>
            <ErrorMessage message={error} />
            <button className="button" onClick={() => location.reload()}>
              Retry
            </button>
          </>
        ) : (
          <Loading />
        )}
      </div>
    );
  const clearInvitation = () => {
    setInvitation(null);
    history.replaceState(null, '', location.pathname + location.search);
  };
  if (!status.user || expired)
    return (
      <>
        {expired && (
          <div className="session-banner" role="alert">
            Your session ended or your signed-in account changed. Sign in to
            resume. Saved drafts remain private to their original account.
          </div>
        )}
        {disconnected && (
          <div className="session-banner" role="status">
            Connection unavailable. Drafts are kept in this browser. Reconnect
            before signing in.
          </div>
        )}
        <Auth
          entraEnabled={status.entraEnabled}
          requireSso={status.requireSso}
          needsSetup={status.needsSetup}
          setupAllowed={status.setupAllowed}
          invitation={invitation}
          inviteName={inviteName}
          onSignedIn={(user) => {
            if (expired && status.user && user.id !== status.user.id) {
              sessionStorage.removeItem('pw-return');
              location.assign('/');
              return;
            }
            sessionStorage.removeItem('pw-return');
            setExpired(false);
            setError(null);
            setIdentity(user);
            setStatus({ ...status, user, needsSetup: false });
            clearInvitation();
          }}
        />
        {error && (
          <div className="global-error">
            <ErrorMessage message={error} />
          </div>
        )}
      </>
    );
  return (
    <>
      {disconnected && (
        <div className="connection-banner" role="status">
          Connection unavailable. Your drafts are saved in this browser; changes
          are not sent automatically. Reconnect, then retry.
        </div>
      )}
      <WorkspaceApp
        key={status.user.id}
        user={status.user}
        onLogout={async () => {
          await post('/auth/logout');
          setIdentity(null);
          sessionStorage.removeItem('pw-return');
          location.assign('/');
        }}
      />
      {error && !invitation && (
        <div className="global-error">
          <ErrorMessage message={error} />
          <button
            className="text-button"
            onClick={() => {
              setError(null);
              const url = new URL(location.href);
              url.searchParams.delete('signinError');
              history.replaceState(null, '', url);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {invitation && (
        <Modal title="Join a workspace" onClose={clearInvitation}>
          <p>
            You’re invited to <strong>{inviteName ?? 'a workspace'}</strong>.
          </p>
          <ErrorMessage message={error} />
          <button
            className="button primary"
            onClick={() => {
              post('/invitations/accept', { token: invitation })
                .then(() => {
                  clearInvitation();
                  location.reload();
                })
                .catch((e) => setError(errorText(e)));
            }}
          >
            Accept invitation
          </button>
        </Modal>
      )}
    </>
  );
}

function WorkspaceApp({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => Promise<void>;
}) {
  const [queue, setQueue] = useState(
    () => new URLSearchParams(location.search).get('view') === 'reviews',
  );
  const [requestVisit, setRequestVisit] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('request'),
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [wid, setWid] = useState(''),
    [documents, setDocuments] = useState<DocumentSummary[]>([]),
    [did, setDid] = useState<string | null>(null);
  const [search, setSearch] = useState(''),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<
      | 'workspace'
      | 'document'
      | 'members'
      | 'agents'
      | 'organization'
      | 'account'
      | 'search'
      | 'notifications'
      | 'drafts'
      | null
    >(null),
    [sidebar, setSidebar] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<{ unreadCount: number }>('/notifications')
        .then((r) => {
          if (active) setUnread(r.unreadCount);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const workspace = workspaces.find((w) => w.id === wid),
    current = documents.find((d) => d.id === did);
  async function refreshWorkspaces() {
    setOrganization(await api<Organization>('/organization'));
    const next = await api<Workspace[]>('/workspaces');
    setWorkspaces(next);
    return next;
  }
  useEffect(() => {
    void refreshWorkspaces()
      .then((next) => {
        const url = new URLSearchParams(location.search),
          wanted = url.get('workspace');
        setWid(next.find((w) => w.id === wanted)?.id ?? next[0]?.id ?? '');
        setDid(url.get('document'));
        if (!wanted && next[0]) {
          const initial = new URL(location.href);
          initial.searchParams.set('workspace', next[0].id);
          history.replaceState(null, '', initial);
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(errorText(e));
        setLoading(false);
      });
  }, []);
  useEffect(() => {
    if (!wid) return;
    let active = true;
    setDocuments([]);
    setLoading(true);
    const load = async () => {
      try {
        const next = await api<DocumentSummary[]>(
          `/workspaces/${wid}/documents?includeArchived=true`,
        );
        if (active) {
          setDocuments(next);
          setLoading(false);
        }
      } catch (e) {
        if (active) {
          setError(errorText(e));
          setLoading(false);
        }
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 7000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [wid]);
  useEffect(() => {
    const readRoute = () => {
      const url = new URLSearchParams(location.search);
      setWid(url.get('workspace') ?? workspaces[0]?.id ?? '');
      setDid(url.get('document'));
      setRequestId(url.get('request'));
      setQueue(url.get('view') === 'reviews');
      setRequestVisit((v) => v + 1);
      setError(null);
    };
    window.addEventListener('popstate', readRoute);
    window.addEventListener('pw:navigate', readRoute);
    return () => {
      window.removeEventListener('popstate', readRoute);
      window.removeEventListener('pw:navigate', readRoute);
    };
  }, [workspaces]);
  function selectDocument(
    id: string | null,
    workspaceId = wid,
    extra: Record<string, string> = {},
  ) {
    navigate(documentUrl(workspaceId, id, extra));
  }
  function openRequest(request: ReviewRequest) {
    updatePreferences({ layout: 'normal' });
    selectDocument(request.documentId, request.workspaceId, {
      request: request.id,
    });
  }
  async function refreshDocuments() {
    if (wid)
      setDocuments(
        await api(`/workspaces/${wid}/documents?includeArchived=true`),
      );
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (modal === 'workspace') {
        const created = await post<Workspace>('/workspaces', values);
        await refreshWorkspaces();
        selectDocument(null, created.id);
      } else {
        const created = await post<Document>('/documents', {
          workspaceId: wid,
          path: values.path,
          body: String(values.body ?? ''),
        });
        await refreshDocuments();
        selectDocument(created.id);
      }
      setModal(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const activeDocumentCount = documents.filter((d) => !d.archivedAt).length;
  const filtered = documents.filter(
    (d) =>
      (showArchived || !d.archivedAt) &&
      d.path.toLowerCase().includes(search.toLowerCase()),
  );
  async function openLink(path: string, revisionId: string) {
    try {
      if (/^(https?:|mailto:)/i.test(path)) {
        const url = new URL(path, location.href);
        if (url.origin === location.origin && url.searchParams.has('document'))
          navigate(url);
        else window.open(path, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!did) return;
      const target = await api<{
        workspaceId: string;
        documentId: string;
        fragment: string;
      }>(
        `/documents/${did}/resolve-link?${new URLSearchParams({ revisionId, href: path })}`,
      );
      selectDocument(target.documentId, target.workspaceId, {
        ...(target.fragment
          ? { heading: decodeURIComponent(target.fragment) }
          : {}),
        ...(path.startsWith('#') ? { revision: revisionId } : {}),
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  const { preferences, updatePreferences, storageError } = useReviewPreferences(
    user.id,
  );
  const readerLayout = !!did && preferences.layout !== 'normal';
  const sidebarVisible = sidebar && !readerLayout;
  return (
    <div className={`app-shell ${sidebarVisible ? '' : 'sidebar-collapsed'}`}>
      {modal === 'search' && (
        <SearchDocuments
          workspaces={workspaces}
          onClose={() => setModal(null)}
          onOpen={(w, d) => {
            setModal(null);
            selectDocument(d, w);
          }}
        />
      )}
      {modal === 'notifications' && (
        <Notifications
          onCount={setUnread}
          onClose={() => setModal(null)}
          onRequest={(r) => {
            setModal(null);
            openRequest(r);
          }}
          onOpen={(w, d, c) => {
            setModal(null);
            updatePreferences({ layout: 'normal' });
            selectDocument(d, w, c ? { comment: c } : {});
          }}
        />
      )}
      {modal === 'drafts' && (
        <Drafts
          user={user}
          onClose={() => setModal(null)}
          onOpen={(w, d, c) => {
            setModal(null);
            updatePreferences({ layout: 'normal' });
            selectDocument(d, w, c ? { comment: c } : {});
          }}
        />
      )}
      {sidebarVisible && (
        <aside className="sidebar">
          <Brand />
          <div className="workspace-picker">
            <span className="workspace-icon">
              {workspace ? initials(workspace.name).slice(0, 1) : 'W'}
            </span>
            <label className="sr-only" htmlFor="workspace-select">
              Current workspace
            </label>
            <select
              id="workspace-select"
              value={wid}
              onChange={(e) => {
                selectDocument(null, e.target.value);
                setSearch('');
              }}
            >
              <option disabled value="">
                Select workspace
              </option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="New workspace"
              title="New workspace"
              onClick={() => {
                setModal('workspace');
                setError(null);
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <button
            className={`sidebar-overview ${!did && !queue ? 'active' : ''}`}
            onClick={() => selectDocument(null)}
          >
            <FolderOpen size={17} />
            All documents
            <span>{activeDocumentCount}</span>
          </button>
          <button
            className={`sidebar-overview ${queue ? 'active' : ''}`}
            onClick={() => {
              selectDocument(null, wid, { view: 'reviews' });
            }}
          >
            <ClipboardCheck size={17} /> My reviews
          </button>
          <div className="sidebar-section-title">
            <span>DOCUMENTS</span>
            {workspace?.role !== 'viewer' && (
              <button
                className="icon-button"
                aria-label="New document"
                title="New document"
                onClick={() => {
                  setModal('document');
                  setError(null);
                }}
              >
                <Plus size={16} />
              </button>
            )}
          </div>
          <div className="sidebar-search">
            <Search size={14} />
            <input
              aria-label="Find a document"
              placeholder="Find a document…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="checkbox-label archive-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <nav className="document-tree" aria-label="Workspace documents">
            {filtered.map((d) => (
              <button
                key={d.id}
                className={d.id === did ? 'active' : ''}
                onClick={() => selectDocument(d.id)}
                title={d.path}
              >
                <FileText size={16} />
                <span>
                  {d.path.includes('/') && (
                    <small>
                      {d.path.slice(0, d.path.lastIndexOf('/') + 1)}
                    </small>
                  )}
                  {d.path.split('/').pop()}
                  {d.archivedAt ? ' · Archived' : ''}
                </span>
                {d.id === did && <span className="active-dot" />}
              </button>
            ))}
            {!loading && !filtered.length && (
              <p className="sidebar-empty">
                {search
                  ? 'No matching documents.'
                  : 'Your first document starts here.'}
              </p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <div className="workspace-links">
              <button onClick={() => setModal('drafts')}>
                <FileText size={17} />
                Saved drafts
              </button>
              <button onClick={() => setModal('account')}>
                <UserRound size={17} />
                Account
              </button>
              {organization?.isAdmin && (
                <button onClick={() => setModal('organization')}>
                  <Building2 size={17} />
                  Organization
                </button>
              )}
              <button onClick={() => setModal('members')} disabled={!workspace}>
                <Users size={17} />
                Members
              </button>
              <button onClick={() => setModal('agents')} disabled={!workspace}>
                <Bot size={17} />
                Agent access
                <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="user-card">
              <span className="avatar">{initials(user.name)}</span>
              <div>
                <strong>{user.name}</strong>
                <small>{workspace?.role ?? 'Member'}</small>
              </div>
              <button
                className="icon-button"
                aria-label="Sign out"
                title="Sign out"
                onClick={() =>
                  void onLogout().catch((e) => setError(errorText(e)))
                }
              >
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </aside>
      )}
      <main className="app-main">
        <header className="app-header">
          <div className="breadcrumb">
            <button
              className="icon-button"
              aria-label={
                sidebarVisible ? 'Collapse sidebar' : 'Expand sidebar'
              }
              onClick={() => {
                if (readerLayout) {
                  updatePreferences({ layout: 'normal' });
                  setSidebar(true);
                } else setSidebar(!sidebar);
              }}
            >
              {sidebarVisible ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
            <span>{workspace?.name ?? 'Workspaces'}</span>
            <ChevronRight size={13} />
            <strong>
              {queue ? 'My reviews' : (current?.path ?? 'All documents')}
            </strong>
          </div>
          <div className="button-row">
            <button className="text-button" onClick={() => setModal('search')}>
              <Search size={16} />
              Search
            </button>
            <button
              className="text-button"
              onClick={() => setModal('notifications')}
            >
              <Bell size={16} />
              Notifications{unread > 0 ? ` (${unread})` : ''}
            </button>
          </div>
          <span className="private-label">
            <span />
            Private workspace
          </span>
        </header>
        {error && !modal && (
          <div className="app-error">
            <ErrorMessage message={error} />
            <button className="text-button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {queue ? (
          <MyReviews workspaceId="" user={user} onOpen={openRequest} />
        ) : workspace && did ? (
          <DocumentView
            key={`${wid}:${did}:${requestId ?? ''}:${requestVisit}`}
            id={did}
            requestId={requestId}
            onOpenRequest={openRequest}
            user={user}
            preferences={preferences}
            updatePreferences={updatePreferences}
            preferenceError={storageError}
            workspace={workspace}
            onSaved={() =>
              void refreshDocuments().catch((e) => setError(errorText(e)))
            }
            onLink={openLink}
          />
        ) : loading ? (
          <Loading />
        ) : (
          <section className="workspace-home">
            <div className="home-title">
              <div>
                <span className="eyebrow">THINK IT THROUGH, TOGETHER</span>
                <h1>
                  {workspace?.name ?? 'Your work starts here'}
                  <span>.</span>
                </h1>
                <p>Plans worth discussing. Decisions worth keeping.</p>
              </div>
              {workspace ? (
                workspace.role !== 'viewer' && (
                  <button
                    className="button primary"
                    onClick={() => {
                      setModal('document');
                      setError(null);
                    }}
                  >
                    <Plus size={17} />
                    New document
                  </button>
                )
              ) : (
                <button
                  className="button primary"
                  onClick={() => setModal('workspace')}
                >
                  <Plus size={17} />
                  Create workspace
                </button>
              )}
            </div>
            {workspace && (
              <>
                <div className="workspace-summary">
                  <div>
                    <FileText size={20} />
                    <strong>{activeDocumentCount}</strong>
                    <span>
                      {activeDocumentCount === 1
                        ? 'shared document'
                        : 'shared documents'}
                    </span>
                  </div>
                  <button onClick={() => setModal('members')}>
                    <Users size={19} />
                    <span>A place for your team</span>
                    <ArrowUpRight size={16} />
                  </button>
                  <button onClick={() => setModal('agents')}>
                    <Bot size={19} />
                    <span>Bring an agent into the loop</span>
                    <ArrowUpRight size={16} />
                  </button>
                </div>
                <div className="document-list-heading">
                  <h2>
                    Your documents <span>{filtered.length}</span>
                  </h2>
                  <span>LAST UPDATED</span>
                </div>
                <div className="document-list">
                  {filtered.map((d) => (
                    <button key={d.id} onClick={() => selectDocument(d.id)}>
                      <span className="file-icon">
                        <FileText size={23} strokeWidth={1.5} />
                      </span>
                      <span className="file-title">
                        <strong>
                          {d.path
                            .split('/')
                            .pop()
                            ?.replace(/\.md$/i, '')
                            .replace(/[-_]/g, ' ')}
                        </strong>
                        <small>{d.path}</small>
                      </span>
                      <time>{dateLabel(d.updatedAt)}</time>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                  {!filtered.length && (
                    <div className="home-empty">
                      <FileText size={32} strokeWidth={1.2} />
                      <h3>
                        {search
                          ? 'No documents match your search.'
                          : 'Give your next idea a home.'}
                      </h3>
                      <p>
                        {search
                          ? 'Try another name or path.'
                          : 'Start with a plan, a specification, or an open question.'}
                      </p>
                    </div>
                  )}
                </div>
                <div className="home-footer">
                  <span className="small-brand-mark">w·</span>
                  <span>
                    Built for thoughtful work.
                    <br />
                    <small>
                      Documents and discussions stay on your server.
                    </small>
                  </span>
                </div>
              </>
            )}
          </section>
        )}
      </main>
      {modal === 'account' && <Account onClose={() => setModal(null)} />}
      {modal === 'organization' && (
        <OrganizationSettings
          user={user}
          onClose={() => setModal(null)}
          onChanged={() => {
            void refreshWorkspaces().catch((e) => setError(errorText(e)));
          }}
        />
      )}
      {(modal === 'members' || modal === 'agents') && workspace && (
        <Access
          key={`${wid}:${modal}`}
          workspace={workspace}
          user={user}
          kind={modal}
          onChanged={() => {
            void refreshWorkspaces().catch((e) => setError(errorText(e)));
          }}
          onClose={() => setModal(null)}
        />
      )}
      {(modal === 'workspace' || modal === 'document') && (
        <Modal
          title={
            modal === 'workspace' ? 'Create a workspace' : 'Start a document'
          }
          onClose={() => setModal(null)}
        >
          <p className="muted">
            {modal === 'workspace'
              ? 'A private home for a project and the people working on it.'
              : 'A clear plan begins with a few words. You can keep editing after you create it.'}
          </p>
          <ErrorMessage message={error} />
          <form onSubmit={create} className="create-form">
            {modal === 'workspace' ? (
              <label>
                Workspace name
                <input
                  name="name"
                  placeholder="e.g. Product development"
                  required
                  maxLength={100}
                  autoFocus
                />
              </label>
            ) : (
              <>
                <label>
                  Document path
                  <input
                    name="path"
                    placeholder="e.g. plans/next-release.md"
                    required
                    maxLength={240}
                    pattern=".*\.[mM][dD]"
                    autoFocus
                  />
                  <small>Use folders to keep related documents together.</small>
                </label>
                <label>
                  Starting content
                  <textarea
                    name="body"
                    placeholder={
                      '# The next great idea\n\nWhat are we trying to achieve?'
                    }
                    rows={7}
                    maxLength={1000000}
                  />
                </label>
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy
                  ? 'Creating…'
                  : modal === 'workspace'
                    ? 'Create workspace'
                    : 'Create document'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
