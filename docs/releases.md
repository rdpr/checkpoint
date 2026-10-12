# Release engineering

Checkpoint publishes deliberate, versioned releases. CI does not hold deployment credentials or upgrade installations.

## Version policy

The application version in `package.json` is the source of truth. Keep the lockfile, Helm chart `version` and `appVersion`, image defaults in deployment examples, and changelog aligned. Tags use `vMAJOR.MINOR.PATCH`. Before 1.0, minor releases may introduce documented compatibility changes; patch releases are fixes. Database schema versions are separate, monotonically increasing integers.

Release tags must point to a commit on `main` whose application version matches the tag. Do not move a published tag or overwrite a released image. Fix a release with a new version. Protect `main` and release tags in GitHub repository rules where the repository's plan supports it; workflow validation is not a substitute for repository access controls.

## Checks

Pull requests and pushes to `main` run:

- Release inventory validation, production dependency audit, type checking and real SQLite/HTTP/MCP integration tests.
- Browser journeys for review, collaboration, administration, identity, navigation and draft recovery.
- Portable startup, backup, verified restore and schema upgrade checks.
- Docker Compose installation, backup/restore and Prometheus/Grafana checks.
- Helm installation, restart and restore in an isolated kind cluster.

The release workflow reruns verification for the tag, then publishes the exact container tested by Compose and Kubernetes. It does not rebuild the image after those checks. Third-party Actions are pinned to commits; the runtime base image is pinned to a digest. Dependency updates arrive through Dependabot, except the deliberately pinned Plannotator integration, which requires manual compatibility review.

For a schema change, add meaningful migration coverage using retained data from the previous supported schema. The first release covers the existing schema 10 to 11 transition. Future release upgrades should also be rehearsed with the previous published image and a representative disposable backup.

## Prepare a release

1. Update version metadata and user-facing changelog. Document configuration or schema changes and rollback requirements.
2. Merge the reviewed source into `main` and wait for all verification jobs to pass.
3. Tag the chosen commit, for example `git tag -a v0.1.0 -m 'Checkpoint 0.1.0'`, then push that tag.
4. Wait for the Release workflow and inspect the published assets and image digest.
5. Upgrade installations separately using the [operations guide](operations.md).

The repository and package visibility are administrative choices. Publishing a release does not make a private repository or its GHCR package public. Private image pulls need credentials with package-read access.

## Published artifacts

| Artifact | Purpose |
| --- | --- |
| `ghcr.io/rdpr/checkpoint:VERSION` | Linux/amd64 application image; prefer its immutable digest in production |
| `checkpoint-VERSION-source.tar.gz` | Committed source only |
| `checkpoint-VERSION-deploy.tar.gz` | Compose and Kubernetes manifests with installation and operations guides |
| `checkpoint-VERSION.tgz` | Packaged Helm chart |
| `release.json` | Version, source commit, database schema, platform, workflow and image digest |
| `checkpoint-sbom.cdx.json` | Runtime dependency inventory in CycloneDX format |
| `checkpoint-licenses.txt` | Included dependency license texts and notices |
| `SHA256SUMS` | Checksums of the release files |

The container includes browser dependency notices at `/THIRD_PARTY_LICENSES.txt`. Checksums detect corruption; they are not a signed identity attestation. Obtain releases through the trusted repository and verify the source commit and workflow before installation.

`npm run release:check` validates version alignment and the tracked publication inventory. `npm run release:package` requires committed, clean source and writes archives to `release/`. Both archives use Git's tracked source, so operator files elsewhere in the checkout cannot leak into a release.
