export type Role = 'owner' | 'editor' | 'viewer';
export interface User {
  id: string;
  name: string;
  email: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  artifactCount: number;
}
export interface Folder {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
}
export interface Catalog {
  version: number;
  folders: Folder[];
  artifacts: ArtifactSummary[];
}
export interface ArtifactSummary {
  folderId: string | null;
  id: string;
  workspaceId: string;
  path: string;
  currentRevisionId: string;
  updatedAt: string;
  archivedAt: string | null;
  metadataVersion: number;
}
export interface Revision {
  id: string;
  artifactId: string;
  number: number;
  body: string;
  authorName: string;
  agentName: string | null;
  createdAt: string;
  restoredFrom: string | null;
}
export interface Artifact extends ArtifactSummary {
  revision: Revision;
  reviews: ReviewDecision[];
}
export interface DiffAnchor {
  baseRevisionId: string;
  blockIndex: number;
  side: 'added' | 'removed' | 'modified';
}
export interface Reattachment {
  revisionId: string;
  revisionNumber: number;
  quote: string;
  anchor: Record<string, unknown>;
  authorName: string;
  agentName: string | null;
  createdAt: string;
}
export interface Comment {
  id: string;
  artifactId: string;
  revisionId: string;
  body: string;
  quote: string;
  kind: 'comment' | 'deletion' | 'label';
  labelTip: string | null;
  images: { path: string; name: string }[];
  anchor: Record<string, unknown> | null;
  resolved: boolean;
  version: number;
  updatedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
  authorName: string;
  agentName: string | null;
  createdAt: string;
  replies: Reply[];
  diff: DiffAnchor | null;
  reattachments: Reattachment[];
}
export interface Reply {
  id: string;
  body: string;
  authorName: string;
  agentName: string | null;
  createdAt: string;
}
export interface Member extends User {
  role: Role;
  directRole: Role | null;
  teams: { name: string; role: string }[];
}
export interface TokenInfo {
  id: string;
  name: string;
  scope: 'read' | 'write';
  createdAt: string;
  expiresAt: string;
  ownerName?: string;
  ownerType?: 'person' | 'service';
  lastUsedAt?: string | null;
}
export interface InviteInfo {
  id: string;
  role: 'editor' | 'viewer';
  expiresAt: string;
}

export interface ReviewDecision {
  id: string;
  revisionId: string;
  revisionNumber: number;
  reviewerId: string;
  reviewerName: string;
  decision: 'approved' | 'changes_requested' | 'withdrawn';
  note: string;
  createdAt: string;
}

export interface Reviewer {
  id: string;
  name: string;
  role: 'owner' | 'editor';
}
export interface ReviewRequest {
  workspaceName?: string;
  archivedAt: string | null;
  id: string;
  workspaceId: string;
  artifactId: string;
  path: string;
  revisionId: string;
  revisionNumber: number;
  baseRevisionId: string | null;
  reviewerId: string;
  reviewerName: string;
  requesterId: string;
  requesterName: string;
  agentName: string | null;
  message: string;
  createdAt: string;
  supersedesId: string | null;
  supersededBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  version: number;
  status:
    | 'waiting'
    | 'approved'
    | 'changes_requested'
    | 'cancelled'
    | 'superseded'
    | 'reviewer_unavailable'
    | 'artifact_archived';
  outdated: boolean;
  currentRevisionId: string;
  decision: ReviewDecision | null;
  canManage: boolean;
}

export interface Organization {
  name: string;
  version: number;
  isAdmin: boolean;
}
export interface OrgPerson extends User {
  orgRole: 'admin' | 'member';
  disabledAt: string | null;
}
export interface Team {
  id: string;
  name: string;
  memberIds: string[];
  workspaces: { workspaceId: string; role: 'editor' | 'viewer' }[];
}
export interface ManagedWorkspace {
  id: string;
  name: string;
  members: Member[];
}
export interface OrganizationAdmin extends Organization {
  people: OrgPerson[];
  teams: Team[];
  workspaces: ManagedWorkspace[];
  credentials: (TokenInfo & {
    userId: string;
    userName: string;
    workspaceName: string;
  })[];
}
export interface AuditEntry {
  id: number;
  actorName: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SearchHit extends ArtifactSummary {
  workspaceName: string;
  snippet: string;
}
export interface WorkspaceNotification {
  id: number;
  kind:
    | 'review_requested'
    | 'reply'
    | 'approved'
    | 'changes_requested'
    | 'withdrawn';
  artifactId: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
  requestId: string | null;
  commentId: string | null;
  actorName: string;
  preview: string;
  createdAt: string;
  readAt: string | null;
}
export interface ServiceAccount {
  id: string;
  name: string;
  scope: 'read' | 'write';
  disabledAt: string | null;
  createdBy: string;
  createdAt: string;
  tokens: TokenInfo[];
}
export interface AgentConnection {
  workspace: { id: string; name: string; role: Role };
  credential: {
    id: string;
    name: string;
    scope: 'read' | 'write';
    expiresAt: string;
    ownerName: string;
    ownerType: 'person' | 'service';
  };
}
