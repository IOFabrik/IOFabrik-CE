# Data Paths

> `services/data_paths.go` — Platform-specific storage layout with legacy migration.

## Overview

Application settings use the OS config directory on macOS and Linux. Windows settings and other machine data share `%LOCALAPPDATA%\IOFabrik`. On startup, migration recovers data from the previous `ControlZebra` and older `control-zebra` layouts.

## DataLocations Structure

```go
type DataLocations struct {
    RoamingConfigDir       string  // Settings, repo config
    SettingsFile           string  // settings.json
    RepositorySettingsDir  string  // Per-repo settings by hash
    LocalDataDir           string  // Logs, cache, tools
    LogsDir                string  // Debug logs
    CacheDir               string  // Build artifacts
    ToolsBinDir            string  // Portable binaries (Windows only)
    WebView2Dir            string  // WebView2 runtime (Windows)
    MigrationMarkerFile    string  // data-layout-v3.json
}
```

## Platform Paths

### Windows

| Data | Path |
|------|------|
| Roaming Config | `%LOCALAPPDATA%\IOFabrik\config\` |
| Settings File | `%LOCALAPPDATA%\IOFabrik\config\settings.json` |
| Repo Settings | `%LOCALAPPDATA%\IOFabrik\config\repositories\<repoID>.json` |
| Local Data | `%LOCALAPPDATA%\IOFabrik\` |
| Logs | `%LOCALAPPDATA%\IOFabrik\logs\` |
| Portable Tools | `%LOCALAPPDATA%\IOFabrik\tools\bin\` |
| WebView2 | `%LOCALAPPDATA%\IOFabrik\webview2\` |

### macOS

| Data | Path |
|------|------|
| Roaming Config | `~/Library/Application Support/IOFabrik/config/` |
| Settings File | `~/Library/Application Support/IOFabrik/config/settings.json` |
| Repo Settings | `~/Library/Application Support/IOFabrik/config/repositories/<repoID>.json` |
| Local Data | `~/Library/Caches/IOFabrik/` |
| Logs | `~/Library/Caches/IOFabrik/logs/` |
| Portable Tools | N/A (uses system binaries) |

## Data Layout Migration

On startup, `RunDataLayoutMigration()` checks for `data-layout-v3.json`.
If it is absent, migration moves settings, logs, cache, browser profiles, and
review-session records into the IOFabrik directories. Current destination files
take precedence. The marker is written only after migration succeeds.

Windows sources include `%LOCALAPPDATA%\ControlZebra`,
`%APPDATA%\ControlZebra\config`, and `%APPDATA%\control-zebra`.
macOS sources include `~/Library/Application Support/ControlZebra/config`
and `~/Library/Caches/ControlZebra`. Older `control-zebra` config and log
locations are also checked. Linux uses its OS config and cache directories,
including the `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` overrides.

Existing review workspaces remain in the previous `ControlZebra/integration/workspaces`
directory because their records and Git worktree registrations contain absolute
paths. The new app accepts their legacy ownership markers and cleans up both
old and new result refs. New reviews use IOFabrik paths and identifiers.
Portable tools migrate only when the new location has no managed bundle manifest.

## Per-Repo Settings Location

Each repository gets a unique directory based on its path hash:

```go
repoID := sha256(repoPath)[:16]  // First 16 hex chars
settingsPath := filepath.Join(RepositorySettingsDir, repoID+".json")
```

Moving or renaming the repository changes its path hash and therefore its settings filename.

## Access Pattern

Always use `GetDataLocationsSnapshot()` to get current paths:

```go
locations := GetDataLocationsSnapshot()
settingsFile := locations.SettingsFile
```

Never hardcode paths or construct them manually.

---

**Related:** [SettingsService](../backend/services/SettingsService.md) | [RepositorySettingsService](../backend/services/RepositorySettingsService.md) | [Backend Architecture](../backend/Backend%20Architecture.md)
