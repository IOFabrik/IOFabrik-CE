# Remaining Services

> Smaller services that don't warrant individual pages.

## ImageDiffService

`services/image_diff_service.go` — ~327 lines

Performs pixel-level image comparison between git revisions. Used by the [ImageDiffViewer](../../frontend/Viewer%20System.md).

| Method | Purpose |
|--------|---------|
| `CompareImages(repoPath, filePath, oldRef, newRef)` | Generate pixel diff between two revisions |
| `GetImageAtRef(repoPath, filePath, ref)` | Get base64-encoded image at a specific git ref |

Uses the `imgdiff` Go library for pixel comparison. Returns diff image as base64 PNG with highlighted changes.

## FileDialogService

`services/file_dialog_service.go` — ~67 lines

Native OS folder picker dialog. Wails v3 provides this API.

| Method | Purpose |
|--------|---------|
| `OpenDirectoryDialog(title)` | Show native folder picker, return selected path |

## AuthService

`services/auth_service.go` — ~95 lines

Supabase session persistence via OS keychain. **This is separate from GitHub auth** (which uses [GitHubService](GitHubService.md)).

```go
const (
    keyringService = "com.iofabrik.desktop"
    keyringUser    = "supabase-session"
)
```

| Method | Purpose |
|--------|---------|
| `SaveSession(sessionJSON)` | Store serialized Supabase session in OS keychain |
| `LoadSession()` | Retrieve session from keychain |
| `ClearSession()` | Delete session from keychain |

**Platform support** via `go-keyring`:
- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / libsecret

## DebugService

`services/debug_service.go` — ~67 lines

Frontend facade for the [Debug Logger](../../infrastructure/Debug%20Logger.md) singleton.

| Method | Purpose |
|--------|---------|
| `IsEnabled()` | Check if debug logging is active |
| `SetEnabled(enabled)` | Toggle debug logging |
| `GetLogs(limit)` | Get recent log entries |
| `ExportLogs()` | Export to timestamped JSON file |
| `ClearLogs()` | Clear ring buffer |

Requires `SetApp()` to emit `debug:new-log` events for live log streaming.

## LocalBinService

`services/local_bin_service.go` — ~505 lines

**Windows only.** Downloads and manages portable CLI tools for users who don't have git installed.

### Portable Tools

| Tool | Version | Source |
|------|---------|--------|
| MinGit | 2.48.1 | GitHub releases |
| gh (GitHub CLI) | 2.71.2 | GitHub releases |
| git-lfs | 3.7.1 | GitHub releases |

### Key Methods

| Method | Purpose |
|--------|---------|
| `EnsurePortableToolchainIfNeeded()` | Check if tools needed, download if missing |
| `GetToolchainStatus()` | Report installed/missing tools |
| `DownloadTool(toolName)` | Download specific tool |

### Progress Event

Emits `local-bin:progress` with download progress:

```go
type LocalBinProgress struct {
    Tool    string  `json:"tool"`     // "git", "gh", "git-lfs"
    Phase   string  `json:"phase"`    // "downloading", "extracting", "complete"
    Percent int     `json:"percent"`  // 0-100
    Error   string  `json:"error"`
}
```

### BusyBox Detection

Detects BusyBox MinGit (which breaks Windows credential helpers) and replaces it with regular MinGit. Configurable download URLs via env vars:
- `IOFABRIK_PORTABLE_GIT_URL`
- `IOFABRIK_PORTABLE_GH_URL`
- `IOFABRIK_PORTABLE_LFS_URL`

After installation, calls `RefreshCLIPaths()` on the [CLI Resolver](../../infrastructure/CLI%20Resolver.md) to pick up new binaries.

---

**Related:** [Services Index](../Services%20Index.md) | [Backend Architecture](../Backend%20Architecture.md)
