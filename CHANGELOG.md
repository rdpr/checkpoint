# Changelog

## 0.1.0

First Checkpoint release for self-hosted team pilots.

- Shared Markdown workspaces with scoped membership, teams, invitations and an administrative audit log.
- Passage and element annotations, image attachments, discussion threads, custom labels and feedback export.
- Revision history, rendered and source comparisons, human approval and change requests tied to the reviewed revision.
- Review assignments, cross-workspace My reviews and in-app notifications for requests, replies and decisions.
- Search, rename, move, archive, stable document links and browser-local draft recovery.
- Workspace-scoped MCP credentials, connection configuration and workspace service accounts.
- Optional Microsoft Entra ID sign-in, operator recovery, health endpoints and Prometheus metrics.
- Versioned Linux/amd64 container, Docker Compose deployment and Helm chart, with automatic local backups, restore verification and guarded database upgrades.

### Operating limits

One organization and one application writer per installation. No simultaneous editing, Git synchronization, email notifications or automatic production upgrades. Browser drafts are local to the device. Configure HTTPS, identity, off-host backup copies and alert delivery for your environment before wider rollout.

Database schema: **11**. Existing schema 10 databases migrate on startup after a rescue backup and verification on a copy. A newer database cannot be opened by an older release; rollback across a migration requires restoring the matching pre-upgrade backup while the application is stopped.
