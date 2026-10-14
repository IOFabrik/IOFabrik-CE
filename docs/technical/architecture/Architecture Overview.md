# Architecture Overview

> This document describes the system-level architecture of IOFabrik Desktop. Read this first before diving into any specific subsystem.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        IOFabrik Desktop                     │
│                                                                  │
│  ┌──────────────────────┐     ┌──────────────────────────────┐  │
│  │   Go Backend (Wails) │     │  React Frontend (WebView)    │  │
│  │                      │     │                              │  │
│  │  ┌────────────────┐  │     │  ┌────────────────────────┐  │  │
│  │  │  16 Services   │◄─┼─IPC─┼─►│  Wails Auto-Bindings   │  │  │
│  │  │  (registered)  │  │     │  │  (TypeScript)           │  │  │
│  │  └───────┬────────┘  │     │  └────────────┬───────────┘  │  │
│  │          │           │     │               │              │  │
│  │  ┌───────▼────────┐  │     │  ┌────────────▼───────────┐  │  │
│  │  │ CommandRunner  │  │     │  │  3 Context Providers    │  │  │
│  │  │ (os/exec)      │  │     │  │  Repo│Layout│Auth      │  │  │
│  │  └───────┬────────┘  │     │  └────────────┬───────────┘  │  │
│  │          │           │     │               │              │  │
│  │  ┌───────▼────────┐  │     │  ┌────────────▼───────────┐  │  │
│  │  │  CLI Resolver  │  │     │  │  VS Code-like Layout   │  │  │
│  │  │  (git/gh/lfs)  │  │     │  │  TopBar│Sidebar│Main   │  │  │
│  │  └────────────────┘  │     │  └────────────────────────┘  │  │
│  └──────────────────────┘     └──────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────┐     ┌──────────────────────────────┐  │
│  │  Event System        │     │  File Viewer Registry        │  │
│  │  (Wails Events)      │     │  (Text│Image│PDF│3D│L5X)     │  │
│  └──────────────────────┘     └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │              │                │
         ▼              ▼                ▼
    ┌─────────┐   ┌──────────┐    ┌──────────┐
    │  git    │   │  gh CLI  │    │ git-lfs  │
    │  CLI    │   │          │    │          │
    └─────────┘   └──────────┘    └──────────┘
```

## Key Architectural Decisions

### 1. CLI-First Principle
All git operations use `os/exec` via [CommandRunner](../infrastructure/CommandRunner.md) to call the `git`, `gh`, and `git-lfs` CLI tools. We do **not** use go-git or any Go git library directly.

**Why:** CLI tools are the most tested, most compatible path. Users' existing git configs, credential helpers, SSH keys, and GPG setups all work automatically.

### 2. Wails v3 Bridge
The app uses [Wails v3](https://v3.wails.io/) to bridge Go backend ↔ React frontend. Go structs with exported methods are registered as services and auto-exposed as TypeScript bindings.

**Data flow:**
1. Frontend calls auto-generated TypeScript function
2. Wails serializes args → Go method call
3. Go method executes (typically runs CLI command)
4. Return value serialized → TypeScript

### 3. Service Architecture
All backend logic lives in `services/*.go`. Each service is a Go struct with:
- A constructor (`NewMyService()`)
- Exported methods (auto-exposed to frontend)
- An optional `SetApp()` method for event emission

Services are registered in `main.go` via `application.NewService()`. See [Services Index](../backend/Services%20Index.md) for the complete list.

### 4. Context-Based State Management
The frontend uses three React Contexts to manage all application state:
- **[RepoContext](../frontend/Context%20Providers.md#repocontext)** — Git state machine (repo, status, commits, diffs, branches, merge, stash)
- **[LayoutContext](../frontend/Context%20Providers.md#layoutcontext)** — UI state (active view, sidebar, theme, explorer tabs)
- **[AuthContext](../frontend/Context%20Providers.md#authcontext)** — Supabase session (login/logout, keychain persistence)

### 5. Event-Driven Sync
The backend pushes state changes to the frontend via [Wails events](Event%20System.md):
- `file-changes` — Filesystem watcher detected changes
- `git-progress` — Streaming progress for long git operations
- `local-bin:progress` — Portable tool download progress

The frontend combines events with a 30-second polling fallback and immediate refresh after every git operation. See [State Management](State%20Management.md) for details.

## Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Desktop Framework | Wails | v3.0.0-beta.16 | Go ↔ WebView bridge and Windows x64 updates |
| Backend Language | Go | 1.26 | Service logic, CLI execution |
| Frontend Framework | React | 18 | UI rendering |
| Frontend Language | TypeScript | 5.x | Type safety |
| Build Tool | Vite | 6.x | Frontend bundling, HMR |
| Styling | Tailwind CSS | v4 | Utility-first CSS |
| UI Primitives | Radix UI | Latest | Headless accessible components |
| Component Patterns | shadcn/ui style | — | cva + clsx + tailwind-merge |
| Icons | lucide-react | 0.562 | Consistent icon library |
| State Management | React Context | — | 3 providers (Repo, Layout, Auth) |
| Auth | Supabase | Latest | User authentication |
| Session Storage | go-keyring | — | OS keychain (macOS/Windows/Linux) |
| Analytics | PostHog | posthog-js | Event tracking |
| Notifications | sonner | — | Toast notifications |
| Virtualization | @tanstack/react-virtual | — | Large list performance |
| File Diffing | react-diff-view | — | Unified/split diff rendering |
| PDF Rendering | react-pdf | — | PDF viewer (lazy loaded) |
| 3D Rendering | online-3d-viewer | — | STL/OBJ/STEP viewer (lazy loaded) |
| L5X Rendering | ladder-visualizer | Local link | Rockwell L5X viewer (lazy loaded) |
| Task Runner | Task (go-task) | — | Build orchestration |

## Module Boundaries

```
main.go                  ← App entry, service registration, menu, events
services/                ← ALL backend logic lives here
  ├── *_service.go       ← Registered services (16 total)
  ├── runner.go          ← CommandRunner (CLI execution)
  ├── cli_resolver.go    ← Binary path resolution
  ├── data_paths.go      ← XDG data layout
  ├── debug_logger.go    ← Ring-buffer logger
  └── *_test.go          ← Backend tests

frontend/src/
  ├── app/               ← Bootstrap (App.tsx, main.tsx, providers)
  ├── domain/            ← Business logic (auth, repo, analytics)
  ├── features/          ← User-facing feature modules
  ├── shared/            ← Cross-cutting reusables (UI, hooks, constants)
  ├── viewers/           ← Pluggable file/diff viewer system
  ├── widgets/           ← Layout shell (AppLayout, TopBar, etc.)
  └── context/           ← Context facade barrel

frontend/bindings/       ← Auto-generated Wails bindings (NEVER EDIT)
```

## Initialization Sequence

```
main.go startup:
1. RunDataLayoutMigration()          ← Move legacy config dirs
2. Create service instances          ← NewGitService(), etc.
3. app := application.New(...)       ← Register the initial 15 services
4. Register AppUpdateService         ← Attach lifecycle and updater coordination
5. [Production Windows x64] Init     ← Configure stable GitHub releases + checksums
6. service.SetApp(app)               ← Wire event emitters
7. GetDebugLogger().SetApp(app)      ← Wire debug log events
8. [Windows] EnsurePortableToolchain ← Background goroutine
9. app.Run()                         ← Start event loop + WebView
```

## Platform Differences

| Aspect | Windows | macOS |
|--------|---------|-------|
| CLI tools | Portable download (MinGit, gh, git-lfs) | Bundled in .app or system |
| App menu | Custom File menu | Standard macOS AppMenu |
| Keychain | Credential Manager | Keychain |
| Console | Hidden (SysProcAttr) | N/A |
| Data paths | `%APPDATA%`, `%LOCALAPPDATA%` | `~/.config`, `~/Library/Caches` |
| Distribution | NSIS installer + Wails updater (x64 production) | DMG |

---

`AppUpdateService` checks GitHub stable releases on startup and schedules silent
checks every six hours. It serializes manual and background updater operations.
Wails verifies the executable against `SHA256SUMS` and handles staging and restart.
See [Auto-Updater](../infrastructure/Auto-Updater.md) for the release contract.

---

**Next:** [Backend Architecture](../backend/Backend%20Architecture.md) | [Frontend Architecture](../frontend/Frontend%20Architecture.md) | [Event System](Event%20System.md)
