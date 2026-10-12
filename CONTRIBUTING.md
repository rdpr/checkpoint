# Contributing

Discuss substantial behavior or architecture changes in an issue before implementation. Keep pull requests focused, describe the user-visible change, and include the checks you ran.

## Development

Use Node.js 22.22.1, npm and Python 3. Run `npm ci` and `npm run dev`; the UI is at http://localhost:5173. Use disposable development data. Never run a development process against a production database.

The React UI lives in `src`, shared types in `shared`, and HTTP/MCP services in `server`. Authorization and revision checks belong in `server/store.ts`, where both transports use the same operations. Keep the pinned Plannotator packages and their supported extension points; changes to their versions need a review of the editor adapter, annotations and diff behavior.

## Validation

```sh
npm run check
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:browser
npm run test:portable
```

Prefer integration and browser tests that exercise meaningful user behavior. Use real temporary SQLite databases, real HTTP/MCP boundaries and separate browser sessions for collaboration. Avoid mock-heavy scaffolding, tests of trivial helpers and assertions that merely repeat the implementation.

Browser tests use port 4411 and disposable data. The initial workspace journey creates the shared fixture accounts; dependent feature journeys then run serially. Container tests use isolated Compose projects and volumes. Kubernetes tests create and remove a uniquely named kind cluster with its own kubeconfig:

```sh
npm run test:containers
npm run test:kubernetes
```

These require Docker with Compose; Kubernetes tests also require kind, kubectl and Helm 3. They must never target a real installation. CI runs all of these checks before publishing a release.

## Compatibility and dependencies

Keep the lockfile committed. Test migrations through the real application entrypoint, including backup creation, preservation of user data and refusal to open unsupported newer schemas. Preserve drafts when optimistic concurrency checks fail; never silently retry a write against a newer revision.

For UI changes, check light and dark themes, narrow screens, populated and empty states, and keyboard navigation. Keep the shared design tokens and controls consistent; preserve Plannotator's editor and diff components.

Update operator documentation when changing configuration or deployment behavior. Do not commit credentials, databases, generated builds or local planning files. See [release engineering](docs/releases.md) for the publishing process.
