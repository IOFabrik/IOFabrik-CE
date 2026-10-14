# IOFabrik contributor guidance

IOFabrik is a desktop Git client for industrial automation projects, built
with Go, Wails v3, React, TypeScript, and Vite. Read `go.mod` and
`frontend/package.json` for the pinned dependency versions.

Read `.github/agents.md` for the mandatory engineering checklist. This guide
supplements those rules; it does not replace them.

## Code organization

- `main.go` registers Wails services and application lifecycle handlers.
- `services/` contains backend services, Git operations, and their tests.
- `services/app_update_service.go` coordinates the Wails updater for production Windows x64 builds.
- `frontend/src/app/` contains startup and application providers.
- `frontend/src/domain/` contains shared authentication, analytics, and repository state.
- `frontend/src/features/` contains user-facing workflows.
- `frontend/src/shared/` contains shared UI primitives and utilities.
- `frontend/src/viewers/` contains file viewers, diff viewers, and registries.
- `frontend/src/widgets/layout/` contains the application shell.
- `frontend/bindings/` contains generated Wails bindings. Never hand-edit them.
- `build/` contains required platform templates, manifests, icons, and tasks.

## Implementation conventions

- Inspect existing services and frontend bindings before adding functionality.
- Run Git, GitHub CLI, and Git LFS through `CommandRunner` and the CLI resolver.
- Preserve the app's merge-only Git workflows.
- Backend mutation methods return `OperationResult`; translate failures into
  clear user messages with a recovery action.
- Reuse existing providers, shared modal primitives, Radix components, Tailwind
  classes, icons, and notification patterns.
- Keep heavy viewers lazy-loaded and preserve viewer error boundaries.
- Use the backend for filesystem access and the OS keychain for persisted sessions.
- After changing an exported Go service interface, regenerate bindings with
  `task common:generate:bindings`.

## Validation

```bash
go build ./...
go test . ./services/...
cd frontend
npm run ci:guards
npm test
npm run build
```

From the repository root, also run `python3 scripts/check-publication.py` before
publishing changes. It checks tracked paths without printing file contents.

## Documentation

Start at [the documentation index](../docs/HOME.md),
[development setup](../docs/onboarding/Development%20Setup.md), and
[build instructions](../docs/technical/guides/Build%20and%20Release.md).
Keep implementation drafts, internal reviews, release operations, credentials,
and local workspace state outside this public repository.
