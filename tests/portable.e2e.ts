import { legacyNames } from './legacy-schema.ts';
// Exercise the exact container entrypoint with real processes, HTTP, and disposable SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { Store } from '../server/store.ts';
const exec = promisify(execFile);
test(
  'portable hosting bootstraps, locks writers, backs up, drills, and restores real application state',
  { timeout: 90000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pw-portable-'));
    const probe = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((r) => probe.once('listening', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DATA_DIR: directory,
      BACKUP_DIR: join(directory, 'backups'),
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: base,
      AUTH_MODE: 'optional',
    };
    for (const key of Object.keys(env))
      if (
        key.startsWith('ENTRA_') ||
        key.startsWith('OIDC_') ||
        key.startsWith('METRICS_TOKEN')
      )
        delete (env as Record<string, unknown>)[key];
    const cli = (...args: string[]) =>
      exec('python3', ['ops/container.py', ...args], { env });
    let child: ChildProcess | undefined;
    let logs = '';
    const start = () => {
      child = spawn('python3', ['ops/container.py', 'serve'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (b) => (logs += b));
      child.stderr!.on('data', (b) => (logs += b));
    };
    const stop = async () => {
      if (child && child.exitCode === null) {
        const stopped = new Promise<void>((r) =>
          child!.once('exit', () => r()),
        );
        child.kill('SIGTERM');
        await stopped;
      }
      child = undefined;
    };
    const ready = async (path: string, status: number) => {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + path)).status === status) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(logs);
    };
    try {
      start();
      await ready('/livez', 200);
      await ready('/readyz', 503);
      const input = {
        name: 'Operator',
        email: 'operator@example.test',
        password: 'operator-password-1234',
      };
      const setup = spawn(
        process.execPath,
        ['--import', 'tsx', 'server/operator.ts', 'bootstrap'],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let failure = '';
      setup.stderr.on('data', (b) => (failure += b));
      setup.stdin.end(JSON.stringify(input));
      assert.equal(await new Promise((r) => setup.once('exit', r)), 0, failure);
      await ready('/readyz', 200);
      const store = new Store(join(directory, 'workspaces.sqlite'));
      const actor = { user: await store.login(input) };
      const doc = store.createArtifact(actor, {
        workspaceId: store.workspaces(actor)[0].id,
        path: 'preserved.md',
        body: '# Before backup',
      });
      store.close();
      await assert.rejects(cli('serve'), /writer is running/);
      await cli('backup');
      const backup = join(
        directory,
        'backups',
        readdirSync(join(directory, 'backups')).find((s) =>
          s.startsWith('manual-'),
        )!,
      );
      await cli('verify-backup', backup);
      await assert.rejects(
        cli('restore', backup, '--confirm-restore'),
        /writer is running/,
      );
      const edited = new Store(join(directory, 'workspaces.sqlite'));
      edited.updateArtifact(actor, {
        artifactId: doc.id,
        body: '# After backup',
        expectedRevisionId: doc.currentRevisionId,
      });
      edited.close();
      await stop();
      await cli('restore', backup, '--confirm-restore');
      start();
      await ready('/readyz', 200);
      const restored = new Store(join(directory, 'workspaces.sqlite'));
      assert.equal(
        restored.artifact(actor, doc.id).revision.body,
        '# Before backup',
      );
      restored.close();
      const status = JSON.parse(
        readFileSync(join(directory, 'operations.json'), 'utf8'),
      );
      assert.ok(status.backup_last_success > 0);
      assert.ok(status.restore_drill_last_success > 0);
      assert.ok(
        readdirSync(join(directory, 'backups')).some((s) =>
          s.startsWith('before-restore-'),
        ),
      );
    } finally {
      await stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'container startup upgrades a legacy database with a rescue backup and rejects a newer schema',
  { timeout: 90000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'checkpoint-upgrade-'));
    const database = join(directory, 'workspaces.sqlite');
    const store = new Store(database);
    const user = await store.setup({
      name: 'Upgrade owner',
      email: 'upgrade@example.test',
      password: 'upgrade-test-password',
    });
    const actor = { user };
    const doc = store.createArtifact(actor, {
      workspaceId: store.workspaces(actor)[0].id,
      path: 'upgrade.md',
      body: '# Preserve this review',
    });
    store.review(actor, {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      decision: 'approved',
      note: 'Keep the approval history.',
    });
    legacyNames(store.db);
    // Schema 10 predates persistent link bindings and review-outcome notifications.
    store.db.exec(`DROP TABLE revision_links; DROP TABLE document_paths;
    ALTER TABLE notifications RENAME TO notifications_new;
    DROP INDEX notifications_recipient;
    CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), document_id TEXT NOT NULL REFERENCES documents(id), kind TEXT NOT NULL CHECK(kind IN ('review_requested','reply')), event_key TEXT NOT NULL, request_id TEXT REFERENCES review_requests(id) ON DELETE CASCADE, comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE, reply_id TEXT REFERENCES replies(id) ON DELETE CASCADE, actor_name TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_key));
    INSERT INTO notifications SELECT * FROM notifications_new; DROP TABLE notifications_new;
    CREATE INDEX notifications_recipient ON notifications(user_id,id DESC); PRAGMA user_version=10;`);
    store.close();
    const probe = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((r) => probe.once('listening', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const env = {
      ...process.env,
      DATA_DIR: directory,
      BACKUP_DIR: join(directory, 'backups'),
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      AUTH_MODE: 'optional',
    };
    for (const key of Object.keys(env))
      if (
        key.startsWith('ENTRA_') ||
        key.startsWith('OIDC_') ||
        key.startsWith('METRICS_TOKEN')
      )
        delete (env as Record<string, unknown>)[key];
    let child: ChildProcess | undefined;
    try {
      child = spawn('python3', ['ops/container.py', 'serve'], {
        env,
        stdio: 'pipe',
      });
      let logs = '';
      child.stdout!.on('data', (b) => (logs += b));
      child.stderr!.on('data', (b) => (logs += b));
      let ready = false;
      for (let i = 0; i < 200; i++) {
        try {
          ready = (await fetch(`${env.APP_ORIGIN}/readyz`)).ok;
          if (ready) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready, logs);
      const stopped = new Promise<void>((r) => child!.once('exit', () => r()));
      child.kill('SIGTERM');
      await stopped;
      child = undefined;
      const upgraded = new Store(database);
      assert.equal(
        upgraded.artifact(actor, doc.id).revision.body,
        doc.revision.body,
      );
      assert.equal(
        upgraded.artifact(actor, doc.id).reviews[0].note,
        'Keep the approval history.',
      );
      assert.ok(
        readdirSync(join(directory, 'backups')).some((n) =>
          n.startsWith('before-upgrade-'),
        ),
      );
      upgraded.db.exec('PRAGMA user_version=999');
      upgraded.close();
      await assert.rejects(
        exec('python3', ['ops/container.py', 'serve'], { env }),
        /Database is newer/,
      );
    } finally {
      if (child) {
        child.kill('SIGTERM');
        await new Promise((r) => child!.once('exit', r));
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
