# Data Storage Reference

> Platform-specific data paths managed by [[Data Paths|`services/data_paths.go`]].

## Path Layout

| Data Class | Windows | macOS |
|---|---|---|
| **Config** | `%LOCALAPPDATA%\IOFabrik\config\` | `~/Library/Application Support/IOFabrik/config/` |
| **Settings file** | `…\config\settings.json` | `…/config/settings.json` |
| **Repo settings** | `…\config\repositories\<hash>.json` | `…/config/repositories/<hash>.json` |
| **Local data** | `%LOCALAPPDATA%\IOFabrik\` | `~/Library/Caches/IOFabrik/` |
| **Logs** | `…\IOFabrik\logs\` | `…/IOFabrik/logs/` |
| **Portable tools** | `…\IOFabrik\tools\bin\` | N/A (uses system) |

## settings.json

Managed by [SettingsService](../backend/services/SettingsService.md):

```json
{
    "theme": "system",          // "light" | "dark" | "system"
    "lastOpenedFolder": "/path/to/repo",
    "recentFolders": ["/path/to/repo1", "/path/to/repo2"],
    "analyticsEnabled": true
}
```

## Repository Settings

Per-repo configuration managed by [RepositorySettingsService](../backend/services/RepositorySettingsService.md), stored in `repositories/<first-16-hex-characters-of-sha256-of-path>.json`:

```json
{
    "repoPath": "/Users/dev/my-project",
    "protectedBranches": ["main", "release"],
    "protectedBranchAction": "warn",
    "autoFetchEnabled": true,
    "autoFetchIntervalMinutes": 5,
    "lfsFetchEnabled": true,
    "lfsFetchIntervalMinutes": 10,
    "maintenanceEnabled": true,
    "maintenanceIntervalMinutes": 30,
    "defaultMergeType": "squash",
    "commitMessageTemplate": ""
}
```

## Hash Calculation

Repo settings filenames use SHA-256 hash of the absolute repo path:

```go
func hashRepoPath(repoPath string) string {
    h := sha256.Sum256([]byte(repoPath))
    return hex.EncodeToString(h[:8])
}
// "/Users/dev/my-project" → "a3f8c1d2...json"
```

## Legacy Migration

Migration recovers the previous `ControlZebra` and older `control-zebra` data
layouts. Current IOFabrik files take precedence. The version 3 marker prevents
repeat migration after success. Registered review workspaces stay at their
original paths until the reviews finish or are cancelled.
See [Data Paths](../infrastructure/Data%20Paths.md) for migration sources.

Project config now uses `.iofabrik/config.json` and `.iofabrik/local.json`.
Reads fall back to the corresponding `.controlzebra` file if the new file is
absent; writes use the new directory.

## Keychain Storage

The [AuthService](../backend/services/Other%20Services.md#authservice) stores the Supabase session token in the OS keychain:

| Platform | Keychain |
|---|---|
| macOS | Keychain Access (via `go-keyring`) |
| Windows | Windows Credential Manager |

**Service name:** `com.iofabrik.desktop`
**Key:** `supabase-session`

If the new credential is absent, AuthService recovers and promotes the session
from `com.controlzebra.desktop`. Signing out clears both service names.

---

**Related:** [Data Paths](../infrastructure/Data%20Paths.md) | [SettingsService](../backend/services/SettingsService.md) | [RepositorySettingsService](../backend/services/RepositorySettingsService.md) | [Environment Variables](Environment%20Variables.md)
