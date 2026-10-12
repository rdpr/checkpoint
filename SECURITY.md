# Security

Checkpoint is intended for authenticated, private team deployments behind HTTPS. Workspace authorization applies to browser and agent access; organization administrators do not automatically gain artifact access.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/rdpr/checkpoint/security/advisories/new) when it is available. If that form is unavailable, open an issue requesting a private reporting channel **without including vulnerability details, credentials or customer data**. A maintainer must establish a private channel before you send the report.

Include the affected release, deployment type, expected behavior and a minimal reproduction using disposable data. Do not attach production databases or tokens. There is no guaranteed response-time or long-term support commitment at this stage.

## Supported releases

Security fixes target the newest published release. Review release notes before upgrading; older release lines are not maintained separately.

## Operator responsibilities

- Expose the application through HTTPS and restrict access to the intended company network or users.
- Configure Entra and invitations for your organization; protect operator access and recovery procedures.
- Treat agent keys, session cookies, backups and monitoring credentials as secrets. Revoke keys when their purpose ends.
- Keep encrypted off-host backup copies and perform restore drills. Local scheduled backups alone do not protect against loss of the host or disk.
- Review deployment and dependency updates regularly. Pin production images to a published digest.

Checkpoint supports a single application writer with SQLite on local or single-writer block storage. It does not support active-active replicas or SQLite on network file shares. See [operations](docs/operations.md).
