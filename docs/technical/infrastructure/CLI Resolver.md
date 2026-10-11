# CLI Resolver

> `services/cli_resolver.go` — Binary path resolution with caching.

## Overview

CLI Resolver finds the correct paths for `git`, `gh` (GitHub CLI), and `git-lfs` binaries. It searches in priority order and caches results using `sync.Once` for zero-overhead subsequent calls.

## Resolution Priority

```
1. Platform-local managed binaries
   └── Windows: %LOCALAPPDATA%\IOFabrik\tools\bin\git.exe
   └── macOS: N/A

2. Bundled app resources
   └── macOS: .app/Contents/Resources/git/bin/git
   └── macOS: .app/Contents/Resources/gh/bin/gh
   └── Windows: N/A (uses portable tools instead)

3. System PATH
   └── exec.LookPath("git")

4. Common install paths (Windows fallback)
   └── C:\Program Files\Git\bin\git.exe
   └── %USERPROFILE%\scoop\shims\git.exe
   └── C:\Program Files\GitHub CLI\gh.exe

5. Bare command fallback
   └── "git" — lets OS do final lookup
```

## Functions

```go
func GitPath() string   // Returns resolved git path or "git"
func GhPath() string    // Returns resolved gh path or "gh"
func LfsPath() string   // Returns resolved git-lfs path or "git-lfs"

func RefreshCLIPaths()  // Clear cache — call after installing new tools
```

## Caching

Each resolver uses `sync.Once` so the filesystem search happens exactly once per app lifecycle:

```go
var gitOnce sync.Once
var gitPath string

func GitPath() string {
    gitOnce.Do(func() {
        gitPath = resolveGit()  // Searches priority order
    })
    return gitPath
}
```

Call `RefreshCLIPaths()` to reset the cache — used by [LocalBinService](../backend/services/Other%20Services.md#localbinservice) after downloading portable tools.

## When to Call RefreshCLIPaths

- After [LocalBinService](../backend/services/Other%20Services.md#localbinservice) downloads portable tools (Windows)
- After user manually installs git/gh and reports it's not detected
- Never called during normal operation

## Debugging

When a binary isn't found or the wrong version is used, check:
1. Debug logs → search for `"CommandRunner"` category
2. `RepositorySettingsService.RunDiagnostics()` → reports git/gh/lfs versions
3. `GetGitVersion()`, `GetLFSVersion()` → version strings

---

**Related:** [CommandRunner](CommandRunner.md) | [LocalBinService](../backend/services/Other%20Services.md#localbinservice) | [Data Paths](Data%20Paths.md)
