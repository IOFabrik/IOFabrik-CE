# IOFabrik — AI Agent Skills Guide

This document defines the skills, guardrails, and domain knowledge an AI coding agent needs to work effectively on IOFabrik. It focuses on three pillars: **UX consistency**, **backend performance/reliability**, and **product-level ease of use** for non-technical Git users.

---

## 1. Product Context

### Who Uses This

IOFabrik is for **industrial automation engineers** — people who configure PLCs, HMIs, and actuator systems. They are experts in their field, not in software development. They work with:
- Large binary files (PLC project archives, CAD models, PDFs)
- Proprietary file formats (Rockwell L5X/L5K, Siemens TIA Portal exports)
- Shared network drives and legacy workflows (zip-and-email, USB sticks)
- Windows machines (primary), occasionally macOS

**They do not know Git.** Every interaction with version control must be translated into language they understand. Never surface raw Git concepts, CLI output, or error messages to the user without translation.

### Product North Star

> Make version control invisible. The user should think in terms of "saving work", "getting updates", and "sharing changes" — not branches, commits, or staging areas.

---

## 2. UX Consistency Skills

### Language Rules

| Git Term | User-Facing Term | Notes |
|----------|-----------------|-------|
| commit | Save Changes | Always paired with a message prompt |
| pull | Sync (download part) | Combined with push as "Sync" |
| push | Share / Push | Context-dependent |
| pull + push | Sync | The primary operation |
| branch | Version / Branch | "Branch" is acceptable in branch management UI |
| merge | Merge | Acceptable — shown in dedicated merge view |
| checkout | Switch | "Switch to [branch name]" |
| stash | (hidden) | Stashing is automatic and invisible to the user |
| reset --soft HEAD~1 | Rewind | Undo the last save |
| restore / checkout -- | Discard | Discard unsaved changes |
| staging / index | (hidden) | Always `git add .` — no partial staging |
| HEAD, SHA, ref | (never shown) | Internal concepts only |
| rebase | (forbidden) | The app uses merge-only workflows |

### Error Message Standards

Every error shown to the user must follow this pattern:

```
[What happened] — plain English, no Git jargon
[What to do next] — a concrete recovery action the user can take
```

**Bad:** `fatal: refusing to merge unrelated histories`
**Good:** `These projects don't share a common history. Try creating a new project and moving your files over.`

**Bad:** `error: Your local changes to the following files would be overwritten by merge`
**Good:** `You have unsaved changes that conflict with incoming updates. Save your changes first, then try syncing again.`

### Visual Design Rules

1. **Icons:** Always `lucide-react`. Always use `ICON_SIZES` constant (`xs: 14`, `sm: 16`, `md: 20`, `lg: 28`). Never hardcode pixel values.
2. **Colors:** Use Tailwind CSS utility classes. Follow the established palette:
   - Surfaces: `bg-gray-900`, `bg-gray-800/50`, `bg-gray-800`
   - Text: `text-gray-100` (primary), `text-gray-400` (secondary), `text-gray-500` (muted)
   - Borders: `border-gray-700/50`
   - Accent: `text-blue-400`, `bg-blue-600`
   - Status colors from `FILE_STATUS_COLORS` constant
3. **Theme classes:** Use `text-theme-primary`, `bg-theme-surface`, etc. for theme-aware elements that need to work in light/dark/system modes.
4. **Components:** Always use shadcn-style primitives from `components/ui/`. Never build custom buttons, inputs, selects, or modals from scratch.
5. **Toasts:** `sonner` only. Use `toast.success()`, `toast.error()`, `toast.info()`. Keep messages under 80 characters.
6. **Loading states:** Use `Spinner` component for inline loading, `LoadingState` for full-area loading. Always show loading state during async operations — never leave the user staring at a static screen.
7. **Empty states:** Use the `EmptyState` component. Always provide a call-to-action.

### Interaction Patterns

1. **Destructive actions require confirmation.** Discard, rewind, delete branch, abort merge — all must use `AlertDialog` with clear consequences stated.
2. **Long operations show progress.** Use `ProgressService` events + `ProgressModal` for clone, push, pull, sync. Parse `git-progress` events for real-time feedback.
3. **State transitions are immediate.** After any Git operation, refresh status immediately (don't wait for file watcher). Call `refreshStatus()` in `RepoContext`.
4. **Sidebar and main area stay in sync.** The sidebar view drives the main area page via `VIEW_REGISTRY`. Never show mismatched content.
5. **Tabs work like a browser.** Files open in tabs in the main area. The file browser tab is always pinned. Diff tabs show the comparison type in the tab title.

---

## 3. Backend Performance & Reliability Skills

### CLI Execution Rules

1. **Always use `CommandRunner`.** Never call `os/exec` directly. The runner handles timeouts, debug logging, Windows environment sanitization, and process group management.
2. **Always use resolved paths.** Call `GitPath()`, `GhPath()`, `LfsPath()` from `cli_resolver.go` — never assume `git` is in PATH. The resolution order (bundled → system → fallback) exists for a reason.
3. **30-second timeout is the default.** For operations that may take longer (clone, push large repos, LFS fetch), create a custom context with a longer timeout.
4. **Parse `--porcelain` output.** When reading Git status, always use `git status --porcelain` for machine-readable output. Never parse human-readable output.
5. **Return `OperationResult` from mutations.** Every method that changes state must return `OperationResult{Success bool, Message string, Error string}`. Queries return typed structs.

### Concurrency & State Safety

1. **Background tasks are managed.** `RepositorySettingsService` runs 3 automatic background tasks (fetch every 5 min, LFS fetch every 10 min, maintenance every 30 min). Be aware these exist when debugging timing issues.
2. **File watcher has 300ms debounce.** Rapid filesystem changes are coalesced. Don't rely on per-file events — you get batched notifications.
3. **CLI path resolution is cached.** `sync.Once` ensures binary paths are resolved only once. Call `RefreshCLIPaths()` if tools are installed/changed at runtime.
4. **Mutex where needed.** `GitHubService` has `authMu` for device flow auth. `AuthService` has `mu` for keychain access. `DebugLogger` has `mu` for ring buffer writes. Follow this pattern for any shared state.

### Windows-Specific Awareness

1. **Hide console windows.** All CLI processes use `SysProcAttr` from `sysproc_windows.go` to prevent command prompt flashes.
2. **Sanitize environment.** `CommandRunner.buildCommandEnv()` removes `GIT_ASKPASS`, `SSH_ASKPASS`, `VSCODE_GIT_ASKPASS_*` and sets `GIT_TERMINAL_PROMPT=0` to prevent interactive prompts that would hang the app.
3. **Portable toolchain.** On Windows, NSIS installs checksum-verified MinGit + gh + git-lfs under `%LOCALAPPDATA%\IOFabrik\tools\bin`. `LocalBinService` validates and initializes these tools without downloading. The managed tool directories are prepended to PATH in every command execution.
4. **Path separators.** Use `filepath.Join()` in Go and normalize paths when passing between backend and frontend.

### Error Handling Patterns

1. **Never panic.** All errors are returned as values. Services should catch and translate errors before returning to the frontend.
2. **Log with DebugLogger.** Use `GetDebugLogger().Log(category, level, message, details)` for diagnostic information. Categories: `command`, `method`, `event`, `error`, `lifecycle`.
3. **Degrade gracefully.** If `gh` CLI isn't installed, GitHub features should be disabled (not crash). If `git-lfs` isn't available, LFS UI should explain what to install. Check `IsGHInstalled()`, `IsLFSInstalled()` before calling dependent methods.
4. **Stuck state recovery.** The app detects stuck Git states (merge, cherry-pick, revert, AM, bisect) via `GetMergeState()` and shows a `RecoveryBanner`. Any new Git operations must not break when the repo is in a stuck state.

### Performance Guidelines

1. **Virtualize long lists.** `CommitList` and file lists use `@tanstack/react-virtual`. Any list that could exceed ~50 items should be virtualized.
2. **Lazy-load heavy viewers.** PDF, 3D, and L5X viewers use `React.lazy()`. Don't import heavy libraries at the top level.
3. **Memo everything.** All React components should use `memo()`. Handlers should use `useCallback()`. Derived state should use `useMemo()`. This isn't optional.
4. **Minimize re-renders.** `RepoContext` is 3,052 lines. Be surgical about what state changes you trigger. Use derived state and memoization to prevent cascade re-renders.
5. **Diff data can be large.** File diffs for binary files or large text files can be megabytes. Always stream or paginate. The viewer system handles caching via `viewer-cache.ts`.

---

## 4. Architecture Decision Skills

### When to Add Backend vs Frontend Logic

| Situation | Put it in... | Why |
|-----------|-------------|-----|
| Running a git command | Backend (`services/*.go`) | CLI execution must go through `CommandRunner` |
| Parsing git output | Backend | Consistent, typed parsing in Go |
| File reading | Backend (`FileSystemService`) | Wails webview can't access `file://` URLs |
| UI state (which tab is open, sidebar width) | Frontend (`LayoutContext`) | Ephemeral UI state |
| Git state (branches, status, commits) | Frontend (`RepoContext`) | Orchestration of backend calls + UI state |
| Settings persistence | Backend (`SettingsService`) | Uses XDG-compliant path resolution |
| Auth tokens | Backend (`AuthService`) | OS keychain via `go-keyring` |

### When to Create a New Service vs Extend Existing

**Extend existing** when:
- The method logically belongs to an existing service's responsibility
- You're adding a new Git operation → add to `GitService`
- You're adding a new LFS operation → add to `LFSService`
- You're adding a new GitHub operation → add to `GitHubService`

**Create new service** when:
- You're introducing a new external tool dependency
- The functionality is orthogonal to all existing services
- The service needs its own lifecycle (background tasks, cleanup)

### Adding a New File Viewer

Follow the registry pattern in `docs/technical/DeveloperGuide_Viewer.md`:
1. Create the viewer component in `components/viewers/`
2. Register it in `lib/viewers-builtin.ts` with appropriate priority and file matchers
3. If the viewer needs heavy dependencies, use `React.lazy()` and dynamic import
4. Always read files via backend (`ReadFileBase64` or `ReadTextFile`) — not `file://` URLs
5. Add a corresponding diff viewer if the file type can be meaningfully compared between revisions
6. Include error boundary handling via `ViewerErrorBoundary`

---

## 5. Testing Skills

### Backend Testing Patterns

```go
// Always use test helpers for temp repos
func TestMyFeature(t *testing.T) {
    repoPath := createTestRepo(t)
    defer cleanupTestRepo(t, repoPath)
    
    svc := NewGitService()
    // ... test against real git repo
}

// Skip when CLI tools aren't available
func TestLFSFeature(t *testing.T) {
    if _, err := exec.LookPath("git-lfs"); err != nil {
        t.Skip("git-lfs not installed")
    }
    // ...
}

// Table-driven tests for multiple scenarios
func TestStatusParsing(t *testing.T) {
    tests := []struct{
        name     string
        input    string
        expected RepoStatus
    }{
        {"clean repo", "", RepoStatus{HasChanges: false}},
        {"modified file", " M file.txt", RepoStatus{HasChanges: true}},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) { /* ... */ })
    }
}
```

### Frontend Testing Patterns

- Use Vitest with React Testing Library
- Test components in isolation with mocked contexts
- Focus on user-visible behavior, not implementation details

---

## 6. Common Pitfalls to Avoid

| Pitfall | Why It's Bad | What to Do Instead |
|---------|-------------|-------------------|
| Using `go-git` library | Inconsistent behavior vs real git CLI, especially on Windows | Always shell out via `CommandRunner` |
| Import from `frontend/bindings/` directly in service code | Bindings are auto-generated; edits will be overwritten | Let Wails regenerate bindings from Go structs |
| Creating a new React Context | More contexts = more re-render cascading | Add state to existing `RepoContext` or `LayoutContext` |
| Using `git rebase` | Users can't understand or recover from rebase conflicts | Use `git merge` (with squash option) exclusively |
| Showing raw error messages | Non-technical users can't interpret Git errors | Translate every error to plain English with a recovery action |
| Hardcoding file paths | Breaks on Windows/macOS path differences | Use `filepath.Join()` (Go) or path utilities (frontend) |
| Importing heavy libraries at top level | Increases initial bundle size, slows startup | Use `React.lazy()` and dynamic imports |
| Partial staging (`git add <file>`) | Contradicts the "simple git" philosophy | Always `git add .` — all-or-nothing staging |
| Adding MUI components | MUI was fully removed; adding it back creates bundle bloat | Use Radix + Tailwind + shadcn-style components from `ui/` |
| Non-English user-facing text | Target audience may not all speak English fluently | Keep labels simple, concrete, and action-oriented |

---

## 7. Code Quality Checklist

Before submitting any change, verify:

- [ ] **No Git jargon** in user-facing strings (buttons, toasts, errors, modals)
- [ ] **OperationResult** returned from all backend mutation methods
- [ ] **CommandRunner** used for all CLI execution (never raw `os/exec`)
- [ ] **Error translated** — every error path has a human-readable message
- [ ] **Loading state** shown during async operations
- [ ] **Confirmation dialog** for destructive actions
- [ ] **memo/useCallback/useMemo** applied appropriately
- [ ] **ICON_SIZES** constant used for all icon sizes
- [ ] **shadcn primitives** used for UI elements (no custom buttons/inputs)
- [ ] **TypeScript** only (`.tsx`/`.ts`) — no `.jsx`
- [ ] **Bindings regenerated** after Go struct/method changes
- [ ] **Windows behavior considered** — paths, console hiding, portable tools
- [ ] **File reading goes through backend** — no `file://` URL access from frontend
- [ ] **Existing methods reused** — checked `services/*.go` and `frontend/bindings/` first
