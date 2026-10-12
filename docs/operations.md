# Operations

Checkpoint uses one SQLite database, including image attachments. Keep one application writer and use the supplied backup/restore commands. Never replace SQLite or WAL files under a running application.

## Health and monitoring

- `/livez`: process liveness, including before bootstrap.
- `/readyz`: application/database readiness; uninitialized installations are not ready.
- `/api/health`: health, release identity, product version, source commit and maintenance status.
- `/metrics`: Prometheus metrics protected by the configured bearer token.

The optional Compose monitoring overlay provides Grafana, Prometheus, a dashboard and alert rules. Create a protected Grafana password file readable by container UID 472, set `GRAFANA_PASSWORD_FILE`, then run:

```sh
docker compose -f compose.yaml -f monitoring.yaml up -d
```

Grafana is bound to host loopback on port 3000. Use an SSH tunnel or your private HTTPS proxy; Prometheus has no published port. For existing monitoring, import `deploy/monitoring/dashboard.json` and configure an authenticated scrape. Helm supports `metrics.serviceMonitor: true` when Prometheus Operator CRDs are installed; configure `metrics.monitorLabels` for your selector.

Rules cover reachability, database failures, server errors, low data disk, failed/stale backups and overdue restore drills. **Rules evaluate conditions but do not deliver messages by themselves.** Connect Alertmanager or your Grafana notification destination and verify a test alert reaches an operator. Monitor both data and backup volume capacity.

## Backup and verify

Compose's backup sidecar runs immediately and every 24 hours, retaining 14 scheduled backups by default. Manual, pre-upgrade and pre-restore backups remain until deliberately pruned.

```sh
docker compose exec app python3 ops/container.py backup
docker compose exec app ls /backups
docker compose exec app python3 ops/container.py verify-backup /backups/manual-TIMESTAMP.sqlite
```

A restore drill starts the actual application against a temporary database copy and checks integrity, HTTP health and frontend assets. It never replaces live data. Keep space on the data volume for another database copy and migration growth.

Backups contain artifacts, attachments, discussions, reviews, account information and hashed credentials. Store them with restricted access. Local volumes and Kubernetes PVCs are not off-host protection: copy verified backups to your chosen independent destination and test restoration on another machine. Browser-local drafts are not included.

## Explicit upgrades

Release publication never upgrades an installation. Read the release notes and `release.json`, note the old image digest, take a backup and verify it before changing versions.

For Compose, stop the backup sidecar, select the new `CHECKPOINT_IMAGE` in `.env`, pull it, and recreate the application:

```sh
docker compose stop backup
docker compose pull
docker compose up -d --no-build app
# Check readiness and logs before restarting scheduled backups.
docker compose up -d backup
```

The launcher checks schema compatibility before starting the application. Before migrating an older schema, it saves a rescue backup and boots the candidate on a disposable clone. A database newer than the image is refused. A failed portable upgrade requires operator intervention; there is no automatic rollback that could silently discard new writes.

For Kubernetes, take and verify a backup through the app container, update the image/chart in private values, and run `helm upgrade`. Do not run multiple application replicas during the transition. Watch rollout and readiness before resuming normal use.

### Upgrading from 0.1.0 to 0.2.0

Version 0.2.0 migrates schema 11 to 12. Existing artifact paths populate persistent folders, including archived contents. Artifact IDs, revision history, discussions, reviews, memberships and existing links are retained. The migration also renames the internal document tables and rebuilds the artifact search index.

1. Take a backup with 0.1.0 and verify it with that release. Retain the backup and the old image digest together.
2. Follow the explicit upgrade procedure above. The candidate verifies migration on a private database copy before opening the live database.
3. Check `/readyz` and `/api/health` (version `0.2.0`, maintenance disabled), then verify sign-in, an existing artifact, its history, folder navigation and search. Check the backup job after upgrading and verify a new backup with 0.2.0.
4. Reload browser tabs to load the new UI. Refresh MCP clients' tool discovery; see [API and MCP compatibility](mcp.md#artifacts-and-folders). Browser-local drafts are retained but still depend on the same browser profile and origin.

A 0.1.0 image cannot open schema 12. To roll back, stop writers and restore the retained schema 11 backup with its matching image using the procedure below. This also rolls back any changes made since the backup; preserve newer work first. Never modify schema numbers or tables manually to bypass the check.

## Rollback and restore

A code rollback is safe only when the older image supports the current database schema. Otherwise restore the backup associated with that older release. **Restoring discards writes after the backup.** Preserve newer work before choosing this operation.

Compose:

```sh
docker compose stop app backup
# Select the compatible old image in .env, then pull it.
docker compose pull
docker compose run --rm --no-deps app restore /backups/manual-TIMESTAMP.sqlite --confirm-restore
docker compose up -d --no-build app backup
```

Restore checks the backup with the selected image and makes a rescue copy of current data before replacement. It refuses to proceed while another writer holds the data lock. Never use `docker compose down --volumes` to perform an upgrade or restore.

For Kubernetes, scale the StatefulSet to zero, wait for its pod and volume attachment to terminate, then adapt `deploy/kubernetes/restore-pod.example.yaml` with your release name, PVCs and compatible image. Run the same restore command in that maintenance pod. Delete it and wait for detachment before scaling the application back to one. The example uses release name `checkpoint`; replace corresponding names if you chose another release name. Never run the maintenance pod alongside an application writer.

## Access and incident handling

Organization administrators can inspect and revoke personal/service credentials and offboard accounts. Offboarding revokes sessions, keys, memberships and issued invitations atomically. Transfer sole workspace ownership to a successor first. Entra directory changes do not automatically perform this operation.

The administrative audit log is stored transactionally with changes, but is not tamper-resistant against an operator controlling the database. Keep backups and use restricted operator access. Report security defects privately using [SECURITY.md](../SECURITY.md).
