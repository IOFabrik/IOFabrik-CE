# Event System

> Backend → Frontend communication via Wails events.

## Overview

IOFabrik uses Wails' event system for asynchronous communication from the Go backend to the React frontend. Events are one-directional (backend → frontend) and typed.

## Event Catalog

| Event Name | Direction | Payload | Emitter | Purpose |
|------------|-----------|---------|---------|---------|
| `folder-selected` | Backend → Frontend | `string` (path) | `main.go` (File menu) | User opened a repo via File menu |
| `folder-closed` | Backend → Frontend | `string` | `main.go` (File menu) | User closed current repo |
| `file-changes` | Backend → Frontend | `[]FileChangeEvent` | [FileWatcherService](../backend/services/FileWatcherService.md) | Filesystem changes detected |
| `git-progress` | Backend → Frontend | `GitProgress` | [ProgressService](../backend/services/ProgressService.md) | Git operation progress update |
| `local-bin:progress` | Backend → Frontend | `LocalBinProgress` | [LocalBinService](../backend/services/Other%20Services.md#localbinservice) | Portable tool download progress |
| `file:reveal-in-finder` | Backend → Frontend | — | `main.go` (File menu) | File menu action |
| `file:open-in-terminal` | Backend → Frontend | — | `main.go` (File menu) | File menu action |
| `background-task-completed` | Backend → Frontend | `BackgroundTaskStatus` | [RepositorySettingsService](../backend/services/RepositorySettingsService.md) | Background task finished |
| `debug:new-log` | Backend → Frontend | `LogEntry` | [Debug Logger](../infrastructure/Debug%20Logger.md) | New debug log entry |

## Event Registration

Events are registered in `main.go` for type safety:

```go
application.RegisterEvent[string]("folder-selected", "folder-closed",
    "file:reveal-in-finder", "file:open-in-terminal")
application.RegisterEvent[services.LocalBinProgress]("local-bin:progress")
```

## Emitting Events (Backend)

Services with `SetApp()` can emit events:

```go
func (s *FileWatcherService) SetApp(app *application.App) {
    s.app = app
}

// Later, in a goroutine:
s.app.Event.Emit("file-changes", batchEvents)
```

## Subscribing to Events (Frontend)

```tsx
import { Events } from '@wailsio/runtime';

useEffect(() => {
    const unsubscribe = Events.On("file-changes", (event) => {
        // Handle filesystem changes
        refreshStatus();
    });
    return () => unsubscribe();
}, []);
```

## Event Flow Diagrams

### File Change Detection
```
User edits file in external editor
  → fsnotify detects change
  → FileWatcherService batches (300ms debounce)
  → Emit "file-changes" event
  → RepoContext receives event
  → Triggers git status refresh
  → UI updates (file list, status indicators)
```

### Git Progress Streaming
```
User clicks "Sync"
  → Frontend calls ProgressService.SyncWithProgress()
  → ProgressService spawns git with --progress flag
  → Reads stderr line by line
  → Parses progress format (regex)
  → Emits "git-progress" event per update
  → Frontend updates ProgressModal
  → On completion: emits final "git-progress" with done=true
  → ProgressModal auto-dismisses
```

### Portable Tool Installation (Windows)
```
App starts on Windows without git
  → LocalBinService.EnsurePortableToolchainIfNeeded()
  → Downloads MinGit, gh, git-lfs
  → Emits "local-bin:progress" per tool
  → Frontend shows download progress banner
  → On complete: RefreshCLIPaths()
  → App ready for git operations
```

## Guidelines

- **Never poll** when an event exists — use events as the primary mechanism
- **Batch events** to avoid flooding the frontend (see FileWatcherService's 300ms debounce)
- **Always emit typed payloads** — register event types in `main.go`
- The 30-second polling in RepoContext is a **fallback**, not the primary sync mechanism

---

**Related:** [State Management](State%20Management.md) | [FileWatcherService](../backend/services/FileWatcherService.md) | [ProgressService](../backend/services/ProgressService.md) | [Context Providers](../frontend/Context%20Providers.md)
