# Changelog

## 0.3.0 — 2026-10-13

### Artifact review

- Review self-contained HTML previews and standalone Mermaid or Graphviz diagrams through the UI and MCP, using Plannotator's existing viewers and annotation components.
- Comment on HTML text and pinpoint elements, including multiple targets in one discussion. Switch between annotation and interaction to try preview controls. Markup opens the native selection toolbar for Comment, Copy, and Looks good; HTML does not offer redlines or other quick labels.
- Import original UTF-8 files, edit their source, compare revisions, and follow revision-bound links between artifacts. Existing text/config imports remain reviewable as source code; the creation menu highlights formats with rendered previews.
- Preserve validated HTML element anchors in saved discussions and feedback exports. Keep artifact rendering consistent across renames and history.
- Improve dark-mode text-selection contrast in the review viewer, and keep HTML review controls usable on narrow screens.

### Identity and onboarding

- New Checkpoint identity throughout the app and README, with light/dark SVGs, transparent PNGs, favicons, and installation icons.
- Browser installation with a standalone app window, a dismissible install suggestion where supported, and platform guidance in Account settings.
- Engineering-focused onboarding and documentation, with a reproducible architecture review demo showing diagrams, decisions, and agent feedback.

### Upgrading

Database schema remains **12**. No migration is required from 0.2.0. Take and verify a backup before upgrading, then reload open browser tabs and refresh MCP tool discovery. HTML previews run scripts in an isolated iframe; use self-contained files because importing HTML does not upload its asset directory. Older releases do not provide the new artifact viewers.

Upgrades from 0.1.0 still require the schema 11-to-12 migration described in the [operations guide](docs/operations.md#upgrading-from-010-to-020). Publication does not automatically upgrade installations.

## 0.2.0 — 2026-10-12

### Review and navigation

- Precision design with light, dark and system appearance, consistent keyboard-accessible controls, and responsive navigation and review drawers.
- A focused artifact header, revision comparisons and activity view, with discussions and review completion alongside the content. Plannotator's editor and diff components are retained.
- Compact review queues, notifications, saved drafts, member lists and audit tables, with consistent empty states and full-row sidebar highlights.
- Account, appearance and administration links are available from the user menu; sign-out remains a separate button.

### Artifacts and folders

- Consistent artifact terminology across the UI, API, MCP, and application code.
- Persistent folders with nested navigation, stable links, create/rename/move controls, and empty-folder deletion. Folder moves check all affected artifact revisions and preserve existing links.
- Compact sidebar search and creation actions, folder pickers for organizing artifacts, and folder management through HTTP and MCP.

### Upgrading from 0.1.0

Database schema: **12** (previously **11**). Existing path prefixes become persistent folders, including paths containing archived artifacts. The upgrade preserves artifact IDs, revision history, discussions, approvals and path aliases. Take and verify a backup before upgrading. Rolling back to 0.1.0 requires restoring its pre-upgrade backup, which discards subsequent writes; a code-only downgrade is refused. See [operations](docs/operations.md#upgrading-from-010-to-020).

Reload existing browser tabs after deployment. Saved browser drafts and old `document=` links remain supported. REST document routes and renamed MCP tool aliases remain available for compatibility; new integrations should use artifact names and `artifactId`. Refresh MCP tool discovery, particularly for shared tools whose current input schema now uses `artifactId`. See the [agent guide](docs/mcp.md#artifacts-and-folders).

## 0.1.0

First Checkpoint release for self-hosted team pilots.

- Shared Markdown workspaces with scoped membership, teams, invitations and an administrative audit log.
- Passage and element annotations, image attachments, discussion threads, custom labels and feedback export.
- Revision history, rendered and source comparisons, human approval and change requests tied to the reviewed revision.
- Review assignments, cross-workspace My reviews and in-app notifications for requests, replies and decisions.
- Search, rename, move, archive, stable artifact links and browser-local draft recovery.
- Workspace-scoped MCP credentials, connection configuration and workspace service accounts.
- Optional Microsoft Entra ID sign-in, operator recovery, health endpoints and Prometheus metrics.
- Versioned Linux/amd64 container, Docker Compose deployment and Helm chart, with automatic local backups, restore verification and guarded database upgrades.

### Operating limits

One organization and one application writer per installation. No simultaneous editing, Git synchronization, email notifications or automatic production upgrades. Browser drafts are local to the device. Configure HTTPS, identity, off-host backup copies and alert delivery for your environment before wider rollout.

Database schema: **11**. Existing schema 10 databases migrate on startup after a rescue backup and verification on a copy. A newer database cannot be opened by an older release; rollback across a migration requires restoring the matching pre-upgrade backup while the application is stopped.
