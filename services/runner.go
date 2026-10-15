package services

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// CommandResult holds the output and status of a command execution
type CommandResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
	Success  bool   `json:"success"`
	Error    string `json:"error,omitempty"`
}

// CommandRunner executes shell commands with working directory support
type CommandRunner struct {
	Timeout      time.Duration
	credentials  *gitCredentialProfile
	previewOwner bool
}

// NewCommandRunner creates a new CommandRunner with default timeout
func NewCommandRunner() *CommandRunner {
	return &CommandRunner{
		Timeout: 30 * time.Second,
	}
}

// runWithStderr streams a long-lived command's stderr to its caller. It waits
// exactly once, including after cancellation, and bounds waits on inherited
// pipes. The caller owns output parsing and redacted diagnostic logging.
func (r *CommandRunner) runWithStderr(ctx context.Context, stderr io.Writer, name string, args ...string) CommandResult {
	return r.runWithWriters(ctx, "", io.Discard, stderr, name, args...)
}

func (r *CommandRunner) prepare(ctx context.Context, workDir, name string, args []string) *exec.Cmd {
	if r.credentials != nil && (name == GitPath() || name == "git") {
		args = r.credentials.gitArgs(args)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = workDir
	cmd.SysProcAttr = hideWindowAttr()
	cmd.Env = buildCommandEnv(name)
	// Status queries may run during generation, but must not refresh the index
	// behind the exclusive publication lease. Required mutation locks are
	// unaffected by disabling Git's optional locks.
	if r.previewOwner || name == GitPath() || name == "git" {
		cmd.Env = setEnvCaseInsensitive(cmd.Env, "GIT_OPTIONAL_LOCKS", "0")
	}
	return cmd
}

// runWithWriters keeps caller-owned parsing and logging, and bounds waits on
// inherited pipes after cancellation. The supplied context owns the timeout.
func (r *CommandRunner) runWithWriters(ctx context.Context, workDir string, stdout, stderr io.Writer, name string, args ...string) CommandResult {
	release, guardErr := r.previewCommandLease(workDir, name, args)
	if guardErr != nil {
		return CommandResult{ExitCode: -1, Error: guardErr.Error(), Stderr: guardErr.Error()}
	}
	defer release()
	cmd := r.prepare(ctx, workDir, name, args)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	result := CommandResult{Success: err == nil}
	if err != nil {
		result.Error = err.Error()
		if ctx.Err() != nil {
			result.Error = ctx.Err().Error()
		}
		result.ExitCode = -1
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		}
	}
	return result
}

// Run executes a command in the specified working directory
func (r *CommandRunner) Run(workDir string, name string, args ...string) CommandResult {
	ctx, cancel := context.WithTimeout(context.Background(), r.Timeout)
	defer cancel()

	return r.RunWithContext(ctx, workDir, name, args...)
}

// RunWithContext executes a command with a custom context
func (r *CommandRunner) RunWithContext(ctx context.Context, workDir string, name string, args ...string) CommandResult {
	release, guardErr := r.previewCommandLease(workDir, name, args)
	if guardErr != nil {
		return CommandResult{ExitCode: -1, Error: guardErr.Error(), Stderr: guardErr.Error()}
	}
	defer release()
	logger := GetDebugLogger()
	start := time.Now()

	cmd := r.prepare(ctx, workDir, name, args)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	result := CommandResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: 0,
		Success:  true,
	}

	if err != nil {
		result.Success = false
		result.Error = err.Error()
		if ctx.Err() != nil {
			result.Error = ctx.Err().Error()
		}

		// Extract exit code if available
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
		}
	}

	// Debug logging
	if logger.IsEnabled() {
		duration := time.Since(start).Milliseconds()
		level := LogLevelInfo
		if !result.Success {
			level = LogLevelError
		}
		logger.Log(level, LogCategoryCommand, "CommandRunner.Run",
			fmt.Sprintf("%s %s → exit %d (%dms)", name, strings.Join(args, " "), result.ExitCode, duration),
			LogDetails{
				Command:  name,
				Args:     args,
				WorkDir:  workDir,
				ExitCode: result.ExitCode,
				Stdout:   truncate(result.Stdout, maxFieldLen),
				Stderr:   truncate(result.Stderr, maxFieldLen),
				Error:    result.Error,
			},
			duration,
		)
	}

	return result
}

// RunGit is a convenience method for running git commands.
// Uses the resolved git binary when available, otherwise falls back to PATH.
func (r *CommandRunner) RunGit(repoPath string, args ...string) CommandResult {
	return r.Run(repoPath, GitPath(), args...)
}

// RunGitRaw executes a git command and returns raw stdout bytes.
// Use for binary content (images, etc.) where string conversion corrupts data.
// Returns the raw bytes and any error encountered.
func (r *CommandRunner) RunGitRaw(repoPath string, args ...string) ([]byte, error) {
	release, guardErr := r.previewCommandLease(repoPath, GitPath(), args)
	if guardErr != nil {
		return nil, guardErr
	}
	defer release()
	logger := GetDebugLogger()
	start := time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), r.Timeout)
	defer cancel()

	cmd := r.prepare(ctx, repoPath, GitPath(), args)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	// Debug logging
	if logger.IsEnabled() {
		duration := time.Since(start).Milliseconds()
		level := LogLevelInfo
		exitCode := 0
		errStr := ""
		if err != nil {
			level = LogLevelError
			exitCode = -1
			errStr = err.Error()
		}
		logger.Log(level, LogCategoryCommand, "CommandRunner.RunGitRaw",
			fmt.Sprintf("git %s → exit %d (%dms)", strings.Join(args, " "), exitCode, duration),
			LogDetails{
				Command:  "git",
				Args:     args,
				WorkDir:  repoPath,
				ExitCode: exitCode,
				Stdout:   fmt.Sprintf("[%d bytes raw]", stdout.Len()),
				Stderr:   truncate(stderr.String(), maxFieldLen),
				Error:    errStr,
			},
			duration,
		)
	}

	if err != nil {
		errMsg := stderr.String()
		if errMsg == "" {
			errMsg = err.Error()
		}
		return nil, fmt.Errorf("git %v failed: %s", args, errMsg)
	}

	return stdout.Bytes(), nil
}

// RunGitWithStdin runs a git command with stdin input.
// Uses the resolved git binary when available, otherwise falls back to PATH.
func (r *CommandRunner) RunGitWithStdin(repoPath string, stdinInput string, args ...string) CommandResult {
	return r.RunWithStdin(repoPath, stdinInput, GitPath(), args...)
}

// RunGh is a convenience method for running gh CLI commands.
// Uses the resolved gh binary when available, otherwise falls back to PATH.
func (r *CommandRunner) RunGh(workDir string, args ...string) CommandResult {
	return r.Run(workDir, GhPath(), args...)
}

// MustRunGit runs a git command and returns an error if it fails
func (r *CommandRunner) MustRunGit(repoPath string, args ...string) (string, error) {
	result := r.RunGit(repoPath, args...)
	if !result.Success {
		errMsg := result.Stderr
		if errMsg == "" {
			errMsg = result.Error
		}
		return "", fmt.Errorf("git %v failed: %s", args, errMsg)
	}
	return result.Stdout, nil
}

// MustRunGh runs a gh CLI command and returns an error if it fails
func (r *CommandRunner) MustRunGh(workDir string, args ...string) (string, error) {
	result := r.RunGh(workDir, args...)
	if !result.Success {
		errMsg := result.Stderr
		if errMsg == "" {
			errMsg = result.Error
		}
		return "", fmt.Errorf("gh %v failed: %s", args, errMsg)
	}
	return result.Stdout, nil
}

// RunWithStdin executes a command with provided stdin input
func (r *CommandRunner) RunWithStdin(workDir string, stdinInput string, name string, args ...string) CommandResult {
	ctx, cancel := context.WithTimeout(context.Background(), r.Timeout)
	defer cancel()

	return r.RunWithContextAndStdin(ctx, workDir, stdinInput, name, args...)
}

// RunWithContextAndStdin executes a command with a custom context and stdin input
func (r *CommandRunner) RunWithContextAndStdin(ctx context.Context, workDir string, stdinInput string, name string, args ...string) CommandResult {
	release, guardErr := r.previewCommandLease(workDir, name, args)
	if guardErr != nil {
		return CommandResult{ExitCode: -1, Error: guardErr.Error(), Stderr: guardErr.Error()}
	}
	defer release()
	logger := GetDebugLogger()
	start := time.Now()

	cmd := r.prepare(ctx, workDir, name, args)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = bytes.NewBufferString(stdinInput)

	err := cmd.Run()

	result := CommandResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: 0,
		Success:  true,
	}

	if err != nil {
		result.Success = false
		result.Error = err.Error()
		if ctx.Err() != nil {
			result.Error = ctx.Err().Error()
		}

		// Extract exit code if available
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
		}
	}

	// Debug logging
	if logger.IsEnabled() {
		duration := time.Since(start).Milliseconds()
		level := LogLevelInfo
		if !result.Success {
			level = LogLevelError
		}
		logger.Log(level, LogCategoryCommand, "CommandRunner.RunWithStdin",
			fmt.Sprintf("%s %s → exit %d (%dms)", name, strings.Join(args, " "), result.ExitCode, duration),
			LogDetails{
				Command:  name,
				Args:     args,
				WorkDir:  workDir,
				ExitCode: result.ExitCode,
				Stdout:   truncate(result.Stdout, maxFieldLen),
				Stderr:   truncate(result.Stderr, maxFieldLen),
				Error:    result.Error,
			},
			duration,
		)
	}

	return result
}

func buildCommandEnv(commandPath string) []string {
	env := os.Environ()
	if runtime.GOOS != "windows" {
		return env
	}

	// GUI app child processes can inherit IDE/shell askpass variables that point
	// to scripts unavailable in our packaged Windows runtime (for example, bash-
	// based prompt scripts referencing /dev/tty). Remove those to prevent cryptic
	// auth failures such as "failed to execute prompt script".
	env = normalizeWindowsPromptEnv(env)

	prependDirs := make([]string, 0, 6)
	seen := map[string]struct{}{}

	addDir := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		key := strings.ToLower(dir)
		if _, exists := seen[key]; exists {
			return
		}
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			seen[key] = struct{}{}
			prependDirs = append(prependDirs, dir)
		}
	}

	// Keep the command's own directory at the front when available.
	if filepath.IsAbs(commandPath) {
		addDir(filepath.Dir(commandPath))
	}

	// Always prioritize managed user-level portable tool directories.
	for _, dir := range localManagedPathPrepends() {
		addDir(dir)
	}

	// Ensure resolved git is discoverable for tools (like gh) that shell out to "git".
	gitPath := GitPath()
	if filepath.IsAbs(gitPath) {
		gitDir := filepath.Dir(gitPath)
		addDir(gitDir)

		// Typical bundled layout:
		//   <install>/git/cmd/git.exe
		//   <install>/git/mingw64/bin/*.dll
		if strings.EqualFold(filepath.Base(gitDir), "cmd") || strings.EqualFold(filepath.Base(gitDir), "bin") {
			gitRoot := filepath.Dir(gitDir)
			addDir(filepath.Join(gitRoot, "mingw64", "bin"))
			addDir(filepath.Join(gitRoot, "clangarm64", "bin"))
			addDir(filepath.Join(gitRoot, "usr", "bin"))
		}
	}

	ghPath := GhPath()
	if filepath.IsAbs(ghPath) {
		addDir(filepath.Dir(ghPath))
	}

	lfsPath := LfsPath()
	if filepath.IsAbs(lfsPath) {
		addDir(filepath.Dir(lfsPath))
	}

	if len(prependDirs) == 0 {
		return env
	}

	pathKey := "Path"
	pathValue := ""
	pathIdx := -1
	for i, kv := range env {
		if idx := strings.IndexByte(kv, '='); idx > 0 {
			key := kv[:idx]
			if strings.EqualFold(key, "Path") {
				pathKey = key
				pathValue = kv[idx+1:]
				pathIdx = i
				break
			}
		}
	}

	newPath := strings.Join(prependDirs, ";")
	if strings.TrimSpace(pathValue) != "" {
		newPath += ";" + pathValue
	}

	newEntry := pathKey + "=" + newPath
	if pathIdx >= 0 {
		env[pathIdx] = newEntry
	} else {
		env = append(env, newEntry)
	}

	return env
}

func normalizeWindowsPromptEnv(env []string) []string {
	for _, key := range []string{
		"GIT_ASKPASS",
		"SSH_ASKPASS",
		"VSCODE_GIT_ASKPASS_MAIN",
		"VSCODE_GIT_ASKPASS_NODE",
		"VSCODE_GIT_ASKPASS_EXTRA_ARGS",
	} {
		env = removeEnvCaseInsensitive(env, key)
	}

	// Force non-interactive credential behavior for background CLI calls.
	env = setEnvCaseInsensitive(env, "GIT_TERMINAL_PROMPT", "0")
	env = setEnvCaseInsensitive(env, "GCM_INTERACTIVE", "never")
	env = setEnvCaseInsensitive(env, "GIT_SSH_COMMAND", "ssh -o BatchMode=yes")

	return env
}

func removeEnvCaseInsensitive(env []string, key string) []string {
	filtered := env[:0]
	for _, kv := range env {
		idx := strings.IndexByte(kv, '=')
		if idx <= 0 {
			filtered = append(filtered, kv)
			continue
		}
		k := kv[:idx]
		if strings.EqualFold(k, key) {
			continue
		}
		filtered = append(filtered, kv)
	}
	return filtered
}

func setEnvCaseInsensitive(env []string, key string, value string) []string {
	entry := key + "=" + value
	for i, kv := range env {
		idx := strings.IndexByte(kv, '=')
		if idx <= 0 {
			continue
		}
		k := kv[:idx]
		if strings.EqualFold(k, key) {
			env[i] = k + "=" + value
			return env
		}
	}
	return append(env, entry)
}
