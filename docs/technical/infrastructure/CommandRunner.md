# CommandRunner

> `services/runner.go` — ~422 lines. The universal CLI execution engine used by every service.

## Overview

CommandRunner is the single point of CLI execution in IOFabrik. Every call to `git`, `gh`, `git-lfs`, or any external binary goes through this layer. It centralizes timeout management, environment sanitization, debug logging, and platform-specific behavior.

## Constructor

```go
func NewCommandRunner() *CommandRunner {
    return &CommandRunner{
        Timeout: 30 * time.Second,
    }
}
```

Each service creates its own `CommandRunner` instance, but they all share the same behavior.

## Methods

### Standard Execution
```go
// Run any CLI command with default 30s timeout
func (r *CommandRunner) Run(workDir, name string, args ...string) CommandResult

// Run with custom context (for longer operations like auth flows)
func (r *CommandRunner) RunWithContext(ctx context.Context, workDir, name string, args ...string) CommandResult

// Run with stdin injection (e.g., passphrase entry)
func (r *CommandRunner) RunWithStdin(workDir, stdinInput, name string, args ...string) CommandResult
```

### Git-Specific
```go
// Run git command using resolved git binary path
func (r *CommandRunner) RunGit(repoPath string, args ...string) CommandResult

// Run GitHub CLI using resolved gh binary path
func (r *CommandRunner) RunGh(workDir string, args ...string) CommandResult

// Run git command returning raw bytes (for binary content: images, PDFs)
func (r *CommandRunner) RunGitRaw(repoPath string, args ...string) ([]byte, error)
```

## CommandResult

```go
type CommandResult struct {
    Stdout   string `json:"stdout"`
    Stderr   string `json:"stderr"`
    ExitCode int    `json:"exitCode"`
    Success  bool   `json:"success"`
    Error    string `json:"error"`
}
```

- `Success` is `true` when exit code is 0
- `Error` contains stderr content or timeout/exec failure message
- `Stdout` and `Stderr` are trimmed of trailing whitespace

## Environment Sanitization

Before every command execution, CommandRunner applies environment overrides:

```go
// Force non-interactive git operations
env["GIT_TERMINAL_PROMPT"] = "0"
env["GCM_INTERACTIVE"] = "never"
env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
```

### Windows-Specific

On Windows, the runner also:
- **Removes `ASKPASS` variables** — IDE-injected ASKPASS handlers break credential helpers
- **Hides console windows** — `SysProcAttr = hideWindowAttr()` prevents command prompt flash
- **Sanitizes PATH** — Ensures portable tool paths are prioritized

Variables removed: `GIT_ASKPASS`, `SSH_ASKPASS`, `VSCODE_GIT_ASKPASS_*`, `ELECTRON_RUN_AS_NODE`

## Debug Logging

When debug logging is enabled ([Debug Logger](Debug%20Logger.md)), every command execution is logged:

```go
logger.LogCommand("CommandRunner", LogDetails{
    Command:  name,
    Args:     args,
    Stdout:   truncate(result.Stdout, 2048),
    Stderr:   truncate(result.Stderr, 2048),
    ExitCode: result.ExitCode,
    Duration: elapsed.Milliseconds(),
})
```

Output is truncated to 2,048 characters to prevent log bloat.

## Timeout Behavior

- **Default:** 30 seconds
- **Override:** Use `RunWithContext()` with a custom deadline
- **On timeout:** Returns `CommandResult{Success: false, Error: "command timed out after 30s"}`

Some operations need longer timeouts:
- GitHub device auth flow: 5+ minutes
- Clone of large repos: configurable
- LFS fetch: configurable

## Binary Path Resolution

`RunGit()` and `RunGh()` use the [CLI Resolver](CLI%20Resolver.md) to find the correct binary:

```go
func (r *CommandRunner) RunGit(repoPath string, args ...string) CommandResult {
    gitPath := GitPath()  // Resolved via cli_resolver.go
    return r.Run(repoPath, gitPath, args...)
}
```

---

**Related:** [CLI Resolver](CLI%20Resolver.md) | [Debug Logger](Debug%20Logger.md) | [Backend Architecture](../backend/Backend%20Architecture.md)
