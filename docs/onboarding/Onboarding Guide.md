# Onboarding Guide

> Welcome to IOFabrik! This guide is your starting point as a new team member.

## What is IOFabrik?

IOFabrik is a **desktop Git client** designed for non-technical users in industrial automation — PLC engineers, HMI designers, and teams working with binary configs, ladder logic, and hardware schematics.

Read [Product Overview](../product/Product%20Overview.md) for full context on the product, users, and goals.

## Key Concepts to Understand

Before diving into code, internalize these principles:

1. **User-first simplicity.** Our users don't know Git. Every feature must be self-explanatory. See [User-Facing Terminology](../product/User-Facing%20Terminology.md) for how we map Git to plain English.
2. **CLI-first backend.** All git operations shell out to `git`, `gh`, and `git-lfs` via [CommandRunner](../technical/infrastructure/CommandRunner.md). We do NOT use Go git libraries.
3. **Wails v3 bridge.** Go methods with exported names auto-generate TypeScript bindings. The frontend calls Go functions as if they were local. See [Architecture Overview](../technical/architecture/Architecture%20Overview.md).
4. **Industrial file focus.** We support diffing for images, PDFs, 3D models (STL/STEP), and PLC ladder logic (L5X). See [Viewer System](../technical/frontend/Viewer%20System.md).

## Your First Week

### Day 1: Environment & Build

1. Follow [Development Setup](Development%20Setup.md) to get the app running locally
2. Run `task dev` and explore the UI
3. Open a test Git repository in the app

### Day 2: Architecture

Read these docs in order:

1. [Architecture Overview](../technical/architecture/Architecture%20Overview.md) — How Go + React + Wails fit together
2. [Backend Architecture](../technical/backend/Backend%20Architecture.md) — Service registration, CLI execution
3. [Frontend Architecture](../technical/frontend/Frontend%20Architecture.md) — React contexts, layout system, component patterns
4. [Event System](../technical/architecture/Event%20System.md) — How backend and frontend communicate

### Day 3: Core Services

1. [Services Index](../technical/backend/Services%20Index.md) — Skim all 16 services
2. [GitService](../technical/backend/services/GitService.md) — The largest service (115+ methods). Read the method categories
3. [RepositorySettingsService](../technical/backend/services/RepositorySettingsService.md) — Per-repo config and background tasks
4. [CommandRunner](../technical/infrastructure/CommandRunner.md) — How every CLI command is executed

### Day 4: Frontend Deep Dive

1. [Layout System](../technical/frontend/Layout%20System.md) — VS Code-like shell architecture
2. [Context Providers](../technical/frontend/Context%20Providers.md) — RepoContext (the git state machine), LayoutContext, AuthContext
3. [Explorer Feature](../technical/frontend/features/Explorer%20Feature.md) — The main user-facing feature
4. [UI Components](../technical/frontend/UI%20Components.md) — shadcn-style Radix primitives

### Day 5: Workflows & Guides

1. [Git Workflows](../technical/guides/Git%20Workflows.md) — Decision trees for every git operation
2. [Adding a New Service](../technical/guides/Adding%20a%20New%20Service.md) — End-to-end guide
3. [Adding a New View](../technical/guides/Adding%20a%20New%20View.md) — How to add UI features
4. [Build and Release](../technical/guides/Build%20and%20Release.md) — How we ship

## Codebase Navigation Cheat Sheet

| "I need to..." | Look here |
|---|---|
| Find a git operation | `services/git_service.go` |
| Find a frontend component | `frontend/src/` |
| Check available bindings | `frontend/bindings/iofabrik/services/` |
| Understand a view/page | `frontend/src/components/layout/views/` and `pages/` |
| See UI primitives | `frontend/src/components/ui/` |
| Check frontend constants | `frontend/src/constants/index.ts`, [Constants Reference](../technical/reference/Constants%20Reference.md) |
| Understand data persistence | [Data Storage Reference](../technical/reference/Data%20Storage%20Reference.md), [Data Paths](../technical/infrastructure/Data%20Paths.md) |
| Debug CLI execution | [CommandRunner](../technical/infrastructure/CommandRunner.md), [Debug Logger](../technical/infrastructure/Debug%20Logger.md) |

## Common Patterns You'll See

### Backend: OperationResult

Every mutation method returns:

```go
type OperationResult struct {
    Success bool   `json:"success"`
    Message string `json:"message"`
    Error   string `json:"error,omitempty"`
}
```

### Frontend: Context + Binding

```tsx
// 1. Import the binding (auto-generated from Go)
import { GetStatus } from '../../bindings/iofabrik/services/gitservice';

// 2. Call it from a React component
const status = await GetStatus(repoPath);

// 3. Or use it through RepoContext (preferred for shared state)
const { status } = useRepo();
```

### Frontend: Icon Sizes

```tsx
import { ICON_SIZES } from '../constants';
import { FolderOpen } from 'lucide-react';

<FolderOpen size={ICON_SIZES.md} />
```

## Who to Ask

| Topic | Contact |
|---|---|
| Architecture decisions | Project lead |
| Git workflow questions | Check [Git Workflows](../technical/guides/Git%20Workflows.md) first |
| Build/release issues | Check [Build and Release](../technical/guides/Build%20and%20Release.md) first |
| UI/UX questions | Check [User-Facing Terminology](../product/User-Facing%20Terminology.md) first |

## Next Steps

- [Development Setup](Development%20Setup.md) — Get your environment running
- [Development Workflow](../processes/Development%20Workflow.md) — Our branch strategy and PR process
- [Documentation Standards](../processes/Documentation%20Standards.md) — How we maintain these docs

---

**Related:** [Development Setup](Development%20Setup.md) | [Architecture Overview](../technical/architecture/Architecture%20Overview.md) | [Product Overview](../product/Product%20Overview.md)
