# Backend Architecture

> All backend logic lives in `services/*.go`. This document covers the patterns, conventions, and infrastructure that backend services build upon.

## Service Pattern

Every backend service follows the same pattern:

```go
// services/my_service.go

type MyService struct {
    runner *CommandRunner    // CLI execution (most services need this)
    app    *application.App // Only if the service emits events
}

func NewMyService() *MyService {
    return &MyService{
        runner: NewCommandRunner(),
    }
}

// SetApp is called from main.go after app creation (only if needed)
func (s *MyService) SetApp(app *application.App) {
    s.app = app
}

// Exported methods become TypeScript bindings automatically
func (s *MyService) DoSomething(repoPath string) OperationResult {
    result := s.runner.RunGit(repoPath, "status", "--porcelain")
    if !result.Success {
        return failedOp(result.Error)
    }
    return successOp("Done")
}
```

### Key Rules
1. **Constructor** always named `New<ServiceName>()`
2. **CLI execution** always through `CommandRunner` — never `exec.Command()` directly
3. **Mutations** return `OperationResult{Success, Message, Error}`
4. **Queries** return typed structs (auto-serialized to TypeScript)
5. **Event emission** requires `SetApp()` callback wired in `main.go`

## OperationResult — Standard Return Type

All mutation operations (commit, push, merge, etc.) return this type:

```go
type OperationResult struct {
    Success bool   `json:"success"`
    Message string `json:"message,omitempty"`
    Error   string `json:"error,omitempty"`
}

// Convenience constructors
func successOp(msg string) OperationResult
func failedOp(errMsg string) OperationResult
```

The frontend checks `.Success` and displays `.Message` (success toast) or `.Error` (error toast).

## Service Registration

All services are registered in `main.go`:

```go
app := application.New(application.Options{
    Services: []application.Service{
        application.NewService(services.NewGitService()),
        application.NewService(services.NewLFSService()),
        application.NewService(services.NewGitHubService()),
        // ... 12 more in the initial registration
    },
})

appUpdateService := services.NewAppUpdateService(Version, app)
app.RegisterService(application.NewService(appUpdateService))
```

After app creation, services needing event emission get wired:

```go
progressService.SetApp(app)
fileWatcherService.SetApp(app)
repoSettingsService.SetApp(app)
debugService.SetApp(app)
localBinService.SetApp(app)
```

See [Services Index](Services%20Index.md) for the complete list.

## CommandRunner — CLI Execution Engine

> Full details: [CommandRunner](../infrastructure/CommandRunner.md)

All CLI execution goes through `CommandRunner` (`services/runner.go`). This centralizes:
- Timeout management (30s default)
- Platform-specific env sanitization (Windows ASKPASS removal)
- Non-interactive mode forcing (`GIT_TERMINAL_PROMPT=0`)
- Debug logging of every command
- Console window hiding (Windows)

**Key methods:**

| Method | Use Case |
|--------|----------|
| `RunGit(repoPath, args...)` | Standard git commands |
| `RunGh(workDir, args...)` | GitHub CLI commands |
| `RunGitRaw(repoPath, args...)` | Binary output (images, PDFs) |
| `Run(workDir, name, args...)` | Arbitrary CLI commands |
| `RunWithContext(ctx, ...)` | Custom timeout (auth flows) |
| `RunWithStdin(workDir, stdin, name, args...)` | Stdin injection |

**CommandResult:**
```go
type CommandResult struct {
    Stdout   string
    Stderr   string
    ExitCode int
    Success  bool
    Error    string
}
```

## CLI Resolver — Binary Path Resolution

> Full details: [CLI Resolver](../infrastructure/CLI%20Resolver.md)

`services/cli_resolver.go` resolves `git`, `gh`, and `git-lfs` binaries in priority order:

1. **Platform-local managed binaries** — Windows `%LOCALAPPDATA%\IOFabrik\tools\bin`
2. **Bundled app resources** — macOS `.app/Contents/Resources/`
3. **System PATH** — `exec.LookPath()`
4. **Common install paths** — Windows Program Files, scoop, etc.
5. **Bare command fallback** — `"git"` (lets OS do final lookup)

Results are **cached via `sync.Once`**. Call `RefreshCLIPaths()` after installing new tools.

## Data Paths — Storage Layout

> Full details: [Data Paths](../infrastructure/Data%20Paths.md)

All data storage follows XDG conventions via `services/data_paths.go`:

| Data | Windows | macOS |
|------|---------|-------|
| Settings | `%APPDATA%\IOFabrik\config\settings.json` | `~/.config/IOFabrik/config/settings.json` |
| Repo settings | `%APPDATA%\IOFabrik\config\repositories\` | `~/.config/IOFabrik/config/repositories/` |
| Logs | `%LOCALAPPDATA%\IOFabrik\logs\` | `~/Library/Caches/IOFabrik/logs/` |
| Portable tools | `%LOCALAPPDATA%\IOFabrik\tools\bin\` | N/A |

On startup, `RunDataLayoutMigration()` migrates legacy `iofabrik` paths to canonical `IOFabrik` paths (non-destructive, one-time).

## Debug Logger — Ring-Buffer Logging

> Full details: [Debug Logger](../infrastructure/Debug%20Logger.md)

`services/debug_logger.go` provides a thread-safe, singleton ring-buffer logger:

- **Capacity:** 5,000 entries (circular buffer)
- **Categories:** `command`, `method`, `event`, `error`, `lifecycle`
- **Toggle:** Near-zero cost when disabled (`atomic.Bool`)
- **Redaction:** GitHub PATs and URL passwords automatically masked
- **Export:** JSON files in logs dir; auto-cleanup after 7 days
- **Live streaming:** New entries emitted via `debug:new-log` event

## Concurrency Patterns

Services use standard Go concurrency where it makes sense:

```go
// Parallel git config reads (SettingsService)
var wg sync.WaitGroup
wg.Add(2)
go func() { defer wg.Done(); localName = s.runner.RunGit(...) }()
go func() { defer wg.Done(); globalName = s.runner.RunGit(...) }()
wg.Wait()
```

**Rules:**
- Use `sync.WaitGroup` for parallel CLI calls
- Use `sync.Once` for one-time initialization (CLI resolver)
- Use `sync.Mutex` for shared mutable state (debug logger, file watcher)
- Use `atomic.Bool` for flags (debug toggle)
- Background goroutines (file watcher, background tasks) must be stoppable via context cancellation

## Error Handling

- **CLI failures:** Check `CommandResult.Success` → return `failedOp(result.Error)`
- **Parse errors:** Return meaningful message, not raw parse errors
- **Timeouts:** 30s default; configurable per-call via context
- **User-facing errors:** Must follow [User-Facing Terminology](../../product/User-Facing%20Terminology.md) guidelines

---

**Next:** [Services Index](Services%20Index.md) | [CommandRunner](../infrastructure/CommandRunner.md) | [CLI Resolver](../infrastructure/CLI%20Resolver.md) | [Data Paths](../infrastructure/Data%20Paths.md)
