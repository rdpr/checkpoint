// Historical schemas are retained verbatim so existing installations can upgrade.
import type { Store } from './store.ts';
import { artifactLinks, relativePath } from './links.ts';
export function migrateLegacy(store: Store) {
  if (
    store.one<{ user_version: number }>('PRAGMA user_version')!.user_version >=
    12
  )
    return;
  store.db
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
  store.transaction(() => {
    const version = store.one<{ user_version: number }>(
      'PRAGMA user_version',
    )!.user_version;
    if (version < 2) {
      store.db.exec(`
          ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment' CHECK(kind IN ('comment','deletion','label'));
          ALTER TABLE comments ADD COLUMN label_tip TEXT;
          PRAGMA user_version=2;
        `);
    }
    if (version < 3) {
      store.db.exec(
        "ALTER TABLE comments ADD COLUMN images TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=3;",
      );
    }
    if (version < 4) {
      store.db
        .exec(`ALTER TABLE comments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE comments ADD COLUMN updated_at TEXT;
          ALTER TABLE comments ADD COLUMN author_token_id TEXT;
          PRAGMA user_version=4;`);
    }
    if (version < 5) {
      store.db.exec(`ALTER TABLE comments ADD COLUMN diff TEXT;
          CREATE TABLE IF NOT EXISTS comment_reattachments (
            id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
            revision_id TEXT NOT NULL REFERENCES revisions(id), quote TEXT NOT NULL, anchor TEXT NOT NULL,
            author_id TEXT NOT NULL REFERENCES users(id), author_name TEXT NOT NULL, agent_name TEXT, created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS reattachments_comment ON comment_reattachments(comment_id);
          PRAGMA user_version=5;`);
    }
    if (version < 6) {
      store.db.exec(`CREATE TABLE IF NOT EXISTS review_requests (
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
      store.db.exec(`CREATE TABLE comment_submissions (
          submission_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
          author_id TEXT NOT NULL REFERENCES users(id), author_token_id TEXT,
          fingerprint TEXT NOT NULL, comment_id TEXT NOT NULL
        );
        PRAGMA user_version=7;`);
    }
    if (version < 8) {
      store.db.exec(`
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
      store.db.exec(`
          ALTER TABLE users ADD COLUMN recovery_until TEXT;
          ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
          CREATE TABLE identities(tenant_id TEXT NOT NULL, object_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), PRIMARY KEY(tenant_id,object_id));
          CREATE TABLE identity_flows(hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, user_id TEXT REFERENCES users(id), session_hash TEXT, invitation TEXT, expires_at TEXT NOT NULL);
          PRAGMA user_version=9;
        `);
    }
    if (version < 10) {
      store.db.exec(`
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
      store.db.exec(`
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
      for (const row of store.all<{ id: string; body: string; path: string }>(
        'SELECT r.id,r.body,d.path FROM revisions r JOIN documents d ON d.id=r.document_id',
      )) {
        for (const href of artifactLinks(row.body))
          store.run(
            'INSERT INTO revision_links VALUES(?,?,?)',
            row.id,
            href,
            relativePath(href, row.path)!,
          );
      }
      store.db.exec('PRAGMA user_version=11');
    }
  });
}
