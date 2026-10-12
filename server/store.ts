import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type {
  User,
  Workspace,
  Member,
  Document,
  DocumentSummary,
  Revision,
  Comment,
  Reply,
  TokenInfo,
  InviteInfo,
  Role,
  ReviewDecision,
  ReviewRequest,
  Reviewer,
  OrgPerson,
  Organization,
  OrganizationAdmin,
  AuditEntry,
  SearchHit,
  WorkspaceNotification,
  ServiceAccount,
  AgentConnection,
} from '../shared/types.ts';
import {
  AppError,
  requireThat,
  secret,
  digest,
  hashPassword,
  verifyPassword,
} from './security.ts';
import * as schema from './schemas.ts';
import { computePlanDiff } from '@plannotator/ui/utils/planDiffEngine';
import { documentLinks, relativePath } from './links.ts';
import { currentDecisions } from '../shared/review.ts';
import { formatFeedback } from './feedback.ts';

export interface Actor {
  user: User;
  token?: {
    id: string;
    workspaceId: string;
    scope: 'read' | 'write';
    name: string;
  };
}
type Account = User & { password: string; disabled_at: string | null };
const now = () => new Date().toISOString();
const expiry = (hours: number) =>
  new Date(Date.now() + hours * 3600000).toISOString();
const welcome = `# A shared place to think\n\nGood plans get better when people and agents work from the same document.\n\n## Make this workspace yours\n\n- Create a document using **New document**. Paths like \`specs/api.md\` keep related work together.\n- Switch to **Edit**, make a change, then **Save revision**.\n- Select a passage in Read mode to leave a comment, or start a document-wide discussion in the sidebar.\n- Invite a teammate from **Members**.\n- Create a scoped key in **Agent access** to connect an MCP client.\n\n## Every change has a history\n\nSaved revisions are permanent. Open **History** to compare a revision with the latest document or restore an earlier version as a new revision.\n\n> Edits are saved explicitly. If somebody saves first, your draft stays available and the app asks you to reconcile the changes.\n\n## A place for decisions\n\nUse this document for your first plan, or add a new one. Keep the purpose, constraints, and next steps together.\n`;

export const DATABASE_VERSION = 11;

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    const version = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version.user_version > DATABASE_VERSION) {
      this.db.close();
      throw new Error(
        `Database schema ${version.user_version} is newer than this release supports (${DATABASE_VERSION}). Use a compatible release or explicitly restore its backup.`,
      );
    }
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(workspace_id,user_id));
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, current_revision_id TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,path));
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), number INTEGER NOT NULL, body TEXT NOT NULL, author_name TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), agent_name TEXT, created_at TEXT NOT NULL, restored_from TEXT, UNIQUE(document_id,number));
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), revision_id TEXT NOT NULL REFERENCES revisions(id), body TEXT NOT NULL, quote TEXT NOT NULL, anchor TEXT, resolved INTEGER NOT NULL DEFAULT 0, author_name TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), agent_name TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id), body TEXT NOT NULL, author_name TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), agent_name TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), mime TEXT NOT NULL, data BLOB NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), revision_id TEXT NOT NULL REFERENCES revisions(id), reviewer_id TEXT NOT NULL REFERENCES users(id), reviewer_name TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested','withdrawn')), note TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reviews_document ON reviews(document_id);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES workspaces(id), role TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, scope TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id);
      CREATE INDEX IF NOT EXISTS comments_document ON comments(document_id);
      CREATE INDEX IF NOT EXISTS replies_comment ON replies(comment_id);`);
    this.transaction(() => {
      const version = this.one<{ user_version: number }>(
        'PRAGMA user_version',
      )!.user_version;
      if (version < 2) {
        this.db.exec(`
          ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment' CHECK(kind IN ('comment','deletion','label'));
          ALTER TABLE comments ADD COLUMN label_tip TEXT;
          PRAGMA user_version=2;
        `);
      }
      if (version < 3) {
        this.db.exec(
          "ALTER TABLE comments ADD COLUMN images TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=3;",
        );
      }
      if (version < 4) {
        this.db
          .exec(`ALTER TABLE comments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE comments ADD COLUMN updated_at TEXT;
          ALTER TABLE comments ADD COLUMN author_token_id TEXT;
          PRAGMA user_version=4;`);
      }
      if (version < 5) {
        this.db.exec(`ALTER TABLE comments ADD COLUMN diff TEXT;
          CREATE TABLE IF NOT EXISTS comment_reattachments (
            id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
            revision_id TEXT NOT NULL REFERENCES revisions(id), quote TEXT NOT NULL, anchor TEXT NOT NULL,
            author_id TEXT NOT NULL REFERENCES users(id), author_name TEXT NOT NULL, agent_name TEXT, created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS reattachments_comment ON comment_reattachments(comment_id);
          PRAGMA user_version=5;`);
      }
      if (version < 6) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS review_requests (
          id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
          revision_id TEXT NOT NULL REFERENCES revisions(id), base_revision_id TEXT REFERENCES revisions(id),
          reviewer_id TEXT NOT NULL REFERENCES users(id), reviewer_name TEXT NOT NULL,
          requester_id TEXT NOT NULL REFERENCES users(id), requester_name TEXT NOT NULL,
          requester_token_id TEXT, agent_name TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL,
          after_review_rowid INTEGER NOT NULL, closed_review_rowid INTEGER, supersedes_id TEXT UNIQUE REFERENCES review_requests(id),
          cancelled_at TEXT, cancelled_by TEXT, version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS requests_document ON review_requests(document_id);
        PRAGMA user_version=6;`);
      }
      if (version < 7) {
        this.db.exec(`CREATE TABLE comment_submissions (
          submission_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
          author_id TEXT NOT NULL REFERENCES users(id), author_token_id TEXT,
          fingerprint TEXT NOT NULL, comment_id TEXT NOT NULL
        );
        PRAGMA user_version=7;`);
      }
      if (version < 8) {
        this.db.exec(`
          ALTER TABLE users ADD COLUMN org_role TEXT NOT NULL DEFAULT 'member' CHECK(org_role IN ('admin','member'));
          ALTER TABLE users ADD COLUMN disabled_at TEXT;
          ALTER TABLE invites ADD COLUMN created_by TEXT REFERENCES users(id);
          CREATE TABLE organization(id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, version INTEGER NOT NULL);
          INSERT INTO organization VALUES(1,'My organization',1);
          UPDATE users SET org_role='admin' WHERE rowid=(SELECT MIN(rowid) FROM users);
          CREATE TABLE teams(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
          CREATE TABLE team_members(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(team_id,user_id));
          CREATE TABLE team_workspaces(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id), role TEXT NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(team_id,workspace_id));
          CREATE VIEW effective_members AS
            SELECT a.workspace_id,a.user_id,CASE MAX(a.level) WHEN 3 THEN 'owner' WHEN 2 THEN 'editor' ELSE 'viewer' END role
            FROM (SELECT workspace_id,user_id,CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END level FROM members
              UNION ALL SELECT tw.workspace_id,tm.user_id,CASE tw.role WHEN 'editor' THEN 2 ELSE 1 END FROM team_workspaces tw JOIN team_members tm ON tm.team_id=tw.team_id) a
            JOIN users u ON u.id=a.user_id WHERE u.disabled_at IS NULL GROUP BY a.workspace_id,a.user_id;
          CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), actor_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
          INSERT INTO audit_log(actor_name,action,target,details,created_at) VALUES('System','organization.initialized','My organization','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
          PRAGMA user_version=8;
        `);
      }
      if (version < 9) {
        this.db.exec(`
          ALTER TABLE users ADD COLUMN recovery_until TEXT;
          ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
          CREATE TABLE identities(tenant_id TEXT NOT NULL, object_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), PRIMARY KEY(tenant_id,object_id));
          CREATE TABLE identity_flows(hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, user_id TEXT REFERENCES users(id), session_hash TEXT, invitation TEXT, expires_at TEXT NOT NULL);
          PRAGMA user_version=9;
        `);
      }
      if (version < 10) {
        this.db.exec(`
          ALTER TABLE documents ADD COLUMN archived_at TEXT;
          ALTER TABLE documents ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE tokens ADD COLUMN last_used_at TEXT;
          CREATE TABLE service_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
          CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), document_id TEXT NOT NULL REFERENCES documents(id), kind TEXT NOT NULL CHECK(kind IN ('review_requested','reply')), event_key TEXT NOT NULL, request_id TEXT REFERENCES review_requests(id) ON DELETE CASCADE, comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE, reply_id TEXT REFERENCES replies(id) ON DELETE CASCADE, actor_name TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_key));
          CREATE INDEX notifications_recipient ON notifications(user_id,id DESC);
          CREATE VIRTUAL TABLE document_search USING fts5(document_id UNINDEXED,path,body,tokenize='unicode61');
          INSERT INTO document_search SELECT d.id,d.path,r.body FROM documents d JOIN revisions r ON r.id=d.current_revision_id;
          CREATE TRIGGER document_search_update AFTER UPDATE OF current_revision_id,path ON documents BEGIN
            DELETE FROM document_search WHERE document_id=old.id;
            INSERT INTO document_search SELECT new.id,new.path,body FROM revisions WHERE id=new.current_revision_id;
          END;
          CREATE TRIGGER document_search_delete AFTER DELETE ON documents BEGIN DELETE FROM document_search WHERE document_id=old.id; END;
          PRAGMA user_version=10;
        `);
      }
      if (version < 11) {
        this.db.exec(`
          ALTER TABLE notifications RENAME TO notifications_old;
          DROP INDEX notifications_recipient;
          CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), document_id TEXT NOT NULL REFERENCES documents(id), kind TEXT NOT NULL CHECK(kind IN ('review_requested','reply','approved','changes_requested','withdrawn')), event_key TEXT NOT NULL, request_id TEXT REFERENCES review_requests(id) ON DELETE CASCADE, comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE, reply_id TEXT REFERENCES replies(id) ON DELETE CASCADE, actor_name TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_key));
          INSERT INTO notifications SELECT * FROM notifications_old;
          DROP TABLE notifications_old;
          CREATE INDEX notifications_recipient ON notifications(user_id,id DESC);
          CREATE TABLE document_paths(workspace_id TEXT NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), PRIMARY KEY(workspace_id,path));
          INSERT INTO document_paths SELECT workspace_id,path,id FROM documents;
          CREATE TABLE revision_links(revision_id TEXT NOT NULL REFERENCES revisions(id), href TEXT NOT NULL, target_path TEXT NOT NULL, PRIMARY KEY(revision_id,href));
        `);
        for (const row of this.all<{ id: string; body: string; path: string }>(
          'SELECT r.id,r.body,d.path FROM revisions r JOIN documents d ON d.id=r.document_id',
        )) {
          for (const href of documentLinks(row.body))
            this.run(
              'INSERT INTO revision_links VALUES(?,?,?)',
              row.id,
              href,
              relativePath(href, row.path)!,
            );
        }
        this.db.exec('PRAGMA user_version=11');
      }
    });
  }
  one<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  needsSetup() {
    return (
      this.one<{ count: number }>('SELECT count(*) count FROM users')!.count ===
      0
    );
  }
  user(id: string) {
    return this.one<User>(
      'SELECT id,name,email FROM users WHERE id=? AND disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM service_accounts WHERE user_id=users.id)',
      id,
    );
  }
  async setup(input: unknown) {
    const data = schema.account.parse(input);
    const password = await hashPassword(data.password);
    return this.transaction(() => {
      requireThat(
        this.needsSetup(),
        409,
        'already_configured',
        'An account already exists. Sign in or use an invitation.',
      );
      const user = this.insertUser(data, password);
      this.run("UPDATE users SET org_role='admin' WHERE id=?", user.id);
      const actor = { user };
      const workspace = this.createWorkspace(actor, { name: 'My workspace' });
      this.createDocument(actor, {
        workspaceId: workspace.id,
        path: 'welcome.md',
        body: welcome,
      });
      return user;
    });
  }
  private insertUser(data: { name: string; email: string }, password: string) {
    requireThat(
      !this.one('SELECT id FROM users WHERE email=?', data.email),
      409,
      'account_exists',
      'This email already has an account. Sign in to accept the invitation.',
    );
    const user = { id: randomUUID(), name: data.name, email: data.email };
    this.run(
      'INSERT INTO users(id,name,email,password) VALUES(?,?,?,?)',
      user.id,
      user.name,
      user.email,
      password,
    );
    return user;
  }
  async login(input: unknown) {
    const data = schema.credentials.parse(input);
    const row = this.one<Account>(
      'SELECT * FROM users WHERE email=? AND NOT EXISTS (SELECT 1 FROM service_accounts WHERE user_id=users.id)',
      data.email,
    );
    // Always perform password work, including for an unknown account.
    const valid = await verifyPassword(
      data.password,
      row?.password ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`,
    );
    requireThat(
      row && valid && !row.disabled_at,
      401,
      'invalid_credentials',
      'Email or password is incorrect.',
    );
    return { id: row.id, name: row.name, email: row.email };
  }
  session(user: User, authMethod: 'password' | 'entra' = 'password') {
    this.active({ user });
    this.run('DELETE FROM sessions WHERE expires_at<=?', now());
    const token = secret();
    this.run(
      'INSERT INTO sessions(hash,user_id,expires_at,auth_method) VALUES(?,?,?,?)',
      digest(token),
      user.id,
      expiry(authMethod === 'entra' ? 8 : 24 * 7),
      authMethod,
    );
    return token;
  }
  sessionActor(token: string, requireSso = false): Actor | undefined {
    const row = this.one<{ userId: string }>(
      `SELECT s.user_id userId FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND (?=0 OR s.auth_method='entra' OR u.recovery_until>?)`,
      digest(token),
      now(),
      Number(requireSso),
      now(),
    );
    const user = row && this.user(row.userId);
    return user ? { user } : undefined;
  }
  logout(token: string) {
    this.run('DELETE FROM sessions WHERE hash=?', digest(token));
  }
  tokenActor(token: string): Actor | undefined {
    const row = this.one<{
      id: string;
      userId: string;
      workspaceId: string;
      name: string;
      scope: 'read' | 'write';
    }>(
      'SELECT id,user_id userId,workspace_id workspaceId,name,scope FROM tokens WHERE hash=? AND expires_at>?',
      digest(token),
      now(),
    );
    const user =
      row &&
      this.one<User>(
        'SELECT id,name,email FROM users WHERE id=? AND disabled_at IS NULL',
        row.userId,
      );
    return user && row ? { user, token: row } : undefined;
  }
  access(actor: Actor, workspaceId: string, write = false): Role {
    this.active(actor);
    const member = this.one<{ role: Role }>(
      'SELECT role FROM effective_members WHERE workspace_id=? AND user_id=?',
      workspaceId,
      actor.user.id,
    );
    requireThat(
      member && (!actor.token || actor.token.workspaceId === workspaceId),
      404,
      'not_found',
      'Workspace not found or access was removed.',
    );
    if (write)
      requireThat(
        member.role !== 'viewer' && actor.token?.scope !== 'read',
        403,
        'read_only',
        'You have read-only access.',
      );
    return member.role;
  }
  owner(actor: Actor, workspaceId: string) {
    this.active(actor);
    if (!actor.token && this.isAdmin(actor)) {
      requireThat(
        this.one('SELECT id FROM workspaces WHERE id=?', workspaceId),
        404,
        'not_found',
        'Workspace not found.',
      );
      return;
    }
    const role = this.access(actor, workspaceId, true);
    requireThat(
      role === 'owner' && !actor.token,
      403,
      'owner_required',
      'Only the workspace owner can manage members.',
    );
  }
  workspaces(actor: Actor) {
    this.active(actor);
    return this.all<Workspace>(
      `SELECT w.id,w.name,w.created_at createdAt,m.role,(SELECT count(*) FROM documents WHERE workspace_id=w.id AND archived_at IS NULL) documentCount FROM workspaces w JOIN effective_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at`,
      actor.user.id,
    ).filter((w) => !actor.token || w.id === actor.token.workspaceId);
  }
  createWorkspace(actor: Actor, input: unknown): Workspace {
    this.active(actor);
    requireThat(
      !actor.token,
      403,
      'session_required',
      'Create workspaces from a signed-in browser.',
    );
    const { name } = z
      .object({ name: z.string().trim().min(1).max(100) })
      .parse(input);
    const id = randomUUID(),
      createdAt = now();
    this.transaction(() => {
      this.run('INSERT INTO workspaces VALUES(?,?,?)', id, name, createdAt);
      this.run('INSERT INTO members VALUES(?,?,?)', id, actor.user.id, 'owner');
      this.audit(actor, 'workspace.created', name, { workspaceId: id });
    });
    return { id, name, createdAt, role: 'owner', documentCount: 0 };
  }
  documents(actor: Actor, workspaceId: string, includeArchived = false) {
    this.access(actor, workspaceId);
    return this.all<DocumentSummary>(
      'SELECT id,workspace_id workspaceId,path,current_revision_id currentRevisionId,updated_at updatedAt,archived_at archivedAt,metadata_version metadataVersion FROM documents WHERE workspace_id=? AND (? OR archived_at IS NULL) ORDER BY path',
      workspaceId,
      Number(includeArchived),
    );
  }
  private documentRow(actor: Actor, documentId: string, write = false) {
    const doc = this.one<DocumentSummary>(
      'SELECT id,workspace_id workspaceId,path,current_revision_id currentRevisionId,updated_at updatedAt,archived_at archivedAt,metadata_version metadataVersion FROM documents WHERE id=?',
      documentId,
    );
    requireThat(doc, 404, 'not_found', 'Document not found.');
    this.access(actor, doc.workspaceId, write);
    if (write)
      requireThat(
        !doc.archivedAt,
        409,
        'document_archived',
        'This document is archived. Unarchive it before making changes. Your draft is kept.',
      );
    return doc;
  }
  document(actor: Actor, documentId: string): Document {
    const doc = this.documentRow(actor, documentId);
    return {
      ...doc,
      revision: this.revisionRow(documentId, doc.currentRevisionId),
      reviews: this.reviews(actor, documentId),
    };
  }
  private revisionRow(documentId: string, revisionId: string) {
    const row = this.one<Revision>(
      'SELECT id,document_id documentId,number,body,author_name authorName,agent_name agentName,created_at createdAt,restored_from restoredFrom FROM revisions WHERE document_id=? AND id=?',
      documentId,
      revisionId,
    );
    requireThat(row, 404, 'not_found', 'Revision not found for this document.');
    return row;
  }
  revisions(actor: Actor, documentId: string) {
    this.documentRow(actor, documentId);
    return this.all<Omit<Revision, 'body'>>(
      'SELECT id,document_id documentId,number,author_name authorName,agent_name agentName,created_at createdAt,restored_from restoredFrom FROM revisions WHERE document_id=? ORDER BY number DESC',
      documentId,
    );
  }
  revision(actor: Actor, documentId: string, revisionId: string) {
    this.documentRow(actor, documentId);
    return this.revisionRow(documentId, revisionId);
  }
  private insertRevision(
    actor: Actor,
    documentId: string,
    body: string,
    number: number,
    restoredFrom: string | null = null,
  ) {
    const id = randomUUID(),
      createdAt = now();
    this.run(
      'INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      documentId,
      number,
      body,
      actor.user.name,
      actor.user.id,
      actor.token?.name ?? null,
      createdAt,
      restoredFrom,
    );
    const source = this.one<{ path: string; currentRevisionId: string }>(
      'SELECT path,current_revision_id currentRevisionId FROM documents WHERE id=?',
      documentId,
    )!;
    const base = restoredFrom ?? source.currentRevisionId;
    for (const href of documentLinks(body)) {
      const previous = this.one<{ path: string }>(
        'SELECT target_path path FROM revision_links WHERE revision_id=? AND href=?',
        base,
        href,
      );
      this.run(
        'INSERT INTO revision_links VALUES(?,?,?)',
        id,
        href,
        previous?.path ?? relativePath(href, source.path)!,
      );
    }
    this.run(
      'UPDATE documents SET current_revision_id=?,updated_at=? WHERE id=?',
      id,
      createdAt,
      documentId,
    );
  }
  createDocument(actor: Actor, input: unknown) {
    const data = schema.createDocument.parse(input);
    this.access(actor, data.workspaceId, true);
    // Reuse an existing transaction during initial setup.
    const create = () => {
      requireThat(
        !this.one(
          'SELECT document_id id FROM document_paths WHERE workspace_id=? AND path=?',
          data.workspaceId,
          data.path,
        ),
        409,
        'path_exists',
        'A document already uses that path.',
      );
      const id = randomUUID();
      this.run(
        'INSERT INTO documents(id,workspace_id,path,current_revision_id,updated_at) VALUES(?,?,?,?,?)',
        id,
        data.workspaceId,
        data.path,
        '',
        now(),
      );
      this.run(
        'INSERT INTO document_paths VALUES(?,?,?)',
        data.workspaceId,
        data.path,
        id,
      );
      this.insertRevision(actor, id, data.body, 1);
      return this.document(actor, id);
    };
    return this.db.isTransaction ? create() : this.transaction(create);
  }
  updateDocument(actor: Actor, input: unknown) {
    const data = schema.updateDocument.parse(input);
    return this.transaction(() => {
      const doc = this.documentRow(actor, data.documentId, true);
      this.checkRevision(doc, data.expectedRevisionId);
      const current = this.revisionRow(doc.id, doc.currentRevisionId);
      if (current.body !== data.body)
        this.insertRevision(actor, doc.id, data.body, current.number + 1);
      return this.document(actor, doc.id);
    });
  }
  private checkRevision(doc: DocumentSummary, expected: string) {
    if (doc.currentRevisionId !== expected)
      throw new AppError(
        409,
        'revision_conflict',
        'Someone saved a newer revision. Your draft has been preserved. Compare it with the latest before saving again.',
        { currentRevisionId: doc.currentRevisionId },
      );
  }
  restore(actor: Actor, input: unknown) {
    const data = schema.restoreDocument.parse(input);
    return this.transaction(() => {
      const doc = this.documentRow(actor, data.documentId, true);
      this.checkRevision(doc, data.expectedRevisionId);
      const target = this.revisionRow(doc.id, data.revisionId);
      const current = this.revisionRow(doc.id, doc.currentRevisionId);
      this.insertRevision(
        actor,
        doc.id,
        target.body,
        current.number + 1,
        target.id,
      );
      return this.document(actor, doc.id);
    });
  }
  feedback(actor: Actor, documentId: string, revisionId: string) {
    const doc = this.documentRow(actor, documentId);
    const revision = this.revisionRow(documentId, revisionId);
    return {
      markdown: formatFeedback(
        doc.path,
        revision,
        this.reviews(actor, documentId),
        this.comments(actor, documentId),
        this.revisions(actor, documentId),
      ),
    };
  }
  reviews(actor: Actor, documentId: string): ReviewDecision[] {
    this.documentRow(actor, documentId);
    return this.all<ReviewDecision>(
      `SELECT r.id,r.revision_id revisionId,v.number revisionNumber,r.reviewer_id reviewerId,
       r.reviewer_name reviewerName,r.decision,r.note,r.created_at createdAt
       FROM reviews r JOIN revisions v ON v.id=r.revision_id
       WHERE r.document_id=? ORDER BY r.rowid`,
      documentId,
    );
  }
  review(actor: Actor, input: unknown) {
    const data = schema.review.parse(input);
    return this.transaction(() => {
      const doc = this.documentRow(actor, data.documentId, true);
      requireThat(
        !actor.token,
        403,
        'human_review_required',
        'Review decisions require a signed-in person. Agent keys cannot approve or request changes.',
      );
      requireThat(
        doc.currentRevisionId === data.expectedRevisionId,
        409,
        'review_conflict',
        'A newer revision is available. Read it before submitting your decision. Your review note has been kept.',
      );
      const reviewId = randomUUID();
      this.run(
        'INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)',
        reviewId,
        doc.id,
        doc.currentRevisionId,
        actor.user.id,
        actor.user.name,
        data.decision,
        data.note,
        now(),
      );
      const rounds = this.all<{ id: string; requesterId: string }>(
        'SELECT id,requester_id requesterId FROM review_requests WHERE document_id=? AND revision_id=? AND reviewer_id=? AND cancelled_at IS NULL AND closed_review_rowid IS NULL',
        doc.id,
        doc.currentRevisionId,
        actor.user.id,
      );
      for (const round of rounds) {
        const recipients = !this.one(
          'SELECT user_id FROM service_accounts WHERE user_id=?',
          round.requesterId,
        )
          ? [round.requesterId]
          : this.all<{ id: string }>(
              "SELECT user_id id FROM effective_members WHERE workspace_id=? AND role='owner'",
              doc.workspaceId,
            ).map((r) => r.id);
        this.notify(actor, doc.id, recipients, {
          kind: data.decision,
          eventKey: `review:${reviewId}:${round.id}`,
          requestId: round.id,
          preview: data.note,
        });
      }
      return this.document(actor, doc.id);
    });
  }
  reviewers(actor: Actor, workspaceId: string): Reviewer[] {
    this.access(actor, workspaceId);
    // Scoped discovery for agents: IDs, names and review capability, no account details.
    return this.all<Reviewer>(
      `SELECT u.id,u.name,m.role FROM effective_members m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=? AND m.role IN ('owner','editor') AND NOT EXISTS (SELECT 1 FROM service_accounts WHERE user_id=u.id) ORDER BY u.name,u.id`,
      workspaceId,
    );
  }
  reviewRequests(
    actor: Actor,
    workspaceId: string,
    documentId?: string,
  ): ReviewRequest[] {
    const role = this.access(actor, workspaceId);
    if (documentId) {
      const doc = this.documentRow(actor, documentId);
      requireThat(
        doc.workspaceId === workspaceId,
        404,
        'not_found',
        'Document not found in this workspace.',
      );
    }
    type Row = Omit<
      ReviewRequest,
      'status' | 'outdated' | 'decision' | 'canManage'
    > & {
      requesterTokenId: string | null;
      afterReviewRowid: number;
      closedReviewRowid: number | null;
      reviewerRole: string | null;
    };
    return this.all<Row>(
      `SELECT q.id,d.workspace_id workspaceId,q.document_id documentId,d.path,
      q.revision_id revisionId,v.number revisionNumber,q.base_revision_id baseRevisionId,
      q.reviewer_id reviewerId,q.reviewer_name reviewerName,q.requester_id requesterId,q.requester_name requesterName,
      q.requester_token_id requesterTokenId,q.agent_name agentName,q.message,q.created_at createdAt,
      q.after_review_rowid afterReviewRowid,q.closed_review_rowid closedReviewRowid,q.supersedes_id supersedesId,
      (SELECT id FROM review_requests WHERE supersedes_id=q.id) supersededBy,
      q.cancelled_at cancelledAt,q.cancelled_by cancelledBy,q.version,d.current_revision_id currentRevisionId,d.archived_at archivedAt,m.role reviewerRole
      FROM review_requests q JOIN documents d ON d.id=q.document_id JOIN revisions v ON v.id=q.revision_id
      LEFT JOIN effective_members m ON m.workspace_id=d.workspace_id AND m.user_id=q.reviewer_id
      WHERE d.workspace_id=? AND (? IS NULL OR d.id=?) ORDER BY q.rowid DESC`,
      workspaceId,
      documentId ?? null,
      documentId ?? null,
    ).map(
      ({
        requesterTokenId,
        afterReviewRowid,
        closedReviewRowid,
        reviewerRole,
        ...row
      }) => {
        const decision =
          this.one<ReviewDecision>(
            `SELECT r.id,r.revision_id revisionId,v.number revisionNumber,
          r.reviewer_id reviewerId,r.reviewer_name reviewerName,r.decision,r.note,r.created_at createdAt
          FROM reviews r JOIN revisions v ON v.id=r.revision_id WHERE r.revision_id=? AND r.reviewer_id=? AND r.rowid>? AND (? IS NULL OR r.rowid<=?)
          ORDER BY r.rowid DESC LIMIT 1`,
            row.revisionId,
            row.reviewerId,
            afterReviewRowid,
            closedReviewRowid,
            closedReviewRowid,
          ) ?? null;
        const status: ReviewRequest['status'] = row.cancelledAt
          ? 'cancelled'
          : row.supersededBy
            ? 'superseded'
            : decision && decision.decision !== 'withdrawn'
              ? decision.decision
              : row.archivedAt
                ? 'document_archived'
                : !['owner', 'editor'].includes(reviewerRole ?? '')
                  ? 'reviewer_unavailable'
                  : 'waiting';
        const canManage =
          !row.archivedAt &&
          role !== 'viewer' &&
          (actor.token
            ? actor.token.scope === 'write' &&
              requesterTokenId === actor.token.id
            : role === 'owner' || row.requesterId === actor.user.id);
        return {
          ...row,
          status,
          decision,
          outdated: row.revisionId !== row.currentRevisionId,
          canManage,
        };
      },
    );
  }
  reviewRequest(actor: Actor, requestId: string) {
    const row = this.one<{ documentId: string }>(
      'SELECT document_id documentId FROM review_requests WHERE id=?',
      requestId,
    );
    requireThat(row, 404, 'not_found', 'Review request not found.');
    const doc = this.documentRow(actor, row.documentId);
    return this.reviewRequests(actor, doc.workspaceId, doc.id).find(
      (r) => r.id === requestId,
    )!;
  }
  private insertReviewRequest(
    actor: Actor,
    data: ReturnType<typeof schema.requestReview.parse>,
    supersedesId: string | null = null,
  ) {
    const doc = this.documentRow(actor, data.documentId, true);
    requireThat(
      doc.currentRevisionId === data.expectedRevisionId,
      409,
      'request_revision_conflict',
      'The document changed. Read the latest revision before requesting review. Your message has been kept.',
    );
    const reviewer = this.reviewers(actor, doc.workspaceId).find(
      (r) => r.id === data.reviewerId,
    );
    requireThat(
      reviewer,
      400,
      'invalid_reviewer',
      'Choose a current workspace owner or editor.',
    );
    const duplicate = this.reviewRequests(actor, doc.workspaceId, doc.id).find(
      (r) =>
        r.reviewerId === data.reviewerId &&
        r.revisionId === doc.currentRevisionId &&
        r.status === 'waiting',
    );
    requireThat(
      !duplicate,
      409,
      'request_exists',
      'This reviewer already has a pending request for this revision.',
    );
    const prior = this.revisions(actor, doc.id).filter(
      (r) => r.id !== doc.currentRevisionId,
    );
    const reviews = this.reviews(actor, doc.id);
    const base =
      prior.find((r) =>
        currentDecisions(reviews, r.id).some(
          (d) => d.reviewerId === data.reviewerId,
        ),
      ) ?? prior[0];
    const id = randomUUID();
    const after = this.one<{ value: number }>(
      'SELECT coalesce(max(rowid),0) value FROM reviews',
    )!.value;
    this.run(
      `INSERT INTO review_requests
      (id,document_id,revision_id,base_revision_id,reviewer_id,reviewer_name,requester_id,requester_name,requester_token_id,agent_name,message,created_at,after_review_rowid,supersedes_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      doc.id,
      doc.currentRevisionId,
      base?.id ?? null,
      reviewer.id,
      reviewer.name,
      actor.user.id,
      actor.user.name,
      actor.token?.id ?? null,
      actor.token?.name ?? null,
      data.message,
      now(),
      after,
      supersedesId,
    );
    this.notify(actor, doc.id, [reviewer.id], {
      kind: 'review_requested',
      eventKey: `request:${id}`,
      requestId: id,
      preview: data.message,
    });
    return this.reviewRequest(actor, id);
  }
  requestReview(actor: Actor, input: unknown) {
    const data = schema.requestReview.parse(input);
    return this.transaction(() => this.insertReviewRequest(actor, data));
  }
  private manageableRequest(
    actor: Actor,
    requestId: string,
    expectedVersion: number,
  ) {
    const request = this.reviewRequest(actor, requestId);
    this.documentRow(actor, request.documentId, true);
    requireThat(
      request.canManage,
      403,
      'request_author_required',
      'Only the requester or workspace owner can manage this request. Agent keys can manage only their own requests.',
    );
    requireThat(
      request.version === expectedVersion &&
        !request.cancelledAt &&
        !request.supersededBy,
      409,
      'request_conflict',
      'This request changed or is closed. Refresh before trying again.',
    );
    return request;
  }
  cancelReviewRequest(actor: Actor, input: unknown) {
    const data = schema.cancelReviewRequest.parse(input);
    return this.transaction(() => {
      const request = this.manageableRequest(
        actor,
        data.requestId,
        data.expectedVersion,
      );
      requireThat(
        ['waiting', 'reviewer_unavailable'].includes(request.status),
        409,
        'request_completed',
        'This review round has already completed.',
      );
      this.run(
        'UPDATE review_requests SET cancelled_at=?,cancelled_by=?,closed_review_rowid=(SELECT coalesce(max(rowid),0) FROM reviews),version=version+1 WHERE id=?',
        now(),
        actor.token?.name ?? actor.user.name,
        request.id,
      );
      return this.reviewRequest(actor, request.id);
    });
  }
  renewReviewRequest(actor: Actor, input: unknown) {
    const data = schema.renewReviewRequest.parse(input);
    return this.transaction(() => {
      const request = this.manageableRequest(
        actor,
        data.requestId,
        data.expectedVersion,
      );
      requireThat(
        request.outdated ||
          ['approved', 'changes_requested'].includes(request.status),
        409,
        'request_pending',
        'This request is already waiting on the current revision.',
      );
      const next = this.insertReviewRequest(
        actor,
        {
          documentId: request.documentId,
          expectedRevisionId: data.expectedRevisionId,
          reviewerId: request.reviewerId,
          message: data.message ?? request.message,
        },
        request.id,
      );
      this.run(
        'UPDATE review_requests SET closed_review_rowid=(SELECT coalesce(max(rowid),0) FROM reviews),version=version+1 WHERE id=?',
        request.id,
      );
      return next;
    });
  }
  comments(actor: Actor, documentId: string): Comment[] {
    this.documentRow(actor, documentId);
    return this.all<
      Omit<Comment, 'anchor' | 'resolved' | 'replies' | 'images' | 'diff'> & {
        anchor: string | null;
        diff: string | null;
        images: string;
        resolved: number;
        authorId: string;
        authorTokenId: string | null;
      }
    >(
      'SELECT id,document_id documentId,revision_id revisionId,body,quote,kind,label_tip labelTip,images,anchor,diff,resolved,version,updated_at updatedAt,author_id authorId,author_token_id authorTokenId,author_name authorName,agent_name agentName,created_at createdAt FROM comments WHERE document_id=? ORDER BY created_at',
      documentId,
    ).map(({ authorId, authorTokenId, ...row }) => ({
      ...row,
      ...this.commentPermissions(actor, documentId, {
        authorId,
        authorTokenId,
        agentName: row.agentName,
      }),
      resolved: !!row.resolved,
      anchor: row.anchor ? JSON.parse(row.anchor) : null,
      images: JSON.parse(row.images),
      diff: row.diff ? JSON.parse(row.diff) : null,
      reattachments: this.all<{ anchor: string }>(
        'SELECT a.revision_id revisionId,r.number revisionNumber,a.quote,a.anchor,a.author_name authorName,a.agent_name agentName,a.created_at createdAt FROM comment_reattachments a JOIN revisions r ON r.id=a.revision_id WHERE comment_id=? ORDER BY a.rowid',
        row.id,
      ).map((a) => ({
        ...a,
        anchor: JSON.parse(a.anchor),
      })) as Comment['reattachments'],
      replies: this.all<Reply>(
        'SELECT id,body,author_name authorName,agent_name agentName,created_at createdAt FROM replies WHERE comment_id=? ORDER BY created_at',
        row.id,
      ),
    }));
  }
  addComment(actor: Actor, input: unknown) {
    const data = schema.addComment.parse(input);
    this.documentRow(actor, data.documentId, true);
    if (!data.submissionId) return this.insertComment(actor, data);
    // A lost response must not create a second discussion. Keep receipts after
    // deletion too, so retrying cannot resurrect a deliberately deleted comment.
    const fingerprint = digest(JSON.stringify(data));
    return this.transaction(() => {
      const receipt = this.one<{
        documentId: string;
        authorId: string;
        tokenId: string | null;
        fingerprint: string;
        commentId: string;
      }>(
        `SELECT document_id documentId, author_id authorId, author_token_id tokenId,
          fingerprint, comment_id commentId FROM comment_submissions WHERE submission_id=?`,
        data.submissionId!,
      );
      if (receipt) {
        requireThat(
          receipt.documentId === data.documentId &&
            receipt.authorId === actor.user.id &&
            receipt.tokenId === (actor.token?.id ?? null) &&
            receipt.fingerprint === fingerprint,
          409,
          'submission_conflict',
          'This submission ID has already been used.',
        );
        const comment = this.comments(actor, data.documentId).find(
          (c) => c.id === receipt.commentId,
        );
        requireThat(
          comment,
          409,
          'comment_deleted',
          'This comment was saved, then deleted. Discard the recovered submission.',
        );
        return comment;
      }
      const comment = this.insertComment(actor, data);
      this.run(
        'INSERT INTO comment_submissions VALUES(?,?,?,?,?,?)',
        data.submissionId!,
        data.documentId,
        actor.user.id,
        actor.token?.id ?? null,
        fingerprint,
        comment.id,
      );
      return comment;
    });
  }
  private insertComment(actor: Actor, data: z.infer<typeof schema.addComment>) {
    requireThat(
      data.kind === 'deletion' ||
        data.body.length > 0 ||
        (data.kind === 'comment' && data.images.length > 0),
      400,
      'invalid_comment',
      'Add comment text or an image. Labels need text.',
    );
    requireThat(
      data.kind === 'comment' || data.quote.trim().length > 0,
      400,
      'invalid_quote',
      'Redlines and labels must refer to a passage.',
    );
    this.documentRow(actor, data.documentId, true);
    for (const image of data.images) {
      requireThat(
        this.one(
          'SELECT id FROM images WHERE id=? AND document_id=?',
          image.path.split('/').pop()!,
          data.documentId,
        ),
        400,
        'invalid_image',
        'Use an image uploaded to this document.',
      );
    }
    const revision = this.revisionRow(data.documentId, data.revisionId);
    if (data.diff) {
      const base = this.revisionRow(data.documentId, data.diff.baseRevisionId);
      requireThat(
        base.number < revision.number,
        400,
        'invalid_comparison',
        'The baseline must precede the reviewed revision.',
      );
      const block = computePlanDiff(base.body, revision.body).blocks[
        data.diff.blockIndex
      ];
      requireThat(
        block &&
          block.type !== 'unchanged' &&
          (block.type === data.diff.side ||
            (block.type === 'modified' && data.diff.side === 'removed')),
        400,
        'invalid_diff_anchor',
        'Choose a changed passage in this comparison.',
      );
      // Derive the quote from immutable revisions, matching upstream's diff annotation format.
      data.quote =
        block.type === 'modified'
          ? data.diff.side === 'removed'
            ? block.oldContent || block.content
            : block.oldContent && block.oldContent !== block.content
              ? `- ${block.oldContent.trimEnd()}\n+ ${block.content.trimEnd()}`
              : block.content
          : block.content;
      requireThat(
        data.quote.length <= 8192,
        400,
        'invalid_quote',
        'This change is too large to annotate as one passage. Leave a document discussion instead.',
      );
      data.anchor = {
        blockId: `diff-block-${data.diff.blockIndex}`,
        startOffset: 0,
        endOffset: data.quote.length,
      };
    }
    // Quotes may come from rendered Markdown, whose exact text differs from source.
    requireThat(
      !data.quote || data.quote.trim(),
      400,
      'invalid_quote',
      'A quote must contain text.',
    );
    const id = randomUUID();
    this.run(
      'INSERT INTO comments (id,document_id,revision_id,body,quote,anchor,resolved,author_name,author_id,agent_name,created_at,kind,label_tip,images,author_token_id,diff) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)',
      id,
      data.documentId,
      revision.id,
      data.body,
      data.quote,
      data.anchor ? JSON.stringify(data.anchor) : null,
      actor.user.name,
      actor.user.id,
      actor.token?.name ?? null,
      now(),
      data.kind,
      data.kind === 'label' ? data.labelTip : null,
      JSON.stringify(data.images),
      actor.token?.id ?? null,
      data.diff ? JSON.stringify(data.diff) : null,
    );
    return this.comments(actor, data.documentId).find((c) => c.id === id)!;
  }
  private commentPermissions(
    actor: Actor,
    documentId: string,
    row: {
      authorId: string;
      authorTokenId: string | null;
      agentName: string | null;
    },
  ) {
    const doc = this.documentRow(actor, documentId);
    const role = this.access(actor, doc.workspaceId);
    const writable =
      !doc.archivedAt && role !== 'viewer' && actor.token?.scope !== 'read';
    const own =
      row.authorId === actor.user.id &&
      (actor.token
        ? row.authorTokenId === actor.token.id
        : row.agentName === null);
    return {
      canEdit: writable && own,
      canDelete: writable && (own || (role === 'owner' && !actor.token)),
    };
  }
  private mutableComment(
    actor: Actor,
    commentId: string,
    expectedVersion: number,
    deleting = false,
  ) {
    const row = this.one<{
      documentId: string;
      authorId: string;
      authorTokenId: string | null;
      agentName: string | null;
      version: number;
      kind: string;
      images: string;
    }>(
      'SELECT document_id documentId,author_id authorId,author_token_id authorTokenId,agent_name agentName,version,kind,images FROM comments WHERE id=?',
      commentId,
    );
    requireThat(row, 404, 'not_found', 'Comment not found.');
    this.documentRow(actor, row.documentId, true);
    const permissions = this.commentPermissions(actor, row.documentId, row);
    requireThat(
      deleting ? permissions.canDelete : permissions.canEdit,
      403,
      'comment_author_required',
      deleting
        ? 'Only the author or workspace owner can delete this discussion.'
        : 'Only the author can edit this annotation.',
    );
    requireThat(
      row.version === expectedVersion,
      409,
      'comment_conflict',
      'This discussion changed. Your text has been kept; cancel and reopen the editor after checking the latest discussion.',
    );
    return row;
  }
  editComment(actor: Actor, input: unknown) {
    const data = schema.editComment.parse(input);
    return this.transaction(() => {
      const row = this.mutableComment(
        actor,
        data.commentId,
        data.expectedVersion,
      );
      requireThat(
        row.kind === 'deletion' ||
          !!data.body ||
          (row.kind === 'comment' && JSON.parse(row.images).length > 0),
        400,
        'invalid_comment',
        'Add comment text.',
      );
      this.run(
        'UPDATE comments SET body=?,updated_at=?,version=version+1 WHERE id=?',
        data.body,
        now(),
        data.commentId,
      );
      return this.comments(actor, row.documentId).find(
        (c) => c.id === data.commentId,
      )!;
    });
  }
  reattachComment(actor: Actor, input: unknown) {
    const data = schema.reattachComment.parse(input);
    return this.transaction(() => {
      const row = this.mutableComment(
        actor,
        data.commentId,
        data.expectedVersion,
      );
      const doc = this.documentRow(actor, row.documentId, true);
      requireThat(
        doc.currentRevisionId === data.expectedRevisionId,
        409,
        'attachment_conflict',
        'The document changed. Cancel reattachment and choose a passage in the latest revision.',
      );
      this.run(
        'INSERT INTO comment_reattachments VALUES(?,?,?,?,?,?,?,?,?)',
        randomUUID(),
        data.commentId,
        doc.currentRevisionId,
        data.quote,
        JSON.stringify(data.anchor),
        actor.user.id,
        actor.user.name,
        actor.token?.name ?? null,
        now(),
      );
      this.run(
        'UPDATE comments SET version=version+1 WHERE id=?',
        data.commentId,
      );
      return this.comments(actor, row.documentId).find(
        (c) => c.id === data.commentId,
      )!;
    });
  }
  deleteComment(actor: Actor, input: unknown) {
    const data = schema.deleteComment.parse(input);
    return this.transaction(() => {
      this.mutableComment(actor, data.commentId, data.expectedVersion, true);
      this.run('DELETE FROM replies WHERE comment_id=?', data.commentId);
      this.run('DELETE FROM comments WHERE id=?', data.commentId);
      return { ok: true };
    });
  }
  uploadImage(actor: Actor, documentId: string, data: Buffer) {
    this.documentRow(actor, documentId, true);
    requireThat(
      Buffer.isBuffer(data) &&
        data.length > 0 &&
        data.length <= 5 * 1024 * 1024,
      400,
      'invalid_image',
      'Upload an image up to 5 MB.',
    );
    const mime = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? 'image/jpeg'
        : ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())
          ? 'image/gif'
          : data.subarray(0, 4).toString() === 'RIFF' &&
              data.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : null;
    requireThat(
      mime,
      400,
      'invalid_image',
      'Supported images: PNG, JPEG, GIF and WebP.',
    );
    const id = randomUUID();
    this.run(
      'INSERT INTO images VALUES(?,?,?,?,?,?)',
      id,
      documentId,
      mime,
      data,
      actor.user.id,
      now(),
    );
    return { path: `/api/images/${id}` };
  }
  image(actor: Actor, id: string) {
    const image = this.one<{
      documentId: string;
      mime: string;
      data: Uint8Array;
    }>('SELECT document_id documentId,mime,data FROM images WHERE id=?', id);
    requireThat(image, 404, 'not_found', 'Image not found.');
    this.documentRow(actor, image.documentId);
    return image;
  }
  private commentRow(actor: Actor, commentId: string) {
    const row = this.one<{ documentId: string; resolved: number }>(
      'SELECT document_id documentId,resolved FROM comments WHERE id=?',
      commentId,
    );
    requireThat(row, 404, 'not_found', 'Comment not found.');
    this.documentRow(actor, row.documentId, true);
    return row;
  }
  reply(actor: Actor, input: unknown) {
    const data = schema.reply.parse(input);
    return this.transaction(() => {
      const row = this.commentRow(actor, data.commentId);
      requireThat(
        !row.resolved,
        409,
        'thread_resolved',
        'Reopen this discussion before replying.',
      );
      const recipients = this.all<{ id: string }>(
        'SELECT author_id id FROM comments WHERE id=? UNION SELECT author_id id FROM replies WHERE comment_id=?',
        data.commentId,
        data.commentId,
      ).map((r) => r.id);
      const id = randomUUID();
      this.run(
        'INSERT INTO replies VALUES(?,?,?,?,?,?,?)',
        id,
        data.commentId,
        data.body,
        actor.user.name,
        actor.user.id,
        actor.token?.name ?? null,
        now(),
      );
      this.run(
        'UPDATE comments SET version=version+1 WHERE id=?',
        data.commentId,
      );
      this.notify(actor, row.documentId, recipients, {
        kind: 'reply',
        eventKey: `reply:${id}`,
        commentId: data.commentId,
        replyId: id,
        preview: data.body,
      });
      return this.comments(actor, row.documentId).find(
        (c) => c.id === data.commentId,
      )!;
    });
  }
  resolve(actor: Actor, input: unknown) {
    const data = schema.resolve.parse(input),
      row = this.commentRow(actor, data.commentId);
    this.run(
      'UPDATE comments SET resolved=?,version=version+1 WHERE id=?',
      Number(data.resolved),
      data.commentId,
    );
    return this.comments(actor, row.documentId).find(
      (c) => c.id === data.commentId,
    )!;
  }
  members(actor: Actor, workspaceId: string) {
    this.active(actor);
    if (!this.isAdmin(actor)) this.access(actor, workspaceId);
    requireThat(
      !actor.token,
      403,
      'session_required',
      'Member information requires a browser session.',
    );
    return this.all<Member>(
      `SELECT u.id,u.name,u.email,m.role,d.role directRole FROM effective_members m JOIN users u ON u.id=m.user_id
      LEFT JOIN members d ON d.workspace_id=m.workspace_id AND d.user_id=m.user_id WHERE m.workspace_id=? AND NOT EXISTS (SELECT 1 FROM service_accounts WHERE user_id=u.id) ORDER BY m.role,u.name`,
      workspaceId,
    ).map((m) => ({
      ...m,
      teams: this.all<{ name: string; role: string }>(
        'SELECT t.name,tw.role FROM teams t JOIN team_members tm ON tm.team_id=t.id JOIN team_workspaces tw ON tw.team_id=t.id WHERE tm.user_id=? AND tw.workspace_id=? ORDER BY t.name',
        m.id,
        workspaceId,
      ),
    }));
  }
  removeMember(actor: Actor, workspaceId: string, userId: string) {
    return this.changeMember(actor, workspaceId, {
      userId,
      role: null,
      expectedVersion: this.organization(actor).version,
    });
  }
  invites(actor: Actor, workspaceId: string) {
    this.owner(actor, workspaceId);
    return this.all<InviteInfo>(
      'SELECT id,role,expires_at expiresAt FROM invites WHERE workspace_id=? AND expires_at>?',
      workspaceId,
      now(),
    );
  }
  invite(actor: Actor, workspaceId: string, input: unknown) {
    return this.transaction(() => {
      this.owner(actor, workspaceId);
      const { role } = z.object({ role: schema.role }).parse(input);
      const token = secret(),
        id = randomUUID(),
        expiresAt = expiry(48);
      this.run(
        'INSERT INTO invites(id,hash,workspace_id,role,expires_at,created_by) VALUES(?,?,?,?,?,?)',
        id,
        digest(token),
        workspaceId,
        role,
        expiresAt,
        actor.user.id,
      );
      this.audit(actor, 'invitation.created', workspaceId, {
        invitationId: id,
        role,
      });
      return { id, token, role, expiresAt };
    });
  }
  revokeInvite(actor: Actor, workspaceId: string, id: string) {
    return this.transaction(() => {
      this.owner(actor, workspaceId);
      requireThat(
        this.one(
          'SELECT id FROM invites WHERE workspace_id=? AND id=?',
          workspaceId,
          id,
        ),
        404,
        'not_found',
        'Invitation not found.',
      );
      this.audit(actor, 'invitation.revoked', workspaceId, {
        invitationId: id,
      });
      this.run(
        'DELETE FROM invites WHERE workspace_id=? AND id=?',
        workspaceId,
        id,
      );
    });
  }
  private inviteRow(token: string) {
    const row = this.one<{
      id: string;
      workspaceId: string;
      role: Role;
      name: string;
    }>(
      'SELECT i.id,i.workspace_id workspaceId,i.role,w.name FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE i.hash=? AND i.expires_at>?',
      digest(token),
      now(),
    );
    requireThat(
      row,
      404,
      'invite_unavailable',
      'This invitation has expired, been revoked, or already been used.',
    );
    return row;
  }
  inspectInvite(token: string) {
    const { name, role } = this.inviteRow(token);
    return { name, role };
  }
  acceptInvite(user: User, token: string) {
    const accept = () => {
      this.active({ user });
      const invite = this.inviteRow(token);
      this.run(
        'INSERT OR IGNORE INTO members VALUES(?,?,?)',
        invite.workspaceId,
        user.id,
        invite.role,
      );
      this.run('DELETE FROM invites WHERE id=?', invite.id);
      this.audit({ user }, 'invitation.accepted', invite.name, {
        workspaceId: invite.workspaceId,
        role: invite.role,
      });
      return { workspaceId: invite.workspaceId };
    };
    return this.db.isTransaction ? accept() : this.transaction(accept);
  }
  async register(input: unknown) {
    const data = schema.account
      .extend({ invitation: z.string().min(32).max(128) })
      .parse(input);
    this.inviteRow(data.invitation);
    const password = await hashPassword(data.password);
    return this.transaction(() => {
      this.inviteRow(data.invitation);
      const user = this.insertUser(data, password);
      this.acceptInvite(user, data.invitation);
      return user;
    });
  }
  tokens(actor: Actor, workspaceId: string) {
    this.access(actor, workspaceId);
    requireThat(
      !actor.token,
      403,
      'session_required',
      'Manage agent keys from a signed-in browser.',
    );
    return this.all<TokenInfo>(
      "SELECT id,name,scope,created_at createdAt,expires_at expiresAt,last_used_at lastUsedAt,(SELECT name FROM users WHERE id=tokens.user_id) ownerName,'person' ownerType FROM tokens WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC",
      actor.user.id,
      workspaceId,
    );
  }
  createToken(actor: Actor, workspaceId: string, input: unknown) {
    return this.transaction(() => {
      const data = z
        .object({
          name: z.string().trim().min(1).max(80),
          scope: z.enum(['read', 'write']),
        })
        .parse(input);
      this.tokens(actor, workspaceId);
      this.access(actor, workspaceId, data.scope === 'write');
      const token = `pw_${secret()}`,
        id = randomUUID(),
        createdAt = now(),
        expiresAt = expiry(24 * 90);
      this.run(
        'INSERT INTO tokens(id,hash,user_id,workspace_id,name,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        digest(token),
        actor.user.id,
        workspaceId,
        data.name,
        data.scope,
        createdAt,
        expiresAt,
      );
      this.audit(actor, 'credential.created', data.name, {
        tokenId: id,
        workspaceId,
        scope: data.scope,
      });
      return {
        id,
        token,
        name: data.name,
        scope: data.scope,
        createdAt,
        expiresAt,
      };
    });
  }
  revokeToken(actor: Actor, workspaceId: string, id: string) {
    return this.transaction(() => {
      this.tokens(actor, workspaceId);
      const token = this.one<{ name: string }>(
        'SELECT name FROM tokens WHERE workspace_id=? AND user_id=? AND id=?',
        workspaceId,
        actor.user.id,
        id,
      );
      requireThat(token, 404, 'not_found', 'Agent key not found.');
      this.audit(actor, 'credential.revoked', token.name, {
        workspaceId,
        tokenId: id,
      });
      this.run(
        'DELETE FROM tokens WHERE workspace_id=? AND user_id=? AND id=?',
        workspaceId,
        actor.user.id,
        id,
      );
    });
  }
  private active(actor: Actor) {
    requireThat(
      actor.token
        ? this.one(
            'SELECT id FROM users WHERE id=? AND disabled_at IS NULL',
            actor.user.id,
          )
        : this.user(actor.user.id),
      401,
      'unauthorized',
      'This account is unavailable. Sign in again.',
    );
    if (actor.token)
      requireThat(
        this.one(
          'SELECT id FROM tokens WHERE id=? AND user_id=? AND expires_at>?',
          actor.token.id,
          actor.user.id,
          now(),
        ),
        401,
        'unauthorized',
        'This agent key was revoked or expired.',
      );
  }
  private isAdmin(actor: Actor) {
    return (
      !actor.token &&
      !!this.one(
        "SELECT id FROM users WHERE id=? AND org_role='admin' AND disabled_at IS NULL",
        actor.user.id,
      )
    );
  }
  private admin(actor: Actor) {
    this.active(actor);
    requireThat(
      this.isAdmin(actor),
      403,
      'admin_required',
      'Organization administration requires an administrator’s browser session.',
    );
  }
  organization(actor: Actor): Organization {
    this.active(actor);
    requireThat(
      !actor.token,
      403,
      'session_required',
      'Organization information requires a browser session.',
    );
    return {
      ...this.one<{ name: string; version: number }>(
        'SELECT name,version FROM organization WHERE id=1',
      )!,
      isAdmin: this.isAdmin(actor),
    };
  }
  private audit(
    actor: Actor,
    action: string,
    target: string,
    details: Record<string, unknown> = {},
  ) {
    this.run(
      'INSERT INTO audit_log(actor_id,actor_name,action,target,details,created_at) VALUES(?,?,?,?,?,?)',
      actor.user.id,
      actor.user.name,
      action,
      target,
      JSON.stringify(details),
      now(),
    );
    if (action !== 'identity.signed_in')
      this.run('UPDATE organization SET version=version+1 WHERE id=1');
  }
  private administrationChange(
    actor: Actor,
    expectedVersion: number,
    fn: () => void,
  ) {
    return this.transaction(() => {
      const current = this.organization(actor);
      requireThat(
        current.version === expectedVersion,
        409,
        'administration_changed',
        'Access settings changed. Refresh, check the latest settings, and try again.',
      );
      fn();
      // A removed team/direct grant must not leave usable credentials behind.
      this.run(
        'DELETE FROM tokens WHERE NOT EXISTS (SELECT 1 FROM effective_members m WHERE m.workspace_id=tokens.workspace_id AND m.user_id=tokens.user_id)',
      );
      return this.organization(actor);
    });
  }
  organizationAdmin(actor: Actor): OrganizationAdmin {
    this.admin(actor);
    return {
      ...this.organization(actor),
      people: this.all<OrgPerson>(
        'SELECT id,name,email,org_role orgRole,disabled_at disabledAt FROM users WHERE NOT EXISTS (SELECT 1 FROM service_accounts WHERE user_id=users.id) ORDER BY name,id',
      ),
      teams: this.all<{ id: string; name: string }>(
        'SELECT id,name FROM teams ORDER BY name',
      ).map((team) => ({
        ...team,
        memberIds: this.all<{ id: string }>(
          'SELECT user_id id FROM team_members WHERE team_id=?',
          team.id,
        ).map((u) => u.id),
        workspaces: this.all<{
          workspaceId: string;
          role: 'editor' | 'viewer';
        }>(
          'SELECT workspace_id workspaceId,role FROM team_workspaces WHERE team_id=?',
          team.id,
        ),
      })),
      workspaces: this.all<{ id: string; name: string }>(
        'SELECT id,name FROM workspaces ORDER BY name',
      ).map((w) => ({ ...w, members: this.members(actor, w.id) })),
      credentials: this.all<OrganizationAdmin['credentials'][number]>(
        `SELECT t.id,t.name,t.scope,t.created_at createdAt,t.expires_at expiresAt,t.user_id userId,u.name userName,w.name workspaceName,t.last_used_at lastUsedAt,CASE WHEN EXISTS(SELECT 1 FROM service_accounts s WHERE s.user_id=u.id) THEN 'service' ELSE 'person' END ownerType FROM tokens t JOIN users u ON u.id=t.user_id JOIN workspaces w ON w.id=t.workspace_id WHERE t.expires_at>? ORDER BY t.created_at DESC`,
        now(),
      ),
    };
  }
  auditLog(actor: Actor, before?: unknown) {
    this.admin(actor);
    const cursor =
      before === undefined
        ? Number.MAX_SAFE_INTEGER
        : z.coerce.number().int().positive().parse(before);
    const rows = this.all<Omit<AuditEntry, 'details'> & { details: string }>(
      'SELECT id,actor_name actorName,action,target,details,created_at createdAt FROM audit_log WHERE id<? ORDER BY id DESC LIMIT 51',
      cursor,
    );
    return {
      entries: rows
        .slice(0, 50)
        .map((r) => ({ ...r, details: JSON.parse(r.details) })),
      next: rows.length > 50 ? rows[49].id : null,
    };
  }
  updateOrganization(actor: Actor, input: unknown) {
    this.admin(actor);
    const data = z
      .object({
        name: z.string().trim().min(1).max(100),
        expectedVersion: z.number().int(),
      })
      .parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      this.run('UPDATE organization SET name=? WHERE id=1', data.name);
      this.audit(actor, 'organization.renamed', data.name);
    });
  }
  changeOrgRole(actor: Actor, userId: string, input: unknown) {
    this.admin(actor);
    const data = z
      .object({
        role: z.enum(['admin', 'member']),
        expectedVersion: z.number().int(),
      })
      .parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      const user = this.user(userId);
      requireThat(user, 404, 'not_found', 'Active account not found.');
      if (data.role === 'member') this.protectLastAdmin(userId);
      const previousRole = this.one<{ role: string }>(
        'SELECT org_role role FROM users WHERE id=?',
        userId,
      )!.role;
      this.run('UPDATE users SET org_role=? WHERE id=?', data.role, userId);
      this.audit(actor, 'account.role_changed', user.name, {
        userId,
        previousRole,
        role: data.role,
      });
    });
  }
  private protectLastAdmin(userId: string) {
    const admins = this.all<{ id: string }>(
      "SELECT id FROM users WHERE org_role='admin' AND disabled_at IS NULL",
    );
    requireThat(
      admins.some((u) => u.id !== userId),
      409,
      'last_admin',
      'Keep at least one active organization administrator.',
    );
  }
  offboard(actor: Actor, userId: string, input: unknown) {
    this.admin(actor);
    const data = z
      .object({
        expectedVersion: z.number().int(),
        successorId: z.string().optional(),
      })
      .parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      requireThat(
        userId !== actor.user.id,
        400,
        'self_offboarding',
        'Ask another administrator to offboard your account.',
      );
      const user = this.user(userId);
      requireThat(user, 404, 'not_found', 'Active account not found.');
      this.protectLastAdmin(userId);
      const owned = this.all<{ id: string }>(
        `SELECT workspace_id id FROM members m WHERE user_id=? AND role='owner' AND NOT EXISTS (SELECT 1 FROM effective_members e WHERE e.workspace_id=m.workspace_id AND e.role='owner' AND e.user_id<>m.user_id)`,
        userId,
      );
      if (owned.length) {
        requireThat(
          data.successorId &&
            data.successorId !== userId &&
            this.user(data.successorId),
          409,
          'successor_required',
          'Choose an active successor for this person’s solely owned workspaces.',
        );
        for (const w of owned)
          this.run(
            "INSERT INTO members VALUES(?,?,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner'",
            w.id,
            data.successorId,
          );
      }
      this.run(
        "UPDATE users SET disabled_at=?,org_role='member' WHERE id=?",
        now(),
        userId,
      );
      this.run('DELETE FROM sessions WHERE user_id=?', userId);
      this.run('DELETE FROM tokens WHERE user_id=?', userId);
      this.run('DELETE FROM members WHERE user_id=?', userId);
      this.run('DELETE FROM team_members WHERE user_id=?', userId);
      // Older invitations have no recorded issuer; revoke them during offboarding too.
      this.run(
        'DELETE FROM invites WHERE created_by=? OR created_by IS NULL',
        userId,
      );
      this.audit(actor, 'account.offboarded', user.name, {
        userId,
        successorId: owned.length ? data.successorId : null,
        transferredWorkspaceIds: owned.map((w) => w.id),
      });
    });
  }
  reactivate(actor: Actor, userId: string, input: unknown) {
    this.admin(actor);
    const data = z.object({ expectedVersion: z.number().int() }).parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      const user = this.one<User>(
        'SELECT id,name,email FROM users WHERE id=? AND disabled_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_accounts WHERE user_id=users.id)',
        userId,
      );
      requireThat(user, 404, 'not_found', 'Disabled account not found.');
      this.run('UPDATE users SET disabled_at=NULL WHERE id=?', userId);
      this.audit(actor, 'account.reactivated', user.name, { userId });
    });
  }
  changeMember(actor: Actor, workspaceId: string, input: unknown) {
    this.owner(actor, workspaceId);
    const data = z
      .object({
        userId: z.string(),
        role: z.enum(['owner', 'editor', 'viewer']).nullable(),
        expectedVersion: z.number().int(),
      })
      .parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      const user = this.user(data.userId);
      requireThat(user, 404, 'not_found', 'Active account not found.');
      // Workspace owners can change existing members; only org admins can discover/add other accounts.
      if (!this.isAdmin(actor))
        requireThat(
          this.one(
            'SELECT 1 FROM effective_members WHERE workspace_id=? AND user_id=?',
            workspaceId,
            data.userId,
          ),
          404,
          'not_found',
          'Invite this person to the workspace first.',
        );
      if (data.role !== 'owner')
        this.protectLastOwner(workspaceId, data.userId);
      const previousRole =
        this.one<{ role: string }>(
          'SELECT role FROM members WHERE workspace_id=? AND user_id=?',
          workspaceId,
          data.userId,
        )?.role ?? null;
      if (data.role)
        this.run(
          'INSERT INTO members VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role',
          workspaceId,
          data.userId,
          data.role,
        );
      else
        this.run(
          'DELETE FROM members WHERE workspace_id=? AND user_id=?',
          workspaceId,
          data.userId,
        );
      this.audit(actor, 'workspace.member_changed', user.name, {
        workspaceId,
        userId: data.userId,
        previousRole,
        role: data.role,
      });
    });
  }
  private protectLastOwner(workspaceId: string, userId: string) {
    requireThat(
      this.one(
        "SELECT 1 FROM effective_members WHERE workspace_id=? AND role='owner' AND user_id<>?",
        workspaceId,
        userId,
      ),
      409,
      'last_owner',
      'Keep at least one active workspace owner. Transfer ownership first.',
    );
  }
  transferOwnership(actor: Actor, workspaceId: string, input: unknown) {
    this.owner(actor, workspaceId);
    const data = z
      .object({
        fromUserId: z.string(),
        toUserId: z.string(),
        expectedVersion: z.number().int(),
      })
      .parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      requireThat(
        data.fromUserId !== data.toUserId && this.user(data.toUserId),
        400,
        'invalid_successor',
        'Choose a different active account.',
      );
      requireThat(
        this.one(
          "SELECT 1 FROM members WHERE workspace_id=? AND user_id=? AND role='owner'",
          workspaceId,
          data.fromUserId,
        ),
        409,
        'owner_changed',
        'The selected person is no longer an owner.',
      );
      requireThat(
        this.isAdmin(actor) || data.fromUserId === actor.user.id,
        403,
        'owner_required',
        'You can transfer your own ownership.',
      );
      if (!this.isAdmin(actor))
        requireThat(
          this.one(
            'SELECT 1 FROM effective_members WHERE workspace_id=? AND user_id=?',
            workspaceId,
            data.toUserId,
          ),
          400,
          'invalid_successor',
          'Invite the successor to this workspace first.',
        );
      this.run(
        "INSERT INTO members VALUES(?,?,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner'",
        workspaceId,
        data.toUserId,
      );
      this.run(
        "UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?",
        workspaceId,
        data.fromUserId,
      );
      this.audit(actor, 'workspace.ownership_transferred', workspaceId, {
        fromUserId: data.fromUserId,
        toUserId: data.toUserId,
      });
    });
  }
  saveTeam(actor: Actor, teamId: string | null, input: unknown) {
    this.admin(actor);
    const data = z
      .object({
        expectedVersion: z.number().int(),
        name: z.string().trim().min(1).max(100),
        memberIds: z.array(z.string()).max(1000),
        workspaces: z
          .array(
            z.object({
              workspaceId: z.string(),
              role: z.enum(['editor', 'viewer']),
            }),
          )
          .max(1000),
      })
      .parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      if (teamId)
        requireThat(
          this.one('SELECT id FROM teams WHERE id=?', teamId),
          404,
          'not_found',
          'Team not found.',
        );
      requireThat(
        !this.one(
          'SELECT id FROM teams WHERE name=? COLLATE NOCASE AND id<>?',
          data.name,
          teamId ?? '',
        ),
        409,
        'team_exists',
        'A team with this name already exists.',
      );
      requireThat(
        new Set(data.memberIds).size === data.memberIds.length &&
          new Set(data.workspaces.map((w) => w.workspaceId)).size ===
            data.workspaces.length,
        400,
        'duplicate_grant',
        'Each person and workspace can appear only once in a team.',
      );
      for (const id of data.memberIds)
        requireThat(
          this.user(id),
          400,
          'invalid_member',
          'Team members must be active organization accounts.',
        );
      for (const w of data.workspaces)
        requireThat(
          this.one('SELECT id FROM workspaces WHERE id=?', w.workspaceId),
          400,
          'invalid_workspace',
          'Workspace not found.',
        );
      const id = teamId ?? randomUUID();
      this.run(
        'INSERT INTO teams VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
        id,
        data.name,
      );
      this.run('DELETE FROM team_members WHERE team_id=?', id);
      this.run('DELETE FROM team_workspaces WHERE team_id=?', id);
      for (const uid of data.memberIds)
        this.run('INSERT INTO team_members VALUES(?,?)', id, uid);
      for (const w of data.workspaces)
        this.run(
          'INSERT INTO team_workspaces VALUES(?,?,?)',
          id,
          w.workspaceId,
          w.role,
        );
      this.audit(actor, teamId ? 'team.updated' : 'team.created', data.name, {
        teamId: id,
        memberIds: data.memberIds,
        workspaces: data.workspaces,
      });
    });
  }
  deleteTeam(actor: Actor, teamId: string, input: unknown) {
    this.admin(actor);
    const data = z.object({ expectedVersion: z.number().int() }).parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      const team = this.one<{ name: string }>(
        'SELECT name FROM teams WHERE id=?',
        teamId,
      );
      requireThat(team, 404, 'not_found', 'Team not found.');
      this.run('DELETE FROM teams WHERE id=?', teamId);
      this.audit(actor, 'team.deleted', team.name, { teamId });
    });
  }
  revokeOrgToken(actor: Actor, tokenId: string, input: unknown) {
    this.admin(actor);
    const data = z.object({ expectedVersion: z.number().int() }).parse(input);
    return this.administrationChange(actor, data.expectedVersion, () => {
      const token = this.one<{
        name: string;
        userId: string;
        workspaceId: string;
      }>(
        'SELECT name,user_id userId,workspace_id workspaceId FROM tokens WHERE id=?',
        tokenId,
      );
      requireThat(token, 404, 'not_found', 'Agent key not found.');
      this.run('DELETE FROM tokens WHERE id=?', tokenId);
      this.audit(actor, 'credential.revoked_by_admin', token.name, {
        tokenId,
        userId: token.userId,
        workspaceId: token.workspaceId,
      });
    });
  }
  passwordAllowed(user: User, requireSso: boolean) {
    return (
      !requireSso ||
      !!this.one(
        'SELECT id FROM users WHERE id=? AND recovery_until>? AND disabled_at IS NULL',
        user.id,
        now(),
      )
    );
  }
  identityStatus(actor: Actor) {
    this.active(actor);
    requireThat(
      !actor.token,
      403,
      'session_required',
      'Account settings require a browser session.',
    );
    return {
      linked: !!this.one(
        'SELECT user_id FROM identities WHERE user_id=?',
        actor.user.id,
      ),
    };
  }
  beginIdentityFlow(input: {
    state: string;
    browser: string;
    verifier: string;
    nonce: string;
    userId?: string;
    session?: string;
    invitation?: string;
  }) {
    this.transaction(() => {
      this.run('DELETE FROM identity_flows WHERE expires_at<=?', now());
      requireThat(
        this.one<{ n: number }>('SELECT COUNT(*) n FROM identity_flows')!.n <
          1000,
        429,
        'rate_limited',
        'Too many sign-in attempts. Try again later.',
      );
      if (input.invitation) this.inviteRow(input.invitation);
      this.run(
        'INSERT INTO identity_flows VALUES(?,?,?,?,?,?,?,?)',
        digest(input.state),
        digest(input.browser),
        input.verifier,
        input.nonce,
        input.userId ?? null,
        input.session ? digest(input.session) : null,
        input.invitation ?? null,
        expiry(1 / 6),
      );
    });
  }
  consumeIdentityFlow(state: string, browser: string) {
    return this.transaction(() => {
      const flow = this.one<{
        verifier: string;
        nonce: string;
        userId: string | null;
        sessionHash: string | null;
        invitation: string | null;
      }>(
        'SELECT verifier,nonce,user_id userId,session_hash sessionHash,invitation FROM identity_flows WHERE hash=? AND browser_hash=? AND expires_at>?',
        digest(state),
        digest(browser),
        now(),
      );
      requireThat(
        flow,
        400,
        'invalid_signin',
        'Sign-in expired or belongs to another browser. Start again.',
      );
      this.run('DELETE FROM identity_flows WHERE hash=?', digest(state));
      return flow;
    });
  }
  async entraSignIn(
    identity: {
      tenantId: string;
      objectId: string;
      name?: string;
      email?: string;
    },
    flow: {
      userId: string | null;
      sessionHash: string | null;
      invitation: string | null;
    },
  ) {
    // A random, undisclosed password keeps newly invited SSO accounts from password sign-in.
    const password = flow.invitation ? await hashPassword(secret()) : '';
    return this.transaction(() => {
      const linked = this.one<{ userId: string }>(
        'SELECT user_id userId FROM identities WHERE tenant_id=? AND object_id=?',
        identity.tenantId,
        identity.objectId,
      );
      let user: User | undefined;
      if (flow.userId) {
        requireThat(
          flow.sessionHash &&
            this.one(
              'SELECT hash FROM sessions WHERE hash=? AND user_id=? AND expires_at>?',
              flow.sessionHash,
              flow.userId,
              now(),
            ),
          401,
          'session_expired',
          'Sign in again before linking your Microsoft account.',
        );
        user = this.user(flow.userId);
        requireThat(
          !linked || linked.userId === flow.userId,
          409,
          'identity_linked',
          'This Microsoft account is already linked to another account.',
        );
        requireThat(
          !this.one(
            'SELECT user_id FROM identities WHERE user_id=?',
            flow.userId,
          ),
          409,
          'identity_linked',
          'This account already has a Microsoft identity.',
        );
      } else if (linked) user = this.user(linked.userId);
      else {
        requireThat(
          flow.invitation,
          403,
          'invitation_required',
          'Sign in with your existing password to link your account, or ask for a workspace invitation.',
        );
        this.inviteRow(flow.invitation);
        const data = schema.account
          .pick({ name: true, email: true })
          .parse({ name: identity.name, email: identity.email });
        requireThat(
          !this.one('SELECT id FROM users WHERE email=?', data.email),
          409,
          'link_required',
          'This email already has an account. Sign in with its password and connect Microsoft from Account.',
        );
        user = this.insertUser(data, password);
      }
      requireThat(
        user,
        403,
        'account_unavailable',
        'This account is unavailable. Contact your administrator.',
      );
      if (!linked) {
        this.run(
          'INSERT INTO identities VALUES(?,?,?)',
          identity.tenantId,
          identity.objectId,
          user.id,
        );
        this.audit({ user }, 'identity.linked', user.name, {
          tenantId: identity.tenantId,
          userId: user.id,
        });
      }
      if (flow.invitation) this.acceptInvite(user, flow.invitation);
      this.audit({ user }, 'identity.signed_in', user.name);
      return user;
    });
  }
  async recoverAdministrator(input: unknown) {
    const data = schema.credentials
      .extend({ reason: z.string().trim().min(5).max(500) })
      .parse(input);
    const password = await hashPassword(data.password);
    return this.transaction(() => {
      const user = this.one<User>(
        "SELECT id,name,email FROM users WHERE email=? AND org_role='admin' AND disabled_at IS NULL",
        data.email,
      );
      requireThat(
        user,
        404,
        'not_found',
        'Recovery requires an existing active organization administrator.',
      );
      this.run(
        'UPDATE users SET password=?,recovery_until=? WHERE id=?',
        password,
        expiry(1),
        user.id,
      );
      this.run('DELETE FROM sessions WHERE user_id=?', user.id);
      this.run('DELETE FROM tokens WHERE user_id=?', user.id);
      this.run('DELETE FROM identity_flows WHERE user_id=?', user.id);
      this.run(
        "INSERT INTO audit_log(actor_name,action,target,details,created_at) VALUES('Server operator','account.recovered',?,?,?)",
        user.name,
        JSON.stringify({ userId: user.id, reason: data.reason }),
        now(),
      );
      this.run('UPDATE organization SET version=version+1 WHERE id=1');
      return {
        ok: true,
        message:
          'Password reset; existing sessions and agent keys revoked. Password sign-in is allowed for one hour, including when Entra is required.',
      };
    });
  }
  changeDocument(actor: Actor, input: unknown) {
    const data = schema.changeDocument.parse(input);
    return this.transaction(() => {
      const doc = this.documentRow(actor, data.documentId);
      this.access(actor, doc.workspaceId, true);
      this.checkRevision(doc, data.expectedRevisionId);
      requireThat(
        doc.metadataVersion === data.expectedMetadataVersion,
        409,
        'metadata_conflict',
        'This document was renamed or archived elsewhere. Refresh before trying again.',
      );
      const path = data.path ?? doc.path;
      requireThat(
        !this.one(
          'SELECT document_id id FROM document_paths WHERE workspace_id=? AND path=? AND document_id<>?',
          doc.workspaceId,
          path,
          doc.id,
        ),
        409,
        'path_exists',
        'That path belongs to another document, including its previous names. Choose a different path.',
      );
      const archivedAt =
        data.archived === undefined
          ? doc.archivedAt
          : data.archived
            ? (doc.archivedAt ?? now())
            : null;
      if (path !== doc.path)
        this.run(
          'INSERT OR IGNORE INTO document_paths VALUES(?,?,?)',
          doc.workspaceId,
          path,
          doc.id,
        );
      if (path !== doc.path || archivedAt !== doc.archivedAt) {
        this.run(
          'UPDATE documents SET path=?,archived_at=?,metadata_version=metadata_version+1,updated_at=? WHERE id=?',
          path,
          archivedAt,
          now(),
          doc.id,
        );
      }
      return this.document(actor, doc.id);
    });
  }
  resolveLink(actor: Actor, documentId: string, input: unknown) {
    const data = z
      .object({ revisionId: schema.id, href: z.string().min(1).max(2048) })
      .parse(input);
    const doc = this.documentRow(actor, documentId);
    this.revisionRow(doc.id, data.revisionId);
    if (data.href.startsWith('#'))
      return {
        workspaceId: doc.workspaceId,
        documentId: doc.id,
        fragment: data.href.slice(1),
      };
    const binding = this.one<{ path: string }>(
      'SELECT target_path path FROM revision_links WHERE revision_id=? AND href=?',
      data.revisionId,
      data.href,
    );
    const path = binding?.path ?? relativePath(data.href, doc.path);
    requireThat(path, 400, 'invalid_link', 'Use a relative document link.');
    const target = this.one<{ id: string }>(
      'SELECT document_id id FROM document_paths WHERE workspace_id=? AND path=?',
      doc.workspaceId,
      path,
    );
    requireThat(target, 404, 'not_found', 'No document found for this link.');
    this.documentRow(actor, target.id);
    return {
      workspaceId: doc.workspaceId,
      documentId: target.id,
      fragment: new URL(data.href, 'https://workspace.invalid/').hash.slice(1),
    };
  }
  search(actor: Actor, input: unknown): SearchHit[] {
    this.active(actor);
    const data = schema.searchDocuments.parse(input);
    if (data.workspaceId) this.access(actor, data.workspaceId);
    const words = data.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16);
    if (!words?.length) return [];
    const query = words.map((w) => `"${w}"*`).join(' AND ');
    return this.all<SearchHit>(
      `SELECT d.id,d.workspace_id workspaceId,w.name workspaceName,d.path,d.current_revision_id currentRevisionId,d.updated_at updatedAt,d.archived_at archivedAt,d.metadata_version metadataVersion,snippet(document_search,2,'','',' … ',32) snippet
      FROM document_search JOIN documents d ON d.id=document_search.document_id JOIN workspaces w ON w.id=d.workspace_id JOIN effective_members m ON m.workspace_id=d.workspace_id AND m.user_id=?
      WHERE document_search MATCH ? AND (? IS NULL OR d.workspace_id=?) AND (? IS NULL OR d.workspace_id=?) AND (? OR d.archived_at IS NULL)
      ORDER BY bm25(document_search,0,4,1),d.path LIMIT 100`,
      actor.user.id,
      query,
      data.workspaceId ?? null,
      data.workspaceId ?? null,
      actor.token?.workspaceId ?? null,
      actor.token?.workspaceId ?? null,
      Number(data.includeArchived),
    );
  }
  myReviews(actor: Actor) {
    return this.workspaces(actor)
      .flatMap((w) =>
        this.reviewRequests(actor, w.id)
          .filter(
            (r) =>
              r.reviewerId === actor.user.id || r.requesterId === actor.user.id,
          )
          .map((r) => ({ ...r, workspaceName: w.name })),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private notify(
    actor: Actor,
    documentId: string,
    recipients: string[],
    event: {
      kind: WorkspaceNotification['kind'];
      eventKey: string;
      requestId?: string;
      commentId?: string;
      replyId?: string;
      preview: string;
    },
  ) {
    const doc = this.documentRow(actor, documentId);
    for (const userId of new Set(recipients)) {
      if (
        (!actor.token && userId === actor.user.id) ||
        !this.user(userId) ||
        !this.one(
          'SELECT 1 FROM effective_members WHERE workspace_id=? AND user_id=?',
          doc.workspaceId,
          userId,
        )
      )
        continue;
      this.run(
        'INSERT OR IGNORE INTO notifications(user_id,document_id,kind,event_key,request_id,comment_id,reply_id,actor_name,preview,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        userId,
        documentId,
        event.kind,
        event.eventKey,
        event.requestId ?? null,
        event.commentId ?? null,
        event.replyId ?? null,
        actor.token
          ? `${actor.token.name} (for ${actor.user.name})`
          : actor.user.name,
        event.preview.slice(0, 300),
        now(),
      );
    }
  }
  notifications(actor: Actor) {
    this.active(actor);
    requireThat(
      !actor.token,
      403,
      'session_required',
      'Notifications require a browser session.',
    );
    const items = this.all<WorkspaceNotification>(
      `SELECT n.id,n.kind,n.document_id documentId,d.workspace_id workspaceId,w.name workspaceName,d.path,n.request_id requestId,n.comment_id commentId,n.actor_name actorName,n.preview,n.created_at createdAt,n.read_at readAt
      FROM notifications n JOIN documents d ON d.id=n.document_id JOIN workspaces w ON w.id=d.workspace_id JOIN effective_members m ON m.workspace_id=w.id AND m.user_id=n.user_id
      WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100`,
      actor.user.id,
    );
    const count = this.one<{ count: number }>(
      `SELECT count(*) count FROM notifications n JOIN documents d ON d.id=n.document_id JOIN effective_members m ON m.workspace_id=d.workspace_id AND m.user_id=n.user_id WHERE n.user_id=? AND n.read_at IS NULL`,
      actor.user.id,
    )!.count;
    return { items, unreadCount: count };
  }
  readNotifications(actor: Actor, input: unknown) {
    this.notifications(actor);
    const data = z
      .object({
        id: z.number().int().positive().optional(),
        throughId: z.number().int().positive().optional(),
      })
      .refine((d) => !!d.id !== !!d.throughId)
      .parse(input);
    this.run(
      `UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND ${data.id ? 'id=?' : 'id<=?'} AND document_id IN (SELECT d.id FROM documents d JOIN effective_members m ON m.workspace_id=d.workspace_id WHERE m.user_id=?)`,
      now(),
      actor.user.id,
      data.id ?? data.throughId!,
      actor.user.id,
    );
    return this.notifications(actor);
  }
  serviceAccounts(actor: Actor, workspaceId: string): ServiceAccount[] {
    this.owner(actor, workspaceId);
    return this.all<Omit<ServiceAccount, 'tokens'>>(
      `SELECT u.id,u.name,CASE m.role WHEN 'editor' THEN 'write' ELSE 'read' END scope,u.disabled_at disabledAt,c.name createdBy,s.created_at createdAt FROM service_accounts s JOIN users u ON u.id=s.user_id JOIN users c ON c.id=s.created_by JOIN members m ON m.user_id=u.id AND m.workspace_id=s.workspace_id WHERE s.workspace_id=? ORDER BY s.created_at`,
      workspaceId,
    ).map((s) => ({
      ...s,
      tokens: this.all<TokenInfo>(
        "SELECT id,name,scope,created_at createdAt,expires_at expiresAt,last_used_at lastUsedAt,? ownerName,'service' ownerType FROM tokens WHERE user_id=? ORDER BY created_at DESC",
        s.name,
        s.id,
      ),
    }));
  }
  createServiceAccount(actor: Actor, workspaceId: string, input: unknown) {
    this.owner(actor, workspaceId);
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        scope: z.enum(['read', 'write']),
      })
      .parse(input);
    return this.transaction(() => {
      const id = randomUUID();
      this.run(
        "INSERT INTO users(id,name,email,password,org_role) VALUES(?,?,?,'!','member')",
        id,
        data.name,
        `${id}@service.invalid`,
      );
      this.run(
        'INSERT INTO service_accounts VALUES(?,?,?,?)',
        id,
        workspaceId,
        actor.user.id,
        now(),
      );
      this.run(
        'INSERT INTO members VALUES(?,?,?)',
        workspaceId,
        id,
        data.scope === 'write' ? 'editor' : 'viewer',
      );
      this.audit(actor, 'service_account.created', data.name, {
        userId: id,
        workspaceId,
        scope: data.scope,
      });
      return this.serviceAccounts(actor, workspaceId).find((s) => s.id === id)!;
    });
  }
  createServiceToken(
    actor: Actor,
    workspaceId: string,
    accountId: string,
    input: unknown,
  ) {
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        scope: z.enum(['read', 'write']),
      })
      .parse(input);
    return this.transaction(() => {
      const account = this.serviceAccounts(actor, workspaceId).find(
        (s) => s.id === accountId,
      );
      requireThat(
        account && !account.disabledAt,
        404,
        'not_found',
        'Active service account not found.',
      );
      requireThat(
        account.scope === 'write' || data.scope === 'read',
        403,
        'read_only',
        'This service account has read-only access.',
      );
      const token = `pw_${secret()}`,
        id = randomUUID(),
        createdAt = now(),
        expiresAt = expiry(24 * 90);
      this.run(
        'INSERT INTO tokens(id,hash,user_id,workspace_id,name,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        digest(token),
        account.id,
        workspaceId,
        data.name,
        data.scope,
        createdAt,
        expiresAt,
      );
      this.audit(actor, 'credential.created', data.name, {
        tokenId: id,
        workspaceId,
        serviceAccountId: account.id,
        scope: data.scope,
      });
      return {
        id,
        token,
        name: data.name,
        scope: data.scope,
        createdAt,
        expiresAt,
      };
    });
  }
  disableServiceAccount(actor: Actor, workspaceId: string, accountId: string) {
    return this.transaction(() => {
      const account = this.serviceAccounts(actor, workspaceId).find(
        (s) => s.id === accountId,
      );
      requireThat(account, 404, 'not_found', 'Service account not found.');
      if (!account.disabledAt) {
        this.run('UPDATE users SET disabled_at=? WHERE id=?', now(), accountId);
        this.run('DELETE FROM tokens WHERE user_id=?', accountId);
        this.audit(actor, 'service_account.disabled', account.name, {
          userId: accountId,
          workspaceId,
        });
      }
      return this.serviceAccounts(actor, workspaceId);
    });
  }
  revokeServiceToken(
    actor: Actor,
    workspaceId: string,
    accountId: string,
    tokenId: string,
  ) {
    return this.transaction(() => {
      const account = this.serviceAccounts(actor, workspaceId).find(
        (s) => s.id === accountId,
      );
      const token = account?.tokens.find((t) => t.id === tokenId);
      requireThat(token, 404, 'not_found', 'Service account key not found.');
      this.run('DELETE FROM tokens WHERE id=?', token.id);
      this.audit(actor, 'credential.revoked', token.name, {
        tokenId,
        workspaceId,
        serviceAccountId: accountId,
      });
    });
  }
  connectionInfo(actor: Actor): AgentConnection {
    requireThat(
      actor.token,
      403,
      'agent_required',
      'Connect with an agent key.',
    );
    const role = this.access(actor, actor.token.workspaceId);
    const workspace = this.one<{ id: string; name: string }>(
      'SELECT id,name FROM workspaces WHERE id=?',
      actor.token.workspaceId,
    )!;
    const credential = this.one<{ expiresAt: string }>(
      'SELECT expires_at expiresAt FROM tokens WHERE id=?',
      actor.token.id,
    )!;
    return {
      workspace: { ...workspace, role },
      credential: {
        id: actor.token.id,
        name: actor.token.name,
        scope: actor.token.scope,
        expiresAt: credential.expiresAt,
        ownerName: actor.user.name,
        ownerType: this.one(
          'SELECT user_id FROM service_accounts WHERE user_id=?',
          actor.user.id,
        )
          ? 'service'
          : 'person',
      },
    };
  }
  recordAgentUse(actor: Actor) {
    this.connectionInfo(actor);
    this.run(
      'UPDATE tokens SET last_used_at=? WHERE id=?',
      now(),
      actor.token!.id,
    );
  }
  close() {
    this.db.close();
  }
}
