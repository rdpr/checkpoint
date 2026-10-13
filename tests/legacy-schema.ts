import type { DatabaseSync } from 'node:sqlite';
// Build the historical on-disk layout for upgrade/restore integration checks.
// This deliberately uses real SQLite DDL; no store or authorization mocks.
export function legacyNames(db: DatabaseSync) {
  db.exec(`
    DROP TRIGGER artifact_catalog_insert; DROP TRIGGER artifact_catalog_update;
    DROP TRIGGER folder_catalog_insert; DROP TRIGGER folder_catalog_update; DROP TRIGGER folder_catalog_delete;
    ALTER TABLE artifacts DROP COLUMN folder_id; DROP TABLE folders;
    ALTER TABLE workspaces DROP COLUMN catalog_version;
    DROP TRIGGER artifact_search_update; DROP TRIGGER artifact_search_delete; DROP TABLE artifact_search;
    ALTER TABLE artifacts RENAME TO documents;
    ALTER TABLE artifact_paths RENAME TO document_paths;
  `);
  for (const table of [
    'document_paths',
    'revisions',
    'comments',
    'images',
    'reviews',
    'review_requests',
    'notifications',
    'comment_submissions',
  ])
    db.exec(`ALTER TABLE ${table} RENAME COLUMN artifact_id TO document_id`);
  db.exec(`
    CREATE VIRTUAL TABLE document_search USING fts5(document_id UNINDEXED,path,body,tokenize='unicode61');
    INSERT INTO document_search SELECT d.id,d.path,r.body FROM documents d JOIN revisions r ON r.id=d.current_revision_id;
    CREATE TRIGGER document_search_update AFTER UPDATE OF current_revision_id,path ON documents BEGIN
      DELETE FROM document_search WHERE document_id=old.id;
      INSERT INTO document_search SELECT new.id,new.path,body FROM revisions WHERE id=new.current_revision_id;
    END;
    CREATE TRIGGER document_search_delete AFTER DELETE ON documents BEGIN DELETE FROM document_search WHERE document_id=old.id; END;
    PRAGMA user_version=11;
  `);
}
