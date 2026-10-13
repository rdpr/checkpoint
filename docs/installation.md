# Installation

Use a version from [Releases](https://github.com/rdpr/checkpoint/releases). Download and verify `SHA256SUMS` before unpacking `checkpoint-VERSION-deploy.tar.gz`. Container images are published at `ghcr.io/rdpr/checkpoint`; authenticate with `docker login ghcr.io` if your repository/package access requires it.

Checkpoint requires a single writer, durable local/block storage and an HTTPS origin. It supports Linux/amd64. An HTTPS proxy or ingress terminates TLS; the application is not directly exposed to the internet by the supplied Compose configuration.

## Docker Compose

Requirements: Docker Engine with the Compose plugin, an HTTPS reverse proxy, and local Docker volumes. The example Caddy configuration is in `deploy/compose/Caddyfile.example`.

```sh
cd deploy/compose
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
touch secrets/oidc_client_secret
openssl rand -hex 32 > secrets/metrics_token
chmod 600 .env secrets/*
```

Set `APP_ORIGIN` in `.env` to the exact HTTPS origin, without a trailing slash or path. Set `CHECKPOINT_IMAGE` to the release image, preferably its digest from `release.json`. The app port is bound to host loopback; point the reverse proxy at `127.0.0.1:4310`.

Configure `TRUSTED_PROXIES` with the reverse proxy's actual source IP addresses or CIDR ranges as seen by the application (comma-separated). For Helm, set the equivalent `trustedProxies` list. For a proxy connecting directly to a native loopback listener, this can be `127.0.0.1,::1`; a Docker-published port may instead expose the bridge gateway address. Determine that address for your deployment rather than trusting an entire private network. Trust only proxy addresses whose forwarding behavior you control, restrict direct access to the application, and configure the proxy to replace client-supplied `X-Forwarded-For` with the real client address (or append the verified peer at each hop of a controlled proxy chain). The example Caddy reverse proxy uses its default forwarding behavior. Never configure universal trust or use client-supplied addresses as trusted proxies.

With no trusted proxies configured, forwarded headers are ignored. Behind a proxy this means all users share the peer's authentication allowance, so configure this setting before production use. Authentication routes allow 20 attempts per client per minute and 10 per account/client pair, with a separate installation-wide ceiling of 2,000 accepted attempts per minute. Logout and nonexistent authentication routes do not consume these allowances. Accounts are normalized using trimmed, lowercase email addresses; an attacker on a different client cannot consume another client's account allowance.

The container runs as UID/GID **1000**. Secret files must be readable by that identity. If the host operator has a different UID, arrange ownership or an ACL for UID 1000; do not make secret files world-readable. Compose file secrets are bind mounts, so secret `uid`/`mode` declarations do not fix host ownership.

```sh
docker compose pull
docker compose up -d app
```

Bootstrap the organization administrator before starting the backup sidecar. Create `bootstrap.private.json` with permissions `600` and these fields, choosing a unique strong password:

```json
{"name":"Administrator","email":"admin@example.com","password":"replace-with-a-unique-strong-password"}
```

```sh
docker compose exec -T app node --import tsx server/operator.ts bootstrap < bootstrap.private.json
rm bootstrap.private.json
docker compose up -d backup
```

The service is live but not ready until bootstrap succeeds. Open `APP_ORIGIN`, sign in, name the organization and invite colleagues. Bootstrap is refused after the first account exists. Keep `.env`, secret files and bootstrap input outside version control.

## Kubernetes

Requirements: Helm 3, Linux/amd64 nodes, a CSI block-storage driver supporting `ReadWriteOncePod`, and an HTTPS ingress controller with a TLS certificate. There must be exactly one application writer. Do not use NFS, RWX, multiple replicas or an HPA. `ReadWriteOnce` is a fallback only when RWOP is unavailable; the application also holds a writer lock. Do not force-delete a pod while its old node may still write to the volume.

Download `checkpoint-VERSION.tgz` from the release. Create a private values file:

```yaml
origin: https://checkpoint.example.com
image:
  repository: ghcr.io/rdpr/checkpoint
  tag: '0.4.0'
  digest: '' # Prefer the sha256:... digest from release.json.
storage:
  className: YOUR_BLOCK_STORAGE_CLASS
  accessMode: ReadWriteOncePod
  dataSize: 10Gi
  backupSize: 20Gi
ingress:
  enabled: true
  className: YOUR_INGRESS_CLASS
  host: checkpoint.example.com
  tlsSecretName: checkpoint-tls
metrics:
  secretName: checkpoint-metrics
```

Create a namespace and metrics secret. The secret file must contain at least 32 characters. For private GHCR packages, create an image-pull Secret in the installation namespace and set `imagePullSecrets: [{name: ghcr}]` in your values. Use a credential with package-read access. Apply the same `imagePullSecrets` setting to any maintenance or restore pod. Do not put registry tokens in the values file.

```sh
kubectl create namespace checkpoint
kubectl -n checkpoint create secret generic checkpoint-metrics --from-file=token=/private/metrics-token
helm install checkpoint ./checkpoint-0.4.0.tgz -n checkpoint -f installation.private.yaml
kubectl -n checkpoint wait --for=create pod/checkpoint-0 --timeout=180s
kubectl -n checkpoint wait --for=jsonpath='{.status.phase}'=Running pod/checkpoint-0 --timeout=180s
kubectl -n checkpoint exec -i checkpoint-0 -c app -- node --import tsx server/operator.ts bootstrap < bootstrap.private.json
kubectl -n checkpoint rollout status statefulset/checkpoint --timeout=120s
```

Remove the bootstrap input after success. Do not use Helm `--wait` before bootstrap on a new installation: readiness deliberately requires an initialized administrator. Data and backup PVCs are retained. Test deployment and restore with your actual CSI driver and ingress before onboarding users.

## Install in your browser

After the server is running, open its HTTPS address to install Checkpoint as a web app. Localhost also works for development. No additional server configuration is needed: the app includes a manifest, standalone display mode, and desktop and mobile icons.

- **Chrome and Edge:** when the browser offers installation, Checkpoint shows an **Install Checkpoint** suggestion. You can also use the browser’s install icon or app installation menu. Dismissing the suggestion hides it for 30 days; **Account & appearance** still offers installation when available.
- **iPhone and iPad:** use **Share → Add to Home Screen**.
- **Safari on Mac:** use **File → Add to Dock**.

Browser support and prompt timing vary. Checkpoint cannot force the browser’s native prompt to appear immediately. The account screen includes manual installation guidance when a native prompt is unavailable. See [MDN’s installation guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) for browser requirements.

Installed Checkpoint uses the same server, sign-in, and workspace permissions. It requires a network connection to load and save reviews. Installation does not add offline artifact caching or background synchronization; unsaved drafts retain the existing browser-local recovery behavior.

## OpenID Connect sign-in

Register a confidential OIDC application at your identity provider with redirect URI `https://YOUR-ORIGIN/api/auth/oidc/callback` (including any non-default port). The provider must support discovery, authorization code flow with PKCE S256, signed ID tokens, and `client_secret_post` token-endpoint authentication. Checkpoint sends the client ID and secret in the HTTPS token request body.

| Setting | Meaning |
| --- | --- |
| `OIDC_ISSUER` | Exact HTTPS issuer URL, including any path or trailing slash required by the provider. Endpoints and signing keys come from discovery. |
| `OIDC_CLIENT_ID` | Application client ID; does not need to be a UUID. |
| `OIDC_CLIENT_SECRET_FILE` | File containing the client secret; alternatively use `OIDC_CLIENT_SECRET`, never both. |
| `OIDC_SCOPES` | Space-separated scopes; defaults to `openid profile email` and must include `openid`. |
| `OIDC_PROMPT` | Optional authorization `prompt`, such as `login` or `select_account`. Unset or empty omits the parameter. |
| `OIDC_LOGOUT_REDIRECT` | Defaults to `false`. Set `true` to redirect to the discovered `end_session_endpoint` after local sign-out. Register `https://YOUR-ORIGIN/` as a post-logout redirect URI at the provider. |
| `AUTH_MODE` | `optional` allows passwords and OIDC; `oidc` requires single sign-on. |

In Compose, fill `.env` and the mounted `secrets/oidc_client_secret` file (`OIDC_SECRET_FILE` selects a different host file). In Helm, create a Secret with key `client-secret`, set `oidc.secretName`, `oidc.issuer` and `oidc.clientId`, and use `authMode: optional` initially. Optional Helm values are `oidc.scopes`, `oidc.prompt`, and `oidc.logoutRedirect`.

Existing administrators must sign in with their password, open **your name → Account & appearance**, and connect single sign-on before enforcement. New users need a valid workspace invitation and `name` and `email` claims (or `preferred_username` containing an email address). Existing linked users are identified solely by the verified issuer and `sub`; display names, emails, tenant IDs and object IDs do not define a new OIDC identity. Email equality never links accounts automatically. OIDC authenticates identity; it does not grant workspace membership or administrator roles.

SSO sessions last eight hours. Enforcement immediately invalidates ordinary password sessions; agent keys remain independent. Directory synchronization is not implemented: offboard people in Checkpoint to revoke existing application sessions and keys immediately. Rotate client secrets before expiry and restart after changing configuration.

Provider sign-out is opt-in. When enabled, Checkpoint retains the signed ID token with the local session for use as `id_token_hint`, and supplies `client_id` and the registered post-logout redirect URI using [RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html). Local session revocation happens first and succeeds even if discovery or provider logout fails. Password sessions and sessions created before this option was enabled sign out locally. Provider logout does not revoke other Checkpoint browser sessions.

### Migrating existing Entra installations

For Microsoft Entra, use issuer `https://login.microsoftonline.com/TENANT-UUID/v2.0` with the existing application's client ID and secret. Add the new `/api/auth/oidc/callback` redirect URI to the application registration before switching configuration. Set `OIDC_PROMPT=select_account` to preserve the previous account picker, or leave it empty. No Microsoft Graph application permissions are needed.

Legacy `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, and `ENTRA_CLIENT_SECRET`/`_FILE` remain accepted together, using the old `/api/auth/entra/callback` and account picker. `AUTH_MODE=entra` remains an alias for enforced SSO. Do not mix legacy and OIDC environment settings. Updated Compose and Helm templates use only OIDC settings: migrate their values and secret mounts when upgrading, including `authMode: oidc` for Helm enforcement.

Schema 13 preserves historical Entra identity rows and existing sessions, adds issuer/subject links alongside them, and expires pending sign-in flows. On the next verified sign-in from the exact Microsoft tenant issuer, signed `tid` and `oid` claims can locate the historical account and atomically add its issuer/`sub` link with an audit record. Another issuer cannot use those claims to claim an Entra account. Conflicting mappings and a changed subject after migration fail without replacing the old link. Keep the same Entra application client ID during this transition; changing it can change pairwise subjects.

When switching to a different provider, use `AUTH_MODE=optional` temporarily and explicitly connect each existing account using its password. The Account screen reports linkage to the currently configured issuer, so old links do not hide the connection form. One identity per issuer is allowed for each account, with historical links retained. Accounts created through SSO do not have a known password; if those must move to another provider, arrange a separate migration procedure before enforcement. Operator recovery can restore access for existing active administrators. Back up before upgrading; reverting to a release with schema 12 requires restoring its pre-upgrade backup.

## Emergency administrator recovery

An operator with access to the deployment can reset an existing active administrator's password using a protected JSON file containing `email`, `password` and a non-empty `reason`:

```sh
docker compose exec -T app node --import tsx server/operator.ts recover-admin < recovery.private.json
```

For Kubernetes use `kubectl exec -i checkpoint-0 -c app -- ...` in the installation namespace. Recovery revokes that administrator's sessions and agent keys, records an audit event, and permits password sign-in for one hour even when single sign-on is enforced. It does not promote users or reactivate offboarded accounts. Remove the input file afterward.
