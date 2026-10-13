import { AccountMenu } from './AccountMenu';
import {
  ArtifactNavigation,
  FolderDialog,
  FolderPicker,
  folderSegments,
  pathInFolder,
  type FolderIntent,
} from './Folders';
import { modKey } from '@plannotator/ui/utils/platform';
import { Select } from './Select';
import {
  ANNOTATABLE_EXTENSIONS_HINT,
  isAnnotatableDocPath,
  artifactExtension,
  artifactFormat,
} from '../shared/artifacts';
import { navigate, artifactUrl } from './navigation';
import { Drafts } from './Drafts';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Plus,
  FileText,
  Search,
  Users,
  Bot,
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
  Catalog,
  User,
  Organization,
  Workspace,
  ArtifactSummary,
  ReviewRequest,
  Artifact,
} from '../shared/types';
import {
  api,
  post,
  errorText,
  dateLabel,
  artifactLabel,
  initials,
} from './api';
import { Auth } from './Auth';
import { Account } from './Account';
import { MyReviews } from './ReviewRequests';
import { SearchArtifacts, Notifications } from './Discovery';
import { Access } from './Access';
import { OrganizationSettings } from './Organization';
import { ArtifactView } from './ArtifactView';
import { Brand, ErrorMessage, Loading, Modal, Sidebar } from './ui';
import { setIdentity } from './identity';
import { useReviewPreferences } from './reviewPreferences';

export function App() {
  const [status, setStatus] = useState<{
    user: User | null;
    needsSetup: boolean;
    setupAllowed: boolean;
    oidcEnabled: boolean;
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
          oidcEnabled={status.oidcEnabled}
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
          const result = await post<{ url?: string }>('/auth/logout');
          setIdentity(null);
          sessionStorage.removeItem('pw-return');
          location.assign(result.url ?? '/');
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

const pageViews = [
  'account',
  'organization',
  'members',
  'agents',
  'drafts',
  'notifications',
];
function WorkspaceApp({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => Promise<void>;
}) {
  const [pageView, setPageView] = useState(
    () => new URLSearchParams(location.search).get('view') ?? '',
  );
  const [mobile, setMobile] = useState(
    () => matchMedia('(max-width: 900px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const resize = () => {
      setMobile(media.matches);
      setSidebar(!media.matches);
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  const [queue, setQueue] = useState(
    () => new URLSearchParams(location.search).get('view') === 'reviews',
  );
  const [requestVisit, setRequestVisit] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('request'),
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [wid, setWid] = useState(''),
    [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]),
    [did, setDid] = useState<string | null>(null);
  const [catalogWorkspaceId, setCatalogWorkspaceId] = useState('');
  const [catalog, setCatalog] = useState<Catalog>({
    version: 0,
    folders: [],
    artifacts: [],
  });
  const [folderId, setFolderId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('folder'),
  );
  const [folderIntent, setFolderIntent] = useState<FolderIntent | null>(null);
  const [createFolderId, setCreateFolderId] = useState<string | null>(null);
  const [artifactName, setArtifactName] = useState('');
  const [artifactBody, setArtifactBody] = useState('');
  const [newExtension, setNewExtension] = useState('.md');
  const [searchWorkspaceId, setSearchWorkspaceId] = useState('');
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [modal, setDialog] = useState<
      | 'workspace'
      | 'artifact'
      | 'members'
      | 'agents'
      | 'organization'
      | 'account'
      | 'search'
      | 'notifications'
      | 'drafts'
      | null
    >(null),
    [sidebar, setSidebar] = useState(
      () => !matchMedia('(max-width: 900px)').matches,
    );
  function setModal(next: typeof modal) {
    if (next === 'search') setSearchWorkspaceId('');
    if (next && pageViews.includes(next)) {
      const url = new URL(location.href);
      url.searchParams.set('view', next);
      url.searchParams.delete('section');
      navigate(url);
      setDialog(null);
      if (mobile) setSidebar(false);
    } else setDialog(next);
  }
  function closePage() {
    const url = new URL(location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('section');
    navigate(url);
  }
  useEffect(() => {
    const search = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchWorkspaceId('');
        setDialog('search');
      }
    };
    window.addEventListener('keydown', search);
    return () => window.removeEventListener('keydown', search);
  }, []);
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
    current = artifacts.find((d) => d.id === did);
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
        setDid(url.get('artifact') ?? url.get('document'));
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
    setArtifacts([]);
    setCatalog({ version: 0, folders: [], artifacts: [] });
    setLoading(true);
    const load = async () => {
      try {
        const next = await api<Catalog>(`/workspaces/${wid}/catalog`);
        if (active) {
          setArtifacts(next.artifacts);
          setCatalog(next);
          setCatalogWorkspaceId(wid);
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
      setFolderId(url.get('folder'));
      setDid(url.get('artifact') ?? url.get('document'));
      setRequestId(url.get('request'));
      setQueue(url.get('view') === 'reviews');
      setPageView(url.get('view') ?? '');
      if (matchMedia('(max-width: 900px)').matches) setSidebar(false);
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
  function selectArtifact(
    id: string | null,
    workspaceId = wid,
    extra: Record<string, string> = {},
  ) {
    navigate(artifactUrl(workspaceId, id, extra));
  }
  function openRequest(request: ReviewRequest) {
    updatePreferences({ layout: 'normal' });
    selectArtifact(request.artifactId, request.workspaceId, {
      request: request.id,
    });
  }
  function applyCatalog(next: Catalog) {
    setCatalogWorkspaceId(wid);
    setCatalog(next);
    setArtifacts(next.artifacts);
  }
  function openFolder(id: string | null) {
    navigate(artifactUrl(wid, null, id ? { folder: id } : {}));
  }
  function startArtifact(parentId: string | null = folderId) {
    setCreateFolderId(parentId);
    setArtifactName('');
    setArtifactBody('');
    setNewExtension('.md');
    setModal('artifact');
    setError(null);
  }
  async function refreshArtifacts() {
    if (wid) applyCatalog(await api<Catalog>(`/workspaces/${wid}/catalog`));
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
        selectArtifact(null, created.id);
      } else {
        const created = await post<Artifact>('/artifacts', {
          workspaceId: wid,
          path: pathInFolder(
            catalog.folders,
            createFolderId,
            artifactName,
            newExtension,
          ),
          body: String(values.body ?? ''),
        });
        await refreshArtifacts();
        selectArtifact(created.id);
      }
      setModal(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (
      !loading &&
      catalogWorkspaceId === wid &&
      folderId &&
      !catalog.folders.some((f) => f.id === folderId)
    )
      openFolder(null);
  }, [loading, catalog, folderId, catalogWorkspaceId, wid]);
  const activeArtifactCount = artifacts.filter((d) => !d.archivedAt).length;
  const filtered = artifacts.filter((d) => showArchived || !d.archivedAt);
  async function openLink(path: string, revisionId: string) {
    try {
      if (/^(https?:|mailto:)/i.test(path)) {
        const url = new URL(path, location.href);
        if (
          url.origin === location.origin &&
          (url.searchParams.has('artifact') || url.searchParams.has('document'))
        )
          navigate(url);
        else window.open(path, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!did) return;
      const target = await api<{
        workspaceId: string;
        artifactId: string;
        fragment: string;
      }>(
        `/artifacts/${did}/resolve-link?${new URLSearchParams({ revisionId, href: path })}`,
      );
      selectArtifact(target.artifactId, target.workspaceId, {
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
  const readerLayout =
    !!did && !pageViews.includes(pageView) && preferences.layout === 'focus';
  const sidebarVisible = sidebar && !readerLayout;
  return (
    <div className={`app-shell ${sidebarVisible ? '' : 'sidebar-collapsed'}`}>
      {modal === 'search' && (
        <SearchArtifacts
          workspaces={workspaces}
          initialWorkspaceId={searchWorkspaceId}
          onClose={() => setModal(null)}
          onOpen={(w, d) => {
            setModal(null);
            selectArtifact(d, w);
          }}
        />
      )}
      {sidebarVisible && (
        <Sidebar mobile={mobile} onClose={() => setSidebar(false)}>
          <Brand />
          <nav className="personal-navigation" aria-label="Personal work">
            <button
              className="sidebar-overview"
              onClick={() => setModal('search')}
            >
              <Search size={17} /> Search{' '}
              <kbd aria-hidden="true">{modKey} K</kbd>
            </button>
            <button
              className={`sidebar-overview ${queue ? 'active' : ''}`}
              onClick={() => {
                selectArtifact(null, wid, { view: 'reviews' });
              }}
            >
              <ClipboardCheck size={17} /> My reviews
            </button>
            <button
              className={`sidebar-overview ${pageView === 'notifications' ? 'active' : ''}`}
              onClick={() => setModal('notifications')}
            >
              <Bell size={17} />
              Notifications {!!unread && <span>{unread}</span>}
            </button>
            <button
              className={`sidebar-overview ${pageView === 'drafts' ? 'active' : ''}`}
              onClick={() => setModal('drafts')}
            >
              <FileText size={17} />
              Saved drafts
            </button>
          </nav>
          <div className="sidebar-section-title">WORKSPACE</div>
          <div className="workspace-picker">
            <span className="workspace-icon">
              {workspace ? initials(workspace.name).slice(0, 1) : 'W'}
            </span>
            <label className="sr-only" htmlFor="workspace-select">
              Current workspace
            </label>
            <Select
              searchable
              id="workspace-select"
              value={wid}
              onChange={(e) => {
                selectArtifact(null, e.target.value);
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
            </Select>
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
            className={`sidebar-overview ${!did && !folderId && !pageView ? 'active' : ''}`}
            onClick={() => selectArtifact(null)}
          >
            <FolderOpen size={17} />
            All artifacts
            <span>{activeArtifactCount}</span>
          </button>
          <ArtifactNavigation
            key={wid}
            folders={catalog.folders}
            artifacts={filtered}
            selectedId={!pageView ? did : null}
            selectedFolderId={!did && !pageView ? folderId : null}
            onOpen={(id) => selectArtifact(id)}
            onFolder={openFolder}
            onCreate={startArtifact}
            onManage={setFolderIntent}
            onSearch={() => {
              setSearchWorkspaceId(wid);
              setDialog('search');
            }}
            canWrite={!!workspace && workspace.role !== 'viewer'}
            showArchived={showArchived}
            onArchived={() => setShowArchived(!showArchived)}
            userId={user.id}
            workspaceId={wid}
          />
          <div className="sidebar-bottom">
            <AccountMenu
              user={user}
              workspace={workspace}
              isAdmin={!!organization?.isAdmin}
              onOpen={setModal}
              onLogout={() =>
                void onLogout().catch((e) => setError(errorText(e)))
              }
            />
          </div>
        </Sidebar>
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
            <span>
              {queue ||
              ['account', 'drafts', 'notifications'].includes(pageView)
                ? 'Personal work'
                : pageView === 'organization'
                  ? 'Administration'
                  : (workspace?.name ?? 'Workspaces')}
            </span>
            <ChevronRight size={13} />
            {!pageView &&
              current &&
              folderSegments(catalog.folders, current.folderId).map((f) => (
                <span className="breadcrumb-folder" key={f.id}>
                  <button onClick={() => openFolder(f.id)}>{f.name}</button>
                  <ChevronRight size={13} />
                </span>
              ))}
            <strong>
              {pageViews.includes(pageView)
                ? {
                    account: 'Account',
                    organization: 'Organization',
                    members: 'Members',
                    agents: 'Agent access',
                    drafts: 'Saved drafts',
                    notifications: 'Notifications',
                  }[pageView]
                : queue
                  ? 'My reviews'
                  : current
                    ? artifactLabel(current.path)
                    : (catalog.folders.find((f) => f.id === folderId)?.name ??
                      'All artifacts')}
            </strong>
          </div>
          <div id="artifact-header-actions" />
          <button
            className="icon-button mobile-search"
            aria-label="Search artifacts"
            onClick={() => setModal('search')}
          >
            <Search size={18} />
          </button>
        </header>
        {error && !modal && (
          <div className="app-error">
            <ErrorMessage message={error} />
            <button className="text-button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {pageViews.includes(pageView) ? (
          <>
            {['account', 'organization', 'members', 'agents'].includes(
              pageView,
            ) && (
              <nav
                className="settings-navigation"
                aria-label="Settings sections"
              >
                <button
                  aria-current={pageView === 'account' ? 'page' : undefined}
                  onClick={() => setModal('account')}
                >
                  <UserRound size={17} />
                  Account
                </button>
                {organization?.isAdmin && (
                  <button
                    aria-current={
                      pageView === 'organization' ? 'page' : undefined
                    }
                    onClick={() => setModal('organization')}
                  >
                    <Building2 size={17} />
                    Organization
                  </button>
                )}
                <button
                  aria-current={pageView === 'members' ? 'page' : undefined}
                  onClick={() => setModal('members')}
                  disabled={!workspace}
                >
                  <Users size={17} />
                  Members
                </button>
                <button
                  aria-current={pageView === 'agents' ? 'page' : undefined}
                  onClick={() => setModal('agents')}
                  disabled={!workspace}
                >
                  <Bot size={17} />
                  Agent access
                  <ArrowUpRight size={14} />
                </button>
              </nav>
            )}
            {pageView === 'notifications' && (
              <Notifications
                onCount={setUnread}
                onClose={closePage}
                onRequest={(r) => {
                  setModal(null);
                  openRequest(r);
                }}
                onOpen={(w, d, c) => {
                  setModal(null);
                  updatePreferences({ layout: 'normal' });
                  selectArtifact(d, w, c ? { comment: c } : {});
                }}
              />
            )}
            {pageView === 'drafts' && (
              <Drafts
                user={user}
                onClose={closePage}
                onOpen={(w, d, c) => {
                  setModal(null);
                  updatePreferences({ layout: 'normal' });
                  selectArtifact(d, w, c ? { comment: c } : {});
                }}
              />
            )}
            {pageView === 'account' && <Account onClose={closePage} />}
            {pageView === 'organization' && organization?.isAdmin && (
              <OrganizationSettings
                user={user}
                onClose={closePage}
                onChanged={() => {
                  void refreshWorkspaces().catch((e) => setError(errorText(e)));
                }}
              />
            )}
            {(pageView === 'members' || pageView === 'agents') && workspace && (
              <Access
                key={`${wid}:${pageView}`}
                workspace={workspace}
                user={user}
                kind={pageView as 'members' | 'agents'}
                onChanged={() => {
                  void refreshWorkspaces().catch((e) => setError(errorText(e)));
                }}
                onClose={closePage}
              />
            )}
            {pageView === 'organization' &&
              organization &&
              !organization.isAdmin && (
                <div className="artifact-empty">
                  <h1>Organization settings</h1>
                  <p>Administrator access is required.</p>
                  <button className="button" onClick={closePage}>
                    Back to workspace
                  </button>
                </div>
              )}
          </>
        ) : queue ? (
          <MyReviews workspaceId="" user={user} onOpen={openRequest} />
        ) : workspace && did ? (
          <ArtifactView
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
              void refreshArtifacts().catch((e) => setError(errorText(e)))
            }
            onLink={openLink}
          />
        ) : loading ? (
          <Loading />
        ) : (
          <section className="workspace-home">
            <div className="home-title">
              <div>
                <span className="eyebrow">
                  {folderId ? 'FOLDER' : 'WORKSPACE'}
                </span>
                <h1>
                  {catalog.folders.find((f) => f.id === folderId)?.name ??
                    workspace?.name ??
                    'Your work starts here'}
                </h1>
                {!workspace && (
                  <p>
                    Create a workspace for your team’s specs and design reviews.
                  </p>
                )}
              </div>
              {workspace ? (
                workspace.role !== 'viewer' && (
                  <button
                    className="button primary"
                    onClick={() => {
                      startArtifact();
                    }}
                  >
                    <Plus size={17} />
                    New artifact
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
                {folderId && (
                  <nav
                    className="folder-breadcrumbs"
                    aria-label="Folder location"
                  >
                    <button onClick={() => openFolder(null)}>
                      {workspace.name}
                    </button>
                    {folderSegments(catalog.folders, folderId).map((f) => (
                      <span key={f.id}>
                        <ChevronRight size={14} />
                        <button onClick={() => openFolder(f.id)}>
                          {f.name}
                        </button>
                      </span>
                    ))}
                  </nav>
                )}
                {!folderId && (
                  <div className="workspace-summary">
                    <div>
                      <FileText size={20} />
                      <strong>{activeArtifactCount}</strong>
                      <span>
                        {activeArtifactCount === 1
                          ? 'shared artifact'
                          : 'shared artifacts'}
                      </span>
                    </div>
                    <button
                      aria-current={pageView === 'members' ? 'page' : undefined}
                      onClick={() => setModal('members')}
                    >
                      <Users size={19} />
                      <span>Manage members</span>
                      <ArrowUpRight size={16} />
                    </button>
                    <button
                      aria-current={pageView === 'agents' ? 'page' : undefined}
                      onClick={() => setModal('agents')}
                    >
                      <Bot size={19} />
                      <span>Connect an agent</span>
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                )}
                <div className="folder-browser-toolbar">
                  <h2>{folderId ? 'Folder contents' : 'Browse folders'}</h2>
                  {workspace.role !== 'viewer' && (
                    <div className="button-row">
                      <button
                        className="button"
                        onClick={() =>
                          setFolderIntent({
                            kind: 'create',
                            parentId: folderId,
                          })
                        }
                      >
                        New folder
                      </button>
                      {folderId &&
                        catalog.folders.find((f) => f.id === folderId) && (
                          <button
                            className="button"
                            onClick={() =>
                              setFolderIntent({
                                kind: 'manage',
                                folder: catalog.folders.find(
                                  (f) => f.id === folderId,
                                )!,
                              })
                            }
                          >
                            Manage folder
                          </button>
                        )}
                    </div>
                  )}
                </div>
                <div className="folder-browser-list">
                  {catalog.folders
                    .filter((f) => f.parentId === folderId)
                    .map((f) => (
                      <button key={f.id} onClick={() => openFolder(f.id)}>
                        <FolderOpen size={19} />
                        <span>{f.name}</span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                </div>

                <div className="artifact-list-heading">
                  <h2>
                    {folderId ? 'Artifacts' : 'All artifacts'}{' '}
                    <span>
                      {
                        filtered.filter(
                          (a) => !folderId || a.folderId === folderId,
                        ).length
                      }
                    </span>
                  </h2>
                  <span>LAST UPDATED</span>
                </div>
                <div className="artifact-list">
                  {filtered
                    .filter((a) => !folderId || a.folderId === folderId)
                    .map((d) => (
                      <button key={d.id} onClick={() => selectArtifact(d.id)}>
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
                          {!folderId && (
                            <small>
                              {folderSegments(catalog.folders, d.folderId)
                                .map((f) => f.name)
                                .join(' › ') || 'Workspace root'}
                            </small>
                          )}
                        </span>
                        <time>{dateLabel(d.updatedAt)}</time>
                        <ArrowUpRight size={16} />
                      </button>
                    ))}
                  {!filtered.some(
                    (a) => !folderId || a.folderId === folderId,
                  ) && (
                    <div className="home-empty">
                      <FileText size={32} strokeWidth={1.2} />
                      <h3>No artifacts yet.</h3>
                      <p>
                        {workspace.role === 'viewer'
                          ? 'An editor can add artifacts here.'
                          : 'Add a design spec, API proposal, or rollout plan to review with your team.'}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </main>
      {folderIntent && (
        <FolderDialog
          intent={folderIntent}
          catalog={catalog}
          workspaceId={wid}
          onClose={() => setFolderIntent(null)}
          onChanged={applyCatalog}
        />
      )}
      {(modal === 'workspace' || modal === 'artifact') && (
        <Modal
          title={modal === 'workspace' ? 'New workspace' : 'New artifact'}
          onClose={() => setModal(null)}
        >
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
                  Artifact name
                  <input
                    required
                    autoFocus
                    maxLength={120}
                    pattern="[^/\\\\]+"
                    placeholder="e.g. Webhook delivery design"
                    value={artifactName}
                    onChange={(e) => {
                      setArtifactName(e.target.value);
                      if (isAnnotatableDocPath(e.target.value))
                        setNewExtension(
                          artifactExtension(e.target.value).toLowerCase(),
                        );
                    }}
                  />
                </label>
                <label>
                  Format
                  <Select
                    aria-label="Artifact format"
                    value={newExtension}
                    onChange={(e) => {
                      setNewExtension(e.target.value);
                      if (isAnnotatableDocPath(artifactName))
                        setArtifactName(
                          artifactName.slice(
                            0,
                            -artifactExtension(artifactName).length,
                          ) + e.target.value,
                        );
                    }}
                  >
                    {Array.from(
                      new Set(['.md', '.html', '.mmd', '.dot', newExtension]),
                    ).map((ext) => (
                      <option key={ext} value={ext}>
                        {ext === '.md'
                          ? 'Markdown (.md)'
                          : ext === '.html'
                            ? 'HTML (.html)'
                            : ext === '.mmd'
                              ? 'Mermaid (.mmd)'
                              : ext === '.dot'
                                ? 'Graphviz (.dot)'
                                : `${ext} (${['.mdx', '.htm', '.mermaid', '.gv'].includes(ext) ? 'imported format' : 'source text'})`}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Import a file
                  <input
                    type="file"
                    accept={ANNOTATABLE_EXTENSIONS_HINT}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (
                        !isAnnotatableDocPath(file.name) ||
                        file.size > 4_000_000
                      ) {
                        setError(
                          'Choose a supported text artifact smaller than one million characters.',
                        );
                        return;
                      }
                      let text: string;
                      try {
                        text = new TextDecoder('utf-8', { fatal: true }).decode(
                          await file.arrayBuffer(),
                        );
                      } catch {
                        setError('The file could not be read as UTF-8 text.');
                        return;
                      }
                      if (text.length > 1_000_000 || text.includes('\0')) {
                        setError(
                          'Choose a UTF-8 text artifact smaller than one million characters.',
                        );
                        return;
                      }
                      setError(null);
                      setArtifactName(file.name);
                      setNewExtension(
                        artifactExtension(file.name).toLowerCase(),
                      );
                      setArtifactBody(text);
                    }}
                  />
                </label>
                <FolderPicker
                  folders={catalog.folders}
                  value={createFolderId}
                  onChange={setCreateFolderId}
                />
                <label>
                  Starting content
                  <textarea
                    name="body"
                    value={artifactBody}
                    onChange={(e) => setArtifactBody(e.target.value)}
                    placeholder={
                      {
                        markdown:
                          '# Design spec\n\n## Context\nWhat problem are we solving?\n\n## Proposed design\nDescribe the approach and tradeoffs.\n\n## Open decisions\nWhat needs review before implementation?',
                        html: '<!doctype html>\n<html>\n<head><title>Retry console</title></head>\n<body>\n<h1>Retry console</h1>\n<p>Review the proposed retry flow and failure states.</p>\n</body>\n</html>',
                        mermaid:
                          'flowchart LR\nAPI --> Queue\nQueue --> Worker',
                        graphviz:
                          'digraph Delivery {\n  API -> Queue;\n  Queue -> Worker;\n}',
                        text: 'Paste the source to review…',
                      }[artifactFormat(`artifact${newExtension}`)]
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
                    : 'Create artifact'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
