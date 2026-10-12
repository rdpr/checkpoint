import { useState, type CSSProperties, type FormEvent } from 'react';
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FileText,
  Plus,
  Search,
  Archive,
} from 'lucide-react';
import type { ArtifactSummary, Catalog, Folder } from '../shared/types';
import { api, errorText, artifactLabel } from './api';
import { ActionPopover, ErrorMessage, Modal } from './ui';
import { Select } from './Select';
import { isAnnotatableDocPath } from '../shared/artifacts';

export function folderSegments(folders: Folder[], id: string | null): Folder[] {
  const folder = folders.find((f) => f.id === id);
  return folder ? [...folderSegments(folders, folder.parentId), folder] : [];
}
export function pathInFolder(
  folders: Folder[],
  id: string | null,
  name: string,
  extension = '.md',
) {
  name = name.trim();
  if (!name) return '';
  return [
    ...folderSegments(folders, id).map((f) => f.name),
    isAnnotatableDocPath(name) ? name : `${name}${extension}`,
  ].join('/');
}
export function FolderPicker({
  folders,
  value,
  onChange,
  exclude,
  label = 'Folder',
}: {
  folders: Folder[];
  value: string | null;
  onChange: (value: string | null) => void;
  exclude?: string;
  label?: string;
}) {
  return (
    <label>
      {label}
      <Select
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Workspace root</option>
        {folders
          .filter(
            (f) => !folderSegments(folders, f.id).some((p) => p.id === exclude),
          )
          .map((f) => (
            <option key={f.id} value={f.id}>
              {folderSegments(folders, f.id)
                .map((p) => p.name)
                .join(' › ')}
            </option>
          ))}
      </Select>
    </label>
  );
}
export type FolderIntent =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'manage'; folder: Folder };
export function FolderDialog({
  intent,
  catalog,
  workspaceId,
  onClose,
  onChanged,
}: {
  intent: FolderIntent;
  catalog: Catalog;
  workspaceId: string;
  onClose: () => void;
  onChanged: (next: Catalog) => void;
}) {
  const [snapshot] = useState(catalog);
  const [name, setName] = useState(
    intent.kind === 'manage' ? intent.folder.name : '',
  );
  const [parentId, setParentId] = useState(
    intent.kind === 'manage' ? intent.folder.parentId : intent.parentId,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const folder = intent.kind === 'manage' ? intent.folder : null;
  const affected = folder
    ? snapshot.artifacts.filter((a) =>
        folderSegments(snapshot.folders, a.folderId).some(
          (f) => f.id === folder.id,
        ),
      )
    : [];
  const canDelete =
    !!folder &&
    !affected.length &&
    !snapshot.folders.some((f) => f.parentId === folder.id);
  async function save(remove = false) {
    setBusy(true);
    setError(null);
    try {
      if (folder) {
        const result = await api<Catalog>(
          `/workspaces/${workspaceId}/folders/${folder.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              name,
              parentId,
              remove,
              expectedCatalogVersion: snapshot.version,
              expectedArtifacts: affected.map((a) => ({
                id: a.id,
                expectedRevisionId: a.currentRevisionId,
                expectedMetadataVersion: a.metadataVersion,
              })),
            }),
          },
        );
        onChanged(result);
      } else {
        await api(`/workspaces/${workspaceId}/folders`, {
          method: 'POST',
          body: JSON.stringify({ name, parentId }),
        });
        onChanged(await api<Catalog>(`/workspaces/${workspaceId}/catalog`));
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={folder ? 'Manage folder' : 'New folder'} onClose={onClose}>
      <ErrorMessage message={error} />
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Folder name
          <input
            autoFocus
            required
            maxLength={100}
            pattern="[^/\\\\]+"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <FolderPicker
          folders={snapshot.folders}
          value={parentId}
          onChange={setParentId}
          exclude={folder?.id}
          label="Parent folder"
        />
        {folder && (
          <p className="muted small">
            {affected.length} {affected.length === 1 ? 'artifact' : 'artifacts'}{' '}
            in this folder and its subfolders. Moving or renaming keeps links,
            discussions, and revision history intact.
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {folder ? 'Save folder' : 'Create folder'}
          </button>
        </div>
      </form>
      {folder && (
        <div className="folder-delete">
          <button
            className="text-button danger-text"
            disabled={busy || !canDelete}
            onClick={() => void save(true)}
          >
            Delete empty folder
          </button>
          <p className="small muted">
            Only empty folders can be deleted. Move artifacts and subfolders
            first, including archived artifacts.
          </p>
        </div>
      )}
    </Modal>
  );
}
export function ArtifactNavigation({
  folders,
  artifacts,
  selectedId,
  selectedFolderId,
  onOpen,
  onFolder,
  onCreate,
  onManage,
  onSearch,
  canWrite,
  showArchived,
  onArchived,
  userId,
  workspaceId,
}: {
  folders: Folder[];
  artifacts: ArtifactSummary[];
  selectedId: string | null;
  selectedFolderId: string | null;
  onOpen: (id: string) => void;
  onFolder: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onManage: (intent: FolderIntent) => void;
  onSearch: () => void;
  canWrite: boolean;
  showArchived: boolean;
  onArchived: () => void;
  userId: string;
  workspaceId: string;
}) {
  const key = `checkpoint-folders:${userId}:${workspaceId}`;
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  });
  function toggle(id: string) {
    const next = collapsed.includes(id)
      ? collapsed.filter((f) => f !== id)
      : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }
  function items(parentId: string | null, depth = 0) {
    return (
      <ul className="folder-tree-list">
        {folders
          .filter((f) => f.parentId === parentId)
          .map((f) => (
            <li key={f.id} style={{ '--tree-depth': depth } as CSSProperties}>
              <div
                className={`folder-tree-row ${selectedFolderId === f.id ? 'active' : ''}`}
              >
                <button
                  className="folder-toggle icon-button"
                  aria-label={`${collapsed.includes(f.id) ? 'Expand' : 'Collapse'} ${f.name}`}
                  aria-expanded={!collapsed.includes(f.id)}
                  onClick={() => toggle(f.id)}
                >
                  <ChevronRight size={13} />
                </button>
                <button
                  className="folder-name"
                  aria-current={selectedFolderId === f.id ? 'page' : undefined}
                  onClick={() => onFolder(f.id)}
                >
                  {collapsed.includes(f.id) ? (
                    <FolderClosed size={16} />
                  ) : (
                    <FolderOpen size={16} />
                  )}
                  <span>{f.name}</span>
                </button>
                {canWrite && (
                  <ActionPopover label={`Actions for folder ${f.name}`}>
                    <button onClick={() => onCreate(f.id)}>New artifact</button>
                    <button
                      onClick={() =>
                        onManage({ kind: 'create', parentId: f.id })
                      }
                    >
                      New subfolder
                    </button>
                    <button
                      onClick={() => onManage({ kind: 'manage', folder: f })}
                    >
                      Manage folder
                    </button>
                  </ActionPopover>
                )}
              </div>
              {!collapsed.includes(f.id) && items(f.id, depth + 1)}
            </li>
          ))}
        {artifacts
          .filter((a) => a.folderId === parentId)
          .map((a) => (
            <li key={a.id} style={{ '--tree-depth': depth } as CSSProperties}>
              <button
                className={`artifact-tree-item ${a.id === selectedId ? 'active' : ''}`}
                aria-label={a.path}
                aria-current={a.id === selectedId ? 'page' : undefined}
                onClick={() => onOpen(a.id)}
              >
                <FileText size={16} />
                <span>
                  {artifactLabel(a.path)}
                  {a.archivedAt ? ' · Archived' : ''}
                </span>
              </button>
            </li>
          ))}
      </ul>
    );
  }
  return (
    <>
      <div className="sidebar-section-title artifact-section-title">
        <span>ARTIFACTS</span>
        <div className="sidebar-section-actions">
          <button
            className="icon-button"
            aria-label="Search workspace artifacts"
            title="Search artifacts"
            onClick={onSearch}
          >
            <Search size={15} />
          </button>
          {canWrite && (
            <ActionPopover
              label="Create artifact or folder"
              icon={<Plus size={16} />}
            >
              <button onClick={() => onCreate(selectedFolderId)}>
                New artifact
              </button>
              <button
                onClick={() =>
                  onManage({ kind: 'create', parentId: selectedFolderId })
                }
              >
                New folder
              </button>
            </ActionPopover>
          )}
          <ActionPopover label="Artifact navigation options">
            <button aria-pressed={showArchived} onClick={onArchived}>
              <Archive size={15} />
              {showArchived
                ? 'Hide archived artifacts'
                : 'Show archived artifacts'}
            </button>
          </ActionPopover>
        </div>
      </div>
      {showArchived && (
        <button className="archive-notice" onClick={onArchived}>
          Including archived · Clear
        </button>
      )}
      <nav className="artifact-tree" aria-label="Workspace artifacts">
        {items(null)}
        {!artifacts.length && !folders.length && (
          <p className="sidebar-empty">No artifacts yet.</p>
        )}
      </nav>
    </>
  );
}
