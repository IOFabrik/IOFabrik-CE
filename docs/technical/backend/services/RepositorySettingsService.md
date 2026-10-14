# RepositorySettingsService

> `services/repository_settings_service.go` — ~1,578 lines. Per-repository configuration, background tasks, diagnostics, and recovery tools.

## Overview

RepositorySettingsService manages per-repo settings (separate from app-wide [SettingsService](SettingsService.md)), runs background maintenance tasks, provides diagnostic tools, and offers recovery mechanisms for stuck git states.

## Constructor

```go
func NewRepositorySettingsService() *RepositorySettingsService {
    locations := GetDataLocationsSnapshot()
    return &RepositorySettingsService{
        runner:      NewCommandRunner(),
        settingsDir: locations.RepositorySettingsDir,
    }
}
```

Requires `SetApp()` for event emission (`background-task-completed`).

## Repository Settings

Each repo gets its own settings file, identified by a unique ID derived from the repo path:

```go
// Repo ID = first 16 hex chars of SHA-256(repoPath)
func generateRepoID(repoPath string) string {
    hash := sha256.Sum256([]byte(repoPath))
    return hex.EncodeToString(hash[:8])
}
```

Settings stored at: `<config>/repositories/<repoID>.json`

### RepositorySettings Structure

```go
type RepositorySettings struct {
    RepoPath  string
    RepoID    string
    
    // Background task configs
    FetchTask       BackgroundTaskConfig  // Default: enabled, 5-min interval
    LFSFetchTask    BackgroundTaskConfig  // Default: enabled, 10-min interval
    MaintenanceTask BackgroundTaskConfig  // Default: enabled, 30-min interval
    
    // Detailed settings
    FetchSettings       FetchSettings       // FetchAllRemotes, PruneStaleBranches, FetchTags
    LFSSettings         LFSSettings         // AutoFetch, AutoPrune, retention days
    MaintenanceSettings MaintenanceSettings // CommitGraph, PackRefs, LooseObjects
    
    LocalOnlyMode bool
    CreatedAt, UpdatedAt time.Time
}
```

## Background Tasks

Three types of background tasks run automatically per-repo:

| Task | Default Interval | Git Command | Purpose |
|------|-----------------|-------------|---------|
| `TaskFetchAll` | 5 min | `git fetch --all --prune --tags` | Keep remote refs up to date |
| `TaskLFSFetch` | 10 min | `git lfs fetch --recent` | Pre-download recent LFS objects |
| `TaskMaintenance` | 30 min | `git maintenance run` | Pack refs, commit graph, loose objects |

### Task Lifecycle

```
Repo opened → LoadOrCreateSettings()
  → StartBackgroundTasks()
    → For each enabled task:
      → Start goroutine with ticker at configured interval
      → On tick: execute git command, update BackgroundTaskStatus
      → Emit "background-task-completed" event
Repo closed → StopBackgroundTasks()
```

### Task Status Tracking

```go
type BackgroundTaskStatus struct {
    TaskType   BackgroundTaskType
    IsRunning  bool
    LastRun    *time.Time
    LastResult *OperationResult
    NextRun    *time.Time
    RunCount   int
    ErrorCount int
}
```

## In-Repo Config Files

Settings that should be shared with collaborators are stored inside the repo:

```
.iofabrik/
├── config.json    ← Shared (committed): CreatedAt, CreatedBy, AppVersion
└── local.json     ← Personal (gitignored): LocalOnlyMode, DefaultBranch
```

Reads fall back to `.controlzebra/config.json` and `.controlzebra/local.json`
when the corresponding IOFabrik file is absent. Existing IOFabrik files take
precedence. Writes use `.iofabrik/` and add `.iofabrik/local.json` and
`.iofabrik/personal-*.tmp` to `.gitignore` before creating personal files. This
also protects atomic-write temporary files from a simultaneous Save.
The legacy shared files remain available for older clients.

## Project Default Branch

Repository Settings always shows the effective default and its Automatic or Manual
selection mode. **Choose default branch** opens the shared chooser. A manual
selection is saved only after the separate confirmation:

> Changing the default branch is a dangerous action. Are you sure you want to continue?

The preference changes IOFabrik's project default; it does not switch the active
branch or change GitHub's default. **Use GitHub default** restores automatic mode
only when a usable automatic result is available. Cancellation and failed writes
retain the previous preference.

`services/project_default_branch.go` extends this service with:

| Method | Behavior |
| --- | --- |
| `GetProjectDefaultBranch` | Validate the stored selection using local branch/ref availability; no network request. |
| `RefreshProjectDefaultBranch` | Discover the GitHub default for the repository explicitly identified by `origin`, then persist the successful result. |
| `SetProjectDefaultBranch` | Store an exact manual branch choice after UI confirmation. |
| `UseGitHubDefault` | Refresh discovery and restore automatic mode if the automatic result is usable. |

`ProjectDefaultBranchResult` exposes `effectiveBranch`, `mode`, `availability`,
`originRepository`, lookup diagnostics, and available chooser branches. Consumers
check `availability` (`ready` or `needs-selection`) independently of lookup status.
A stored branch can remain ready offline if its local branch or origin-tracking
ref exists. No conventional branch names or other remotes determine identity.
Branch names preserve case. Every discovery outcome revalidates the current
origin and local refs before returning readiness, including failed lookups and
missing metadata. A connection or branch change during discovery cannot retain
the previous identity as ready.

The personal `DefaultBranch` preference in `.iofabrik/local.json` contains the
manual override, the last successful automatic branch and origin identity, and
the explicitly initialized local branch. Writes replace the file atomically and
preserve unrelated personal settings. Changed origins cannot reuse an automatic
result from another origin. Manual overrides survive restart and discovery, but
a deleted selection requires another choice. Imported local/non-GitHub projects
require a selection; app-created local projects record their initial branch,
which is usable before the first Save.

The existing `RepoContext` owns the shared state and chooser. Discovery runs on
project open and explicit refresh. Normal data refresh and action readiness use
local validation. `ensureProjectDefaultBranch()` resolves a usable branch or
opens the same chooser, returning the confirmed branch or `null` on cancellation.
Project sessions reject stale responses and cancel an old project's pending
chooser when switching projects.

The other workflow slices of issue #103 migrate Save, Merge/Update, Sync, branch
safeguards, Change Requests, and History to this contract separately.

## Diagnostics

| Method | Purpose |
|--------|---------|
| `RunDiagnostics(repoPath)` | Comprehensive repo health check |
| `GetRepoSize(repoPath)` | Total size of repo + LFS objects |
| `GetGitVersion()` | Git CLI version |
| `GetLFSVersion()` | git-lfs CLI version |
| `CheckRemoteConnectivity(repoPath)` | Test connection to remote |

## Recovery Tools

| Method | Purpose |
|--------|---------|
| `RepairRepo(repoPath)` | Run `git fsck` + `git gc` |
| `ResetToRemote(repoPath, branch)` | Hard reset to `origin/<branch>` |
| `CleanupLocks(repoPath)` | Remove stale lock files |

## Gitignore Templates

| Method | Purpose |
|--------|---------|
| `GetGitignoreTemplates()` | List available `.gitignore` templates |
| `ApplyGitignoreTemplate(repoPath, templateID)` | Apply template to repo |
| `GetCurrentGitignore(repoPath)` | Read current `.gitignore` |
| `UpdateGitignore(repoPath, content)` | Write new `.gitignore` content |

---

**Related:** [SettingsService](SettingsService.md) (app-wide) | [GitService](GitService.md) | [FileWatcherService](FileWatcherService.md)
