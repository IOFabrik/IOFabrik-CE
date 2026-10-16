# IOFabrik Documentation

> **Version:** v0.13.0-beta | **Platform:** Windows (primary), macOS | **Stack:** Wails v3 + Go 1.26 + React 18 + TypeScript

IOFabrik is a simplified desktop Git client for **non-technical users** in industrial automation — PLC engineers, HMI designers, and automation teams who work with binary config files, ladder logic, and hardware schematics.

---

## Quick Navigation

### 🏁 Getting Started
- [Installation](onboarding/Installation.md) — Windows download, setup, and updates
- [Onboarding Guide](onboarding/Onboarding%20Guide.md) — Start here if you're new to the team
- [Development Setup](onboarding/Development%20Setup.md) — Get your local environment running
- [Architecture Overview](technical/architecture/Architecture%20Overview.md) — Understand how the app is built

### 📦 Product
- [Product Overview](product/Product%20Overview.md) — What IOFabrik is and who it's for
- [User-Facing Terminology](product/User-Facing%20Terminology.md) — How we map Git concepts to plain English

### 🏗 Technical — Architecture
- [Architecture Overview](technical/architecture/Architecture%20Overview.md) — System-level architecture (Wails, Go, React)
- [Backend Architecture](technical/backend/Backend%20Architecture.md) — Go services, CLI execution, data paths
- [Frontend Architecture](technical/frontend/Frontend%20Architecture.md) — React contexts, layout, component structure
- [Event System](technical/architecture/Event%20System.md) — Backend ↔ Frontend communication
- [State Management](technical/architecture/State%20Management.md) — How app state flows through contexts
- [Viewer System](technical/frontend/Viewer%20System.md) — Pluggable file viewer & diff viewer registry

### 🔧 Technical — Backend Services
- [Services Index](technical/backend/Services%20Index.md) — All 16 registered services at a glance
- [GitService](technical/backend/services/GitService.md) — Core git operations (115+ methods)
- [LFSService](technical/backend/services/LFSService.md) — Git Large File Storage
- [GitHubService](technical/backend/services/GitHubService.md) — GitHub CLI wrapper & device-flow auth
- [RepositorySettingsService](technical/backend/services/RepositorySettingsService.md) — Per-repo config & background tasks
- [SettingsService](technical/backend/services/SettingsService.md) — App settings & git identity
- [ProgressService](technical/backend/services/ProgressService.md) — Git operation progress streaming
- [FileWatcherService](technical/backend/services/FileWatcherService.md) — Filesystem monitoring
- [ConflictQueueService](technical/backend/services/ConflictQueueService.md) — Queue of files still needing a conflict decision
- [IntegrationSessionService](technical/backend/services/IntegrationSessionService.md) — Isolated readiness, conflict decisions, and guarded Finish
- [FileSystemService](technical/backend/services/FileSystemService.md) — File operations & directory listing
- [ImageDiffService](technical/backend/services/Other%20Services.md#imagediffservice) — Pixel-level image comparison
- [AuthService](technical/backend/services/Other%20Services.md#authservice) — Supabase session keychain persistence
- [DebugService](technical/backend/services/Other%20Services.md#debugservice) — Runtime debug logging
- [LocalBinService](technical/backend/services/Other%20Services.md#localbinservice) — Windows portable CLI toolchain

### ⚙️ Technical — Infrastructure
- [CommandRunner](technical/infrastructure/CommandRunner.md) — CLI execution engine
- [CLI Resolver](technical/infrastructure/CLI%20Resolver.md) — Binary path resolution strategy
- [LDSDK Helper Protocol](technical/infrastructure/LDSDK%20Helper%20Protocol.md) — Versioned manual-conversion helper contract and artifact validation
- [Data Paths](technical/infrastructure/Data%20Paths.md) — XDG-compliant storage layout
- [Debug Logger](technical/infrastructure/Debug%20Logger.md) — Ring-buffer logging system
- [Auto-Updater](technical/infrastructure/Auto-Updater.md) — Wails updater for production Windows x64

### 🖥 Technical — Frontend
- [Frontend Architecture](technical/frontend/Frontend%20Architecture.md) — Component organization & patterns
- [Layout System](technical/frontend/Layout%20System.md) — VS Code-like shell (AppLayout, ActivityBar, Sidebar, MainArea)
- [Context Providers](technical/frontend/Context%20Providers.md) — RepoContext, LayoutContext, AuthContext
- [UI Components](technical/frontend/UI%20Components.md) — shadcn-style Radix primitives
- [Viewer System](technical/frontend/Viewer%20System.md) — File viewer & diff viewer registry
- Feature docs: [Explorer Feature](technical/frontend/features/Explorer%20Feature.md), [Conflict Queue Sidebar](technical/frontend/features/Conflict%20Queue%20Sidebar.md), [History Feature](technical/frontend/features/Feature%20Docs.md#history-feature), [Merge Feature](technical/frontend/features/Feature%20Docs.md#merge-feature), [Welcome Feature](technical/frontend/features/Feature%20Docs.md#welcome-feature)

### 📖 Guides
- [Adding a New Service](technical/guides/Adding%20a%20New%20Service.md) — Step-by-step guide for new Go services
- [Adding a New View](technical/guides/Adding%20a%20New%20View.md) — Adding sidebar views & main area pages
- [Adding a New Viewer](technical/guides/Adding%20a%20New%20Viewer.md) — Creating file/diff viewers
- [Git Workflows](technical/guides/Git%20Workflows.md) — All git operations with decision trees
- [Build and Release](technical/guides/Build%20and%20Release.md) — Build, package, sign, distribute
- [Testing Guide](technical/guides/Testing%20Guide.md) — Backend & frontend testing patterns

### 🔁 Processes
- [Development Workflow](processes/Development%20Workflow.md) — Branch strategy, PR process, code review
- [Documentation Standards](processes/Documentation%20Standards.md) — How to maintain these docs

### 📋 Reference
- [Environment Variables](technical/reference/Environment%20Variables.md) — All configurable env vars
- [Event Reference](technical/reference/Event%20Reference.md) — Complete event name catalog
- [Constants Reference](technical/reference/Constants%20Reference.md) — Frontend constants & view IDs
- [Data Storage Reference](technical/reference/Data%20Storage%20Reference.md) — File paths per platform

---

## Documentation Conventions

- **Cross-links** use relative Markdown links compatible with GitHub
- **Code references** link to specific files: `services/git_service.go`
- **Architecture Decision Records** start with the date and context
- All user-facing text must use [User-Facing Terminology](product/User-Facing%20Terminology.md) — never raw Git jargon

---

*Last updated: September 2026*
