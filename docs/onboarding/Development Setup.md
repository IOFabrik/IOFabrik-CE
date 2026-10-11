# Development Setup

> Get your local environment running for IOFabrik Desktop development.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| **Go** | 1.26+ | Backend language |
| **Node.js** | 20+ (LTS) | Frontend build tooling |
| **npm** | 10+ | Package manager (comes with Node) |
| **Wails CLI** | v3.0.0-beta.16 | Desktop app framework |
| **Git** | 2.40+ | Version control (also used by the app itself) |
| **Task** | 3.x | Task runner ([taskfile.dev](https://taskfile.dev)) |

### Optional

| Tool | Purpose |
|---|---|
| **gh** (GitHub CLI) | Required for GitHub integration features |
| **git-lfs** | Required for LFS features |
| **Docker** | Cross-compilation for Windows from macOS/Linux |

## Install Wails v3

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.16
```

Verify:
```bash
wails3 version
```

## Install Task Runner

```bash
# macOS
brew install go-task

# Or via Go
go install github.com/go-task/task/v3/cmd/task@latest
```

## Clone & Setup

```bash
# Clone the repository
git clone https://github.com/IOFabrik/IOFabrik-CE.git
cd IOFabrik-CE

# Install Go dependencies
go mod download

# Install frontend dependencies
cd frontend && npm ci && cd ..

# Generate TypeScript bindings from Go services
task common:generate:bindings
```

## Run in Development Mode

```bash
task dev
```

The native development build uses `DEV=true` and omits the `production` Go tag,
so it does not check for application updates.

This starts:
1. **Wails dev server** — watches Go files, rebuilds on change
2. **Vite dev server** — hot-reloads frontend on port `9245`
3. **Desktop window** — opens the app with live reload

## First Build Verification

```bash
# Build for current OS (production)
task build

# Run backend tests
go test ./services/... -v

# Run frontend checks
cd frontend
npm run typecheck   # TypeScript type checking
npm run lint        # Hygiene lint
npm test            # Vitest tests
```

## Project Structure Quick Reference

```
main.go                  → App entry point, 13 service registrations
services/                → All Go backend services
frontend/src/            → React + TypeScript frontend
frontend/bindings/       → Auto-generated Wails bindings (DO NOT EDIT)
build/config.yml         → App identity (name, version)
Taskfile.yml             → Build orchestration
```

See [Architecture Overview](../technical/architecture/Architecture%20Overview.md) for the full architecture diagram.

## Common Tasks

| Task | Command |
|---|---|
| Development mode | `task dev` |
| Production build | `task build` |
| Package for distribution | `task package` |
| Regenerate bindings | `task common:generate:bindings` |
| Backend tests | `go test ./services/... -v` |
| Backend test coverage | `go test ./services/... -coverprofile=coverage.out && go tool cover -html=coverage.out` |
| Frontend tests | `cd frontend && npm test` |
| Frontend type check | `cd frontend && npm run typecheck` |
| Frontend lint | `cd frontend && npm run lint` |

## Ladder Visualizer Package

The `ladder-visualizer` package is pinned to an immutable upstream Git commit:

```json
// frontend/package.json
"ladder-visualizer": "git+https://github.com/IOFabrik/ladder-visualizer.git#<full-commit>"
```

`npm ci` fetches that exact revision and runs the package's build preparation.
Normal IOFabrik development does not require a sibling checkout.

To test uncommitted `ladder-visualizer` work locally, first build a sibling
checkout, then replace only the installed package without changing the manifest
or lockfile:

```bash
cd ../ladder-visualizer
npm ci
npm run build

cd ../IOFabrik-CE/frontend
npm install --no-save --package-lock=false ../../ladder-visualizer
```

Run `npm ci` again to restore the pinned package before validation or committing.

## IDE Setup

### VS Code (Recommended)

- Open the repository folder in your editor
- Install recommended extensions: Go, ESLint, Tailwind CSS IntelliSense, Prettier
- Keep personal editor settings and multi-repository workspace files local

### Go Configuration

Ensure your Go tooling points to the correct module:

```
Module: iofabrik (see go.mod)
```

### TypeScript

The frontend uses strict TypeScript. Check `frontend/tsconfig.json` for compiler options.

## Troubleshooting

### Bindings out of date

If the frontend shows TypeScript errors about missing methods:

```bash
task common:generate:bindings
```

### Wails build fails

Ensure Wails v3 beta.16 is installed:

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.16
```

### Port 9245 in use

Kill any existing Vite dev server or change `WAILS_VITE_PORT` in Taskfile.yml.

### Frontend dependencies fail

```bash
cd frontend && rm -rf node_modules && npm install
```

---

**Related:** [Onboarding Guide](Onboarding%20Guide.md) | [Architecture Overview](../technical/architecture/Architecture%20Overview.md) | [Build and Release](../technical/guides/Build%20and%20Release.md)
