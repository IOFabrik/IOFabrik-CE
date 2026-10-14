// Package services provides backend functionality for the IOFabrik application.
// This file contains the GitService which wraps git CLI operations.
package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Pre-compiled regular expressions for performance
var (
	// Matches git version string: "git version 2.39.0"
	gitVersionRegex = regexp.MustCompile(`git version (\d+)\.(\d+)\.?(\d*)`)
	// Matches rename with braces: dir/{old => new}.txt
	renameWithBracesRegex = regexp.MustCompile(`(.*)?\{(.*) => (.*)\}(.*)`)
)

// GitService provides git operations via CLI
type GitService struct {
	runner *CommandRunner
	bus    *RepoEventBus
}

// NewGitService creates a new GitService instance
func NewGitService() *GitService {
	return &GitService{
		runner: NewCommandRunner(),
	}
}

func (g *GitService) forGitOperation() *GitService {
	return &GitService{runner: g.runner.forGitOperation(), bus: g.bus}
}

// SetRepoEventBus wires the service to the repository event bus so state
// holders such as the conflict queue can react to mutating operations.
func (g *GitService) SetRepoEventBus(bus *RepoEventBus) {
	g.bus = bus
}

// publishRepoMutation announces that an operation may have changed the
// repository's unmerged state. It is safe to call with no bus attached and is
// intended to be deferred, so it fires on success and failure alike.
func (g *GitService) publishRepoMutation(repoPath string, reason RepoMutationReason) {
	g.bus.Publish(RepoMutated{RepoPath: repoPath, Reason: reason})
}

// RepoInfo contains basic information about a git repository
type RepoInfo struct {
	Path     string `json:"path"`
	IsRepo   bool   `json:"isRepo"`
	Branch   string `json:"branch"`
	HasError bool   `json:"hasError"`
	Error    string `json:"error,omitempty"`
}

// DetectRepo checks if the given path is a git repository
func (g *GitService) DetectRepo(path string) (ri RepoInfo) {
	done := LogMethod("GitService.DetectRepo", map[string]interface{}{"path": path})
	defer func() { done(ri, nil) }()
	ri = RepoInfo{
		Path:   path,
		IsRepo: false,
	}

	// Check if path exists
	info, err := os.Stat(path)
	if err != nil {
		ri.HasError = true
		ri.Error = "Path does not exist"
		return
	}

	if !info.IsDir() {
		ri.HasError = true
		ri.Error = "Path is not a directory"
		return
	}

	// Check if .git folder exists (quick check)
	gitPath := filepath.Join(path, ".git")
	if _, err := os.Stat(gitPath); os.IsNotExist(err) {
		// .git doesn't exist - not a repo
		return
	}

	// Verify it's a valid git repo using git rev-parse
	cmdResult := g.runner.RunGit(path, "rev-parse", "--is-inside-work-tree")
	if !cmdResult.Success {
		ri.HasError = true
		ri.Error = "Not a valid git repository"
		return
	}

	ri.IsRepo = true

	// Get current branch
	branchResult := g.runner.RunGit(path, "branch", "--show-current")
	if branchResult.Success {
		ri.Branch = trimOutput(branchResult.Stdout)
	}

	return
}

// GetRemoteURL returns the URL of the preferred remote.
// Prefers origin when available, otherwise uses the first configured remote.
// Returns empty string when no remotes are configured.
func (g *GitService) GetRemoteURL(repoPath string) string {
	done := LogMethod("GitService.GetRemoteURL", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()

	remote, ok := g.getPreferredRemote(repoPath)
	if !ok {
		return ""
	}

	result := g.runner.RunGit(repoPath, "remote", "get-url", remote)
	if !result.Success {
		return ""
	}
	return trimOutput(result.Stdout)
}

// RemoteBranch represents a branch advertised by the origin remote.
// Change Requests use this type exclusively rather than local remote-tracking refs.
type RemoteBranch struct {
	Name string `json:"name"`
	OID  string `json:"oid"`
}

// OriginRemoteURL returns origin's URL and never falls back to another remote.
func (g *GitService) OriginRemoteURL(repoPath string) (string, error) {
	result := g.runner.RunGit(repoPath, "remote", "get-url", "origin")
	if !result.Success {
		return "", fmt.Errorf("origin remote is not configured")
	}

	url := trimOutput(result.Stdout)
	if url == "" {
		return "", fmt.Errorf("origin remote is not configured")
	}
	return url, nil
}

// OriginRemoteBranches lists branches directly from origin. It intentionally
// does not use locally cached remote-tracking refs or a preferred-remote fallback.
func (g *GitService) OriginRemoteBranches(repoPath string) ([]RemoteBranch, error) {
	g = g.forGitOperation()
	if _, err := g.OriginRemoteURL(repoPath); err != nil {
		return nil, err
	}

	result := g.runner.RunGit(repoPath, "ls-remote", "--heads", "origin")
	if !result.Success {
		return nil, fmt.Errorf("failed to list origin branches: %s", getErrorMessage(result))
	}

	branches := make([]RemoteBranch, 0)
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || !strings.HasPrefix(fields[1], "refs/heads/") {
			continue
		}
		name := strings.TrimPrefix(fields[1], "refs/heads/")
		if name != "" {
			branches = append(branches, RemoteBranch{Name: name, OID: fields[0]})
		}
	}
	return branches, nil
}

// OriginTrackingUpstream verifies that branch tracks its same-named origin branch.
func (g *GitService) OriginTrackingUpstream(repoPath string, branch string) (upstream string, ok bool) {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return "", false
	}

	// getLocalBranchUpstream is refspec-robust (see resolveBranchUpstreamShort),
	// so published feature branches in single-branch clones resolve correctly.
	upstream = g.getLocalBranchUpstream(repoPath, branch)
	return upstream, upstream == "origin/"+branch
}

// InitRepo initializes a new Git repository at the given path.
// Creates the directory if it doesn't exist.
// Returns an error if the path is already a Git repository.
func (g *GitService) InitRepo(path string) (opResult OperationResult) {
	done := LogMethod("GitService.InitRepo", map[string]interface{}{"path": path})
	defer func() { done(opResult, nil) }()
	if path == "" {
		opResult = failedOp("Path is required")
		return
	}

	// Create directory if it doesn't exist
	if err := os.MkdirAll(path, 0755); err != nil {
		opResult = failedOp("Failed to create directory: " + err.Error())
		return
	}

	// Check if already a git repo
	existing := g.DetectRepo(path)
	if existing.IsRepo {
		opResult = failedOp("Directory is already a Git repository")
		return
	}

	// Prefer explicit main default branch when supported.
	result := g.runner.RunGit(path, "init", "-b", "main")
	if !result.Success {
		initErr := getErrorMessage(result)
		lowerInitErr := strings.ToLower(initErr)

		// Fallback for older Git versions that don't support -b/--initial-branch.
		if strings.Contains(lowerInitErr, "unknown switch") ||
			strings.Contains(lowerInitErr, "unknown option") ||
			strings.Contains(lowerInitErr, "unrecognized option") ||
			strings.Contains(lowerInitErr, "initial-branch") {
			legacyInitResult := g.runner.RunGit(path, "init")
			if !legacyInitResult.Success {
				opResult = failedOp("Failed to initialize repository: " + getErrorMessage(legacyInitResult))
				return
			}

			setHeadResult := g.runner.RunGit(path, "symbolic-ref", "HEAD", "refs/heads/main")
			if !setHeadResult.Success {
				opResult = failedOp("Failed to set default branch to main: " + getErrorMessage(setHeadResult))
				return
			}
		} else {
			opResult = failedOp("Failed to initialize repository: " + initErr)
			return
		}
	}

	// This is an explicit creation choice, including before the first Save.
	// Imported repositories never acquire a default from their branch name.
	settings := NewRepositorySettingsService()
	settings.runner = g.runner
	if recorded := settings.recordInitializedDefaultBranch(path, "main"); !recorded.Success {
		opResult = recorded
		return
	}
	opResult = successOp("Repository initialized successfully")
	return
}

// InitRepoWithLFS initializes a new Git repository with LFS enabled.
// Creates the directory if it doesn't exist, runs git init, then git lfs install.
func (g *GitService) InitRepoWithLFS(path string) OperationResult {
	// First initialize the git repo
	initResult := g.InitRepo(path)
	if !initResult.Success {
		return initResult
	}

	// Then initialize LFS
	lfsService := NewLFSService()
	lfsResult := lfsService.InitializeLFS(path)
	if !lfsResult.Success {
		// Git init succeeded but LFS failed - report partial success
		return OperationResult{
			Success: true,
			Message: "Repository initialized, but LFS setup failed: " + lfsResult.Error,
		}
	}

	return successOp("Repository initialized with Git LFS enabled")
}

// trimOutput removes leading/trailing whitespace from command output
func trimOutput(s string) string {
	return strings.TrimSpace(s)
}

// getRemotes returns all configured remote names (e.g. origin, upstream).
func (g *GitService) getRemotes(repoPath string) []string {
	result := g.runner.RunGit(repoPath, "remote")
	if !result.Success {
		return []string{}
	}

	lines := strings.Split(trimOutput(result.Stdout), "\n")
	remotes := make([]string, 0, len(lines))
	for _, line := range lines {
		name := strings.TrimSpace(line)
		if name != "" {
			remotes = append(remotes, name)
		}
	}
	return remotes
}

func (g *GitService) hasAnyRemote(repoPath string) bool {
	return len(g.getRemotes(repoPath)) > 0
}

func (g *GitService) hasRemote(repoPath string, remote string) bool {
	if strings.TrimSpace(remote) == "" {
		return false
	}
	for _, r := range g.getRemotes(repoPath) {
		if r == remote {
			return true
		}
	}
	return false
}

// getPreferredRemote returns origin when present, otherwise the first configured remote.
func (g *GitService) getPreferredRemote(repoPath string) (string, bool) {
	remotes := g.getRemotes(repoPath)
	if len(remotes) == 0 {
		return "", false
	}
	for _, r := range remotes {
		if r == "origin" {
			return r, true
		}
	}
	return remotes[0], true
}

// unquoteGitPath removes Git's quoting from paths containing spaces or special characters.
// Git uses "path with spaces" format in porcelain output. Also handles escaped characters.
func unquoteGitPath(path string) string {
	path = strings.TrimSpace(path)
	// Git wraps paths with spaces/special chars in double quotes
	if len(path) >= 2 && path[0] == '"' && path[len(path)-1] == '"' {
		// Remove surrounding quotes
		path = path[1 : len(path)-1]
		// Handle common escape sequences used by Git
		// Important: Process \\\\ FIRST before other escapes to avoid double processing
		path = strings.ReplaceAll(path, "\\\\", "\x00BACKSLASH\x00") // Temporary placeholder
		path = strings.ReplaceAll(path, "\\\"", "\"")
		path = strings.ReplaceAll(path, "\\n", "\n")
		path = strings.ReplaceAll(path, "\\t", "\t")
		path = strings.ReplaceAll(path, "\x00BACKSLASH\x00", "\\") // Restore backslashes
	}
	return path
}

// FileStatus represents the status of a changed file
type FileStatus struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Status string `json:"status"` // "added", "modified", "deleted", "renamed", "untracked"
}

// RepoStatus contains the current state of a repository
type RepoStatus struct {
	Branch            string       `json:"branch"`
	Ahead             int          `json:"ahead"`
	Behind            int          `json:"behind"`
	ChangedFiles      []FileStatus `json:"changedFiles"`
	HasChanges        bool         `json:"hasChanges"`
	HasUpstream       bool         `json:"hasUpstream"`       // true if branch has upstream tracking
	TotalLocalCommits int          `json:"totalLocalCommits"` // total commits on current branch (useful when no upstream)
	HasError          bool         `json:"hasError"`
	Error             string       `json:"error,omitempty"`
}

// Status returns the current status of the repository
// Uses concurrent goroutines to fetch branch, ahead/behind, and status in parallel
func (g *GitService) Status(repoPath string) RepoStatus {
	result := RepoStatus{
		ChangedFiles: []FileStatus{},
	}

	var wg sync.WaitGroup
	var mu sync.Mutex

	var branchResult, aheadBehindResult, upstreamResult, statusResult, commitCountResult, remoteListResult CommandResult

	// Run independent local commands concurrently
	wg.Add(4)

	// Get current branch
	go func() {
		defer wg.Done()
		branchResult = g.runner.RunGit(repoPath, "branch", "--show-current")
	}()

	// Get configured remotes (used to skip upstream checks for local-only repos)
	go func() {
		defer wg.Done()
		remoteListResult = g.runner.RunGit(repoPath, "remote")
	}()

	// Get changed files using git status --porcelain
	go func() {
		defer wg.Done()
		statusResult = g.runner.RunGit(repoPath, "status", "--porcelain")
	}()

	// Get local commit count not present on any remote-tracking ref.
	// This is used when the current branch has no upstream to detect whether
	// there are commits that still need publishing.
	go func() {
		defer wg.Done()
		commitCountResult = g.runner.RunGit(repoPath, "rev-list", "--count", "HEAD", "--not", "--remotes")
	}()

	wg.Wait()

	hasRemote := remoteListResult.Success && trimOutput(remoteListResult.Stdout) != ""
	if hasRemote {
		// Detect upstream explicitly so transient failures in ahead/behind math do not
		// incorrectly mark the branch as "no upstream".
		upstreamResult = g.runner.RunGit(repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")

		if upstreamResult.Success {
			// Only attempt upstream math when upstream exists.
			aheadBehindResult = g.runner.RunGit(repoPath, "rev-list", "--left-right", "--count", "@{u}...HEAD")
		}
	}

	// Fallback upstream detection for repositories cloned with a restricted fetch
	// refspec (e.g. single-branch clones that only mirror `main`). In that case a
	// feature branch can be pushed with its upstream recorded in `branch.<name>.*`
	// config, yet `@{u}` fails because git never mirrors a remote-tracking ref for
	// it. Without this fallback such branches are wrongly reported as "not
	// published", showing phantom pending snapshots even though they are on origin.
	var fallbackHasUpstream bool
	var fallbackAhead, fallbackBehind int
	var fallbackAheadBehindKnown bool
	if hasRemote && !upstreamResult.Success {
		branchName := trimOutput(branchResult.Stdout)
		if branchName != "" {
			remoteName := trimOutput(g.runner.RunGit(repoPath, "config", "--get", "branch."+branchName+".remote").Stdout)
			mergeRef := trimOutput(g.runner.RunGit(repoPath, "config", "--get", "branch."+branchName+".merge").Stdout)
			if remoteName != "" && mergeRef != "" {
				// The branch has a configured upstream, so it is genuinely published.
				fallbackHasUpstream = true

				// Resolve the remote tip directly to compute ahead/behind without
				// relying on a (missing) remote-tracking ref. This is the only path
				// that touches the network, and only in this degraded state.
				lsRemote := g.runner.forGitOperation().RunGit(repoPath, "ls-remote", "--heads", remoteName, mergeRef)
				remoteSha := firstLsRemoteSha(lsRemote)
				if remoteSha != "" {
					abResult := g.runner.RunGit(repoPath, "rev-list", "--left-right", "--count", remoteSha+"...HEAD")
					if abResult.Success {
						parts := strings.Fields(trimOutput(abResult.Stdout))
						if len(parts) == 2 {
							if n, err := strconv.Atoi(parts[0]); err == nil {
								fallbackBehind = n
							}
							if n, err := strconv.Atoi(parts[1]); err == nil {
								fallbackAhead = n
							}
							fallbackAheadBehindKnown = true
						}
					}
				}
			}
		}
	}

	// Process branch result
	mu.Lock()
	if branchResult.Success {
		result.Branch = trimOutput(branchResult.Stdout)
	} else {
		// Maybe in detached HEAD state
		result.Branch = "HEAD"
	}

	result.HasUpstream = hasRemote && upstreamResult.Success

	// Process ahead/behind result
	if result.HasUpstream && aheadBehindResult.Success {
		parts := strings.Fields(trimOutput(aheadBehindResult.Stdout))
		if len(parts) == 2 {
			// First is behind (upstream ahead), second is ahead (local ahead)
			if n, err := strconv.Atoi(parts[0]); err == nil {
				result.Behind = n
			}
			if n, err := strconv.Atoi(parts[1]); err == nil {
				result.Ahead = n
			}
		}
	}

	// Apply the restricted-refspec fallback when native upstream detection failed
	// but the branch is published per its config.
	if !result.HasUpstream && fallbackHasUpstream {
		result.HasUpstream = true
		if fallbackAheadBehindKnown {
			result.Behind = fallbackBehind
			result.Ahead = fallbackAhead
		}
	}

	// Process local-not-on-remote commit count only when no upstream exists.
	if !result.HasUpstream && commitCountResult.Success {
		if n, err := strconv.Atoi(trimOutput(commitCountResult.Stdout)); err == nil {
			result.TotalLocalCommits = n
		}
	}

	// Process status result
	if !statusResult.Success {
		result.HasError = true
		result.Error = "Failed to get git status"
		mu.Unlock()
		return result
	}
	mu.Unlock()

	lines := strings.Split(statusResult.Stdout, "\n")
	for _, line := range lines {
		if len(line) < 3 {
			continue
		}

		// Porcelain format: XY filename
		// X = index status, Y = worktree status
		xy := line[:2]
		filePath := unquoteGitPath(line[3:])

		// Handle renamed files (format: "R  old -> new")
		if strings.Contains(filePath, " -> ") {
			parts := strings.Split(filePath, " -> ")
			if len(parts) == 2 {
				filePath = unquoteGitPath(parts[1])
			}
		}

		status := parseGitStatus(xy)
		if status != "" {
			result.ChangedFiles = append(result.ChangedFiles, FileStatus{
				Path:   filePath,
				Name:   filepath.Base(filePath),
				Status: status,
			})
		}
	}

	result.HasChanges = len(result.ChangedFiles) > 0
	return result
}

// parseGitStatus converts git status codes to human-readable status
func parseGitStatus(xy string) string {
	// Handle untracked files
	if xy == "??" {
		return "untracked"
	}

	// Check index (staged) and worktree (unstaged) status
	x := xy[0]
	y := xy[1]

	// Prefer worktree status if present, otherwise use index status
	switch {
	case y == 'M' || x == 'M':
		return "modified"
	case y == 'D' || x == 'D':
		return "deleted"
	case y == 'A' || x == 'A':
		return "added"
	case x == 'R':
		return "renamed"
	case y == '?' || x == '?':
		return "untracked"
	default:
		return "modified" // Default to modified for any other status
	}
}

// OperationResult represents the result of a git operation
type OperationResult struct {
	Success      bool   `json:"success"`
	Message      string `json:"message"`
	Error        string `json:"error,omitempty"`
	LFSAvailable *bool  `json:"lfsAvailable,omitempty"`
}

// CommitAll stages all changes and commits with the given message.
// This is a composite operation that combines AddAll + Commit.
// For finer control, use AddAll() and Commit() separately.
func (g *GitService) CommitAll(repoPath string, message string) (opResult OperationResult) {
	defer g.publishRepoMutation(repoPath, RepoMutationCommit)
	done := LogMethod("GitService.CommitAll", map[string]interface{}{"repoPath": repoPath, "message": message})
	defer func() { done(opResult, nil) }()
	if message == "" {
		opResult = failedOp("Commit message is required")
		return
	}
	if readiness := g.requireSaveReady(repoPath); !readiness.Success {
		return readiness
	}

	// Check if there are any changes to commit
	hasChanges, err := g.HasChanges(repoPath)
	if err != nil {
		opResult = failedOp("Failed to check status: " + err.Error())
		return
	}
	if !hasChanges {
		opResult = failedOp("No changes to commit")
		return
	}

	// Stage all changes using primitive
	addResult := g.AddAll(repoPath)
	if !addResult.Success {
		opResult = addResult
		return
	}

	// Commit using primitive
	commitResult := g.Commit(repoPath, message)
	if !commitResult.Success {
		opResult = commitResult
		return
	}

	opResult = successOp("Changes saved successfully")
	return
}

// getErrorMessage extracts the most informative error message from a command result.
func getErrorMessage(result CommandResult) string {
	errMsg := ""
	if result.Stderr != "" {
		errMsg = result.Stderr
	} else {
		errMsg = result.Error
	}

	errMsg = strings.TrimSpace(errMsg)
	lowerErr := strings.ToLower(errMsg)

	if strings.Contains(lowerErr, "failed to execute prompt script") ||
		strings.Contains(lowerErr, "could not read username for 'https://github.com'") ||
		(strings.Contains(lowerErr, "terminal prompts disabled") && strings.Contains(lowerErr, "github.com")) ||
		strings.Contains(lowerErr, "/dev/tty") {
		return "GitHub authentication failed. Connect GitHub in IOFabrik and retry."
	}

	return errMsg
}

// ============================================================================
// Helper Functions - Operation Results & Common Checks
// ============================================================================

// failedOp creates a failed OperationResult with the given error message.
func failedOp(errMsg string) OperationResult {
	return OperationResult{Success: false, Error: errMsg}
}

// successOp creates a successful OperationResult with the given message.
func successOp(msg string) OperationResult {
	return OperationResult{Success: true, Message: msg}
}

// requireConfirmation returns an error if confirm is false.
// Used for destructive operations that need explicit user confirmation.
func requireConfirmation(confirm bool) error {
	if !confirm {
		return fmt.Errorf("this operation requires confirmation. Set confirm=true to proceed")
	}
	return nil
}

// requireCleanWorkingTree returns an error if the repo has uncommitted changes.
func (g *GitService) requireCleanWorkingTree(repoPath string) error {
	status := g.Status(repoPath)
	if status.HasChanges {
		return fmt.Errorf("you have uncommitted changes. Please save or discard your changes first")
	}
	return nil
}

// restoreFiles restores file(s) to HEAD state using git restore (2.23+) or git checkout.
// Pass "." to restore all files, or a specific path for a single file.
func (g *GitService) restoreFiles(repoPath string, pathSpec string) error {
	g = g.forGitOperation()
	if g.SupportsRestore() {
		// Git 2.23+: use git restore
		result := g.runner.RunGit(repoPath, "restore", "--", pathSpec)
		if !result.Success {
			return fmt.Errorf("%s", getErrorMessage(result))
		}
		// Also unstage any staged changes
		g.runner.RunGit(repoPath, "restore", "--staged", "--", pathSpec)
	} else {
		// Older git: use checkout
		result := g.runner.RunGit(repoPath, "checkout", "--", pathSpec)
		if !result.Success {
			return fmt.Errorf("%s", getErrorMessage(result))
		}
		// Also unstage any staged changes
		g.runner.RunGit(repoPath, "reset", "HEAD", "--", pathSpec)
	}
	return nil
}

// pluralize returns singular if n==1, otherwise returns singular+"s".
func pluralize(singular string, n int) string {
	if n == 1 {
		return singular
	}
	return singular + "s"
}

func isProtectedBranchName(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	return lower == "main" || lower == "master"
}

// firstLsRemoteSha returns the object id from the first line of `git ls-remote`
// output, which is formatted as "<sha>\t<ref>". Returns "" when the command
// failed or produced no matching ref.
func firstLsRemoteSha(result CommandResult) string {
	if !result.Success {
		return ""
	}
	line := strings.SplitN(strings.TrimSpace(result.Stdout), "\n", 2)[0]
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func parseUpstream(upstream string) (remote string, remoteBranch string, ok bool) {
	trimmed := strings.TrimSpace(upstream)
	if trimmed == "" {
		return "", "", false
	}
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (g *GitService) localBranchExists(repoPath string, branchName string) bool {
	result := g.runner.RunGit(repoPath, "show-ref", "--verify", "--quiet", "refs/heads/"+branchName)
	return result.Success
}

// resolveBranchUpstreamShort returns branch's upstream in short form (e.g.
// "origin/main"). It uses git's native resolution first and falls back to the
// recorded branch.<name>.remote / branch.<name>.merge config when native
// resolution yields nothing. Native resolution maps the upstream through the
// remote's fetch refspec, so in repositories cloned with a restricted refspec
// (single-branch clones that only mirror `main`) it returns empty for published
// feature branches even though their upstream is recorded and they exist on the
// remote. Returns ("", false) when no upstream is configured.
func resolveBranchUpstreamShort(runner *CommandRunner, repoPath string, branch string) (string, bool) {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return "", false
	}

	if native := trimOutput(runner.RunGit(repoPath, "for-each-ref", "--format=%(upstream:short)", "refs/heads/"+branch).Stdout); native != "" {
		return native, true
	}

	remoteName := trimOutput(runner.RunGit(repoPath, "config", "--get", "branch."+branch+".remote").Stdout)
	mergeRef := trimOutput(runner.RunGit(repoPath, "config", "--get", "branch."+branch+".merge").Stdout)
	if remoteName == "" || mergeRef == "" {
		return "", false
	}
	return remoteName + "/" + strings.TrimPrefix(mergeRef, "refs/heads/"), true
}

func (g *GitService) getLocalBranchUpstream(repoPath string, branchName string) string {
	upstream, ok := resolveBranchUpstreamShort(g.runner, repoPath, branchName)
	if !ok {
		return ""
	}
	return upstream
}

func (g *GitService) rollbackBranchRename(repoPath string, currentName string, oldName string) error {
	rollbackResult := g.runner.RunGit(repoPath, "branch", "-m", currentName, oldName)
	if rollbackResult.Success {
		return nil
	}
	return fmt.Errorf("%s", getErrorMessage(rollbackResult))
}

// ============================================================================
// Primitive Git Operations - Individual Commands
// These methods wrap single git commands for maximum reusability.
// Composite operations (like CommitAll) should use these primitives.
// ============================================================================

// Add stages a specific file or directory for commit.
// Equivalent to: git add <path>
func (g *GitService) Add(repoPath string, path string) OperationResult {
	if path == "" {
		return failedOp("Path is required")
	}
	result := g.runner.RunGit(repoPath, "add", "--", path)
	if !result.Success {
		return failedOp("Failed to stage file: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Staged '%s'", path))
}

// AddAll stages all changes in the repository.
// Equivalent to: git add .
func (g *GitService) AddAll(repoPath string) OperationResult {
	result := g.runner.RunGit(repoPath, "add", ".")
	if !result.Success {
		return failedOp("Failed to stage changes: " + getErrorMessage(result))
	}
	return successOp("All changes staged")
}

// AddFiles stages multiple files for commit.
// Equivalent to: git add -- <paths...>
func (g *GitService) AddFiles(repoPath string, paths []string) OperationResult {
	if len(paths) == 0 {
		return failedOp("At least one path is required")
	}
	args := append([]string{"add", "--"}, paths...)
	result := g.runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to stage files: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Staged %d file(s)", len(paths)))
}

// Unstage removes a file from the staging area without discarding changes.
// Equivalent to: git restore --staged <path> (Git 2.23+) or git reset HEAD <path>
func (g *GitService) Unstage(repoPath string, path string) OperationResult {
	if path == "" {
		return failedOp("Path is required")
	}
	var result CommandResult
	if g.SupportsRestore() {
		result = g.runner.RunGit(repoPath, "restore", "--staged", "--", path)
	} else {
		result = g.runner.RunGit(repoPath, "reset", "HEAD", "--", path)
	}
	if !result.Success {
		return failedOp("Failed to unstage file: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Unstaged '%s'", path))
}

// UnstageAll removes all files from the staging area.
// Equivalent to: git restore --staged . (Git 2.23+) or git reset HEAD
func (g *GitService) UnstageAll(repoPath string) OperationResult {
	var result CommandResult
	if g.SupportsRestore() {
		result = g.runner.RunGit(repoPath, "restore", "--staged", ".")
	} else {
		result = g.runner.RunGit(repoPath, "reset", "HEAD")
	}
	if !result.Success {
		return failedOp("Failed to unstage: " + getErrorMessage(result))
	}
	return successOp("All files unstaged")
}

// Restore reverts a file to its HEAD state, discarding working tree changes.
// Does NOT affect staged changes - use Unstage first if needed.
// Equivalent to: git restore <path> (Git 2.23+) or git checkout -- <path>
func (g *GitService) Restore(repoPath string, path string) OperationResult {
	g = g.forGitOperation()
	if path == "" {
		return failedOp("Path is required")
	}
	var result CommandResult
	if g.SupportsRestore() {
		result = g.runner.RunGit(repoPath, "restore", "--", path)
	} else {
		result = g.runner.RunGit(repoPath, "checkout", "--", path)
	}
	if !result.Success {
		return failedOp("Failed to restore file: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Restored '%s'", path))
}

// RestoreAll reverts all tracked files to HEAD state.
// Does NOT remove untracked files - use Clean for that.
// Equivalent to: git restore . (Git 2.23+) or git checkout -- .
func (g *GitService) RestoreAll(repoPath string) OperationResult {
	g = g.forGitOperation()
	var result CommandResult
	if g.SupportsRestore() {
		result = g.runner.RunGit(repoPath, "restore", ".")
	} else {
		result = g.runner.RunGit(repoPath, "checkout", "--", ".")
	}
	if !result.Success {
		return failedOp("Failed to restore files: " + getErrorMessage(result))
	}
	return successOp("All tracked files restored")
}

// Clean removes untracked files from the working directory.
// Does NOT remove ignored files by default.
// Equivalent to: git clean -fd
func (g *GitService) Clean(repoPath string) OperationResult {
	result := g.runner.RunGit(repoPath, "clean", "-fd")
	if !result.Success {
		return failedOp("Failed to clean untracked files: " + getErrorMessage(result))
	}
	return successOp("Untracked files removed")
}

// CleanDryRun shows what files would be removed by Clean without actually removing them.
// Equivalent to: git clean -fdn
func (g *GitService) CleanDryRun(repoPath string) ([]string, error) {
	result := g.runner.RunGit(repoPath, "clean", "-fdn")
	if !result.Success {
		return nil, fmt.Errorf("failed to list untracked files: %s", getErrorMessage(result))
	}
	lines := strings.Split(strings.TrimSpace(result.Stdout), "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// git clean -n output: "Would remove <file>"
		if strings.HasPrefix(line, "Would remove ") {
			files = append(files, strings.TrimPrefix(line, "Would remove "))
		} else {
			files = append(files, line)
		}
	}
	return files, nil
}

// Commit creates a commit with staged changes.
// Does NOT auto-stage anything - use Add/AddAll first.
// Equivalent to: git commit -m <message>
func (g *GitService) Commit(repoPath string, message string) (opResult OperationResult) {
	defer g.publishRepoMutation(repoPath, RepoMutationCommit)
	done := LogMethod("GitService.Commit", map[string]interface{}{"repoPath": repoPath, "message": message})
	defer func() { done(opResult, nil) }()
	if message == "" {
		opResult = failedOp("Commit message is required")
		return
	}
	if readiness := g.requireSaveReady(repoPath); !readiness.Success {
		return readiness
	}
	result := g.runner.RunGit(repoPath, "commit", "-m", message)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "nothing to commit") {
			opResult = failedOp("Nothing staged to commit")
			return
		}
		opResult = failedOp("Failed to commit: " + errMsg)
		return
	}
	opResult = successOp("Changes committed")
	return
}

// Fetch downloads objects and refs from the remote without merging.
// Equivalent to: git fetch [remote] [branch]
func (g *GitService) Fetch(repoPath string, remote string, branch string) OperationResult {
	g = g.forGitOperation()
	done := LogMethod("GitService.Fetch", map[string]interface{}{"repoPath": repoPath, "remote": remote, "branch": branch})
	defer func() { done(nil, nil) }()
	if remote == "" {
		if !g.hasAnyRemote(repoPath) {
			return failedOp("No remote repository configured. Publish to cloud first.")
		}
	} else if !g.hasRemote(repoPath, remote) {
		return failedOp(fmt.Sprintf("Remote '%s' is not configured.", remote))
	}

	args := []string{"fetch"}
	if remote != "" {
		args = append(args, remote)
		if branch != "" {
			args = append(args, branch)
		}
	}
	result := g.runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to fetch: " + getErrorMessage(result))
	}
	return successOp("Fetched successfully")
}

// FetchAll fetches from all remotes.
// Equivalent to: git fetch --all
func (g *GitService) FetchAll(repoPath string) OperationResult {
	g = g.forGitOperation()
	if !g.hasAnyRemote(repoPath) {
		return failedOp("No remote repository configured. Publish to cloud first.")
	}
	result := g.runner.RunGit(repoPath, "fetch", "--all")
	if !result.Success {
		return failedOp("Failed to fetch: " + getErrorMessage(result))
	}
	return successOp("Fetched from all remotes")
}

// Checkout switches to a branch or commit without safety checks.
// For safer operations with checks, use CheckoutBranch.
// Equivalent to: git checkout <ref>
func (g *GitService) Checkout(repoPath string, ref string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationCheckout)
	done := LogMethod("GitService.Checkout", map[string]interface{}{"repoPath": repoPath, "ref": ref})
	defer func() { done(nil, nil) }()
	if ref == "" {
		return failedOp("Reference is required")
	}
	result := g.runner.RunGit(repoPath, "checkout", ref)
	if !result.Success {
		return failedOp("Failed to checkout: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Switched to '%s'", ref))
}

// CheckoutNewBranch creates a new branch and switches to it without safety checks.
// For safer operations with checks, use CreateBranchAndCheckout.
// Equivalent to: git checkout -b <branch>
func (g *GitService) CheckoutNewBranch(repoPath string, branchName string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationCheckout)
	done := LogMethod("GitService.CheckoutNewBranch", map[string]interface{}{"repoPath": repoPath, "branchName": branchName})
	defer func() { done(nil, nil) }()
	if branchName == "" {
		return failedOp("Branch name is required")
	}
	result := g.runner.RunGit(repoPath, "checkout", "-b", branchName)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "already exists") {
			return failedOp(fmt.Sprintf("Branch '%s' already exists", branchName))
		}
		return failedOp("Failed to create branch: " + errMsg)
	}
	return successOp(fmt.Sprintf("Created and switched to '%s'", branchName))
}

// ResetHard resets HEAD, index, and working tree to a specific commit.
// WARNING: This is destructive - all uncommitted changes are lost.
// Equivalent to: git reset --hard <ref>
func (g *GitService) ResetHard(repoPath string, ref string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationOther)
	if ref == "" {
		ref = "HEAD"
	}
	result := g.runner.RunGit(repoPath, "reset", "--hard", ref)
	if !result.Success {
		return failedOp("Failed to reset: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Reset to %s", ref))
}

// ResetSoft resets HEAD to a specific commit but keeps all changes staged.
// Equivalent to: git reset --soft <ref>
func (g *GitService) ResetSoft(repoPath string, ref string) OperationResult {
	if ref == "" {
		return failedOp("Reference is required")
	}
	result := g.runner.RunGit(repoPath, "reset", "--soft", ref)
	if !result.Success {
		return failedOp("Failed to reset: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Soft reset to %s", ref))
}

// ResetMixed resets HEAD and index to a specific commit, keeping working tree changes.
// This is the default git reset behavior.
// Equivalent to: git reset <ref>
func (g *GitService) ResetMixed(repoPath string, ref string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationOther)
	if ref == "" {
		ref = "HEAD"
	}
	result := g.runner.RunGit(repoPath, "reset", ref)
	if !result.Success {
		return failedOp("Failed to reset: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Reset to %s", ref))
}

// GetCurrentBranch returns the name of the current branch.
// Returns empty string if in detached HEAD state.
func (g *GitService) GetCurrentBranch(repoPath string) (string, error) {
	result := g.runner.RunGit(repoPath, "branch", "--show-current")
	if !result.Success {
		return "", fmt.Errorf("failed to get current branch: %s", getErrorMessage(result))
	}
	return trimOutput(result.Stdout), nil
}

// HasChanges returns true if the repository has uncommitted changes.
func (g *GitService) HasChanges(repoPath string) (bool, error) {
	result := g.runner.RunGit(repoPath, "status", "--porcelain")
	if !result.Success {
		return false, fmt.Errorf("failed to check status: %s", getErrorMessage(result))
	}
	return strings.TrimSpace(result.Stdout) != "", nil
}

// HasStagedChanges returns true if there are staged (but uncommitted) changes.
func (g *GitService) HasStagedChanges(repoPath string) (bool, error) {
	result := g.runner.RunGit(repoPath, "diff", "--cached", "--quiet")
	// Exit code 0 = no staged changes, 1 = has staged changes
	return result.ExitCode == 1, nil
}

// RemoveFile removes a file from the working tree and stages the removal.
// Equivalent to: git rm <path>
func (g *GitService) RemoveFile(repoPath string, path string, cached bool) OperationResult {
	if path == "" {
		return failedOp("Path is required")
	}
	args := []string{"rm"}
	if cached {
		args = append(args, "--cached") // Remove from index only, keep working tree copy
	}
	args = append(args, "--", path)
	result := g.runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to remove file: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Removed '%s'", path))
}

// MoveFile renames/moves a file and stages the change.
// Equivalent to: git mv <source> <destination>
func (g *GitService) MoveFile(repoPath string, source string, destination string) OperationResult {
	if source == "" || destination == "" {
		return failedOp("Source and destination paths are required")
	}
	result := g.runner.RunGit(repoPath, "mv", source, destination)
	if !result.Success {
		return failedOp("Failed to move file: " + getErrorMessage(result))
	}
	return successOp(fmt.Sprintf("Moved '%s' to '%s'", source, destination))
}

// ============================================================================
// Composite Operations - Built from primitives
// These methods combine multiple primitives for common workflows.
// ============================================================================

// Pull fetches and merges changes from the remote
func (g *GitService) Pull(repoPath string) (opResult OperationResult) {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationPull)
	done := LogMethod("GitService.Pull", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(opResult, nil) }()
	if !g.hasAnyRemote(repoPath) {
		opResult = failedOp("No remote repository configured. Publish to cloud first.")
		return
	}
	result := g.runner.RunGit(repoPath, "pull")
	if !result.Success {
		opResult = OperationResult{
			Success: false,
			Error:   "Failed to sync: " + getErrorMessage(result),
		}
		return
	}

	message := trimOutput(result.Stdout)
	if message == "" {
		message = "Already up to date"
	}

	opResult = OperationResult{
		Success: true,
		Message: message,
	}
	return
}

// Push pushes local commits to the remote
func (g *GitService) Push(repoPath string) (opResult OperationResult) {
	g = g.forGitOperation()
	done := LogMethod("GitService.Push", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(opResult, nil) }()
	if !g.hasAnyRemote(repoPath) {
		opResult = failedOp("No remote repository configured. Publish to cloud first.")
		return
	}

	// First, try a regular push
	result := g.runner.RunGit(repoPath, "push")
	if !result.Success {
		errMsg := getErrorMessage(result)
		// Check if this is a new branch without upstream tracking
		if strings.Contains(errMsg, "no upstream") ||
			strings.Contains(errMsg, "has no upstream") ||
			strings.Contains(errMsg, "no tracking information") ||
			strings.Contains(errMsg, "set-upstream") {
			// Get the current branch name
			branchResult := g.runner.RunGit(repoPath, "branch", "--show-current")
			if !branchResult.Success {
				opResult = OperationResult{
					Success: false,
					Error:   "Failed to determine current branch",
				}
				return
			}
			branchName := trimOutput(branchResult.Stdout)
			if branchName == "" {
				opResult = OperationResult{
					Success: false,
					Error:   "Cannot push: detached HEAD state",
				}
				return
			}

			remoteName, hasRemote := g.getPreferredRemote(repoPath)
			if !hasRemote {
				opResult = failedOp("No remote repository configured. Publish to cloud first.")
				return
			}

			// Try pushing with --set-upstream to automatically configure tracking
			pushResult := g.runner.RunGit(repoPath, "push", "--set-upstream", remoteName, branchName)
			if !pushResult.Success {
				pushErr := getErrorMessage(pushResult)
				// Check if there's no remote configured at all
				if strings.Contains(pushErr, "does not appear to be a git repository") ||
					strings.Contains(pushErr, "No configured push destination") ||
					strings.Contains(pushErr, "fatal: 'origin' does not appear") {
					opResult = OperationResult{
						Success: false,
						Error:   "No remote repository configured. Publish to cloud first.",
					}
					return
				}
				opResult = OperationResult{
					Success: false,
					Error:   "Failed to share: " + pushErr,
				}
				return
			}
			opResult = OperationResult{
				Success: true,
				Message: "Branch published and changes shared successfully",
			}
			return
		}
		opResult = OperationResult{
			Success: false,
			Error:   "Failed to share: " + errMsg,
		}
		return
	}

	opResult = OperationResult{
		Success: true,
		Message: "Changes shared successfully",
	}
	return
}

// Sync performs a git pull (merge) followed by git push
func (g *GitService) Sync(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationPull)
	done := LogMethod("GitService.Sync", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()
	if !g.hasAnyRemote(repoPath) {
		return failedOp("No remote repository configured. Publish to cloud first.")
	}

	// First, pull with merge (not rebase)
	pullResult := g.runner.RunGit(repoPath, "pull", "--no-rebase")
	if !pullResult.Success {
		errMsg := getErrorMessage(pullResult)
		// Check for common errors
		if strings.Contains(errMsg, "no tracking information") || strings.Contains(errMsg, "no upstream") {
			return OperationResult{
				Success: false,
				Error:   "No remote branch configured. Please set up a remote first.",
			}
		}
		if strings.Contains(errMsg, "CONFLICT") || strings.Contains(errMsg, "conflict") {
			return OperationResult{
				Success: false,
				Error:   "Merge conflict detected. Please resolve conflicts manually.",
			}
		}
		return OperationResult{
			Success: false,
			Error:   "Failed to sync (pull): " + errMsg,
		}
	}

	// Then push
	pushResult := g.runner.RunGit(repoPath, "push")
	if !pushResult.Success {
		errMsg := getErrorMessage(pushResult)
		// Check for common push errors
		if strings.Contains(errMsg, "no upstream") || strings.Contains(errMsg, "has no upstream") {
			return OperationResult{
				Success: false,
				Error:   "No remote branch configured. Please set up a remote first.",
			}
		}
		if strings.Contains(errMsg, "rejected") {
			return OperationResult{
				Success: false,
				Error:   "Push rejected. Remote has changes. Please sync again.",
			}
		}
		return OperationResult{
			Success: false,
			Error:   "Failed to sync (push): " + errMsg,
		}
	}

	message := trimOutput(pullResult.Stdout)
	if message == "" || message == "Already up to date." {
		message = "Synced successfully"
	}

	return OperationResult{
		Success: true,
		Message: message,
	}
}

// CommitInfo represents a single commit
type CommitInfo struct {
	Hash         string `json:"hash"`
	ShortHash    string `json:"shortHash"`
	Message      string `json:"message"`
	Author       string `json:"author"`
	AuthorEmail  string `json:"authorEmail"`
	Date         string `json:"date"`
	RelativeDate string `json:"relativeDate"`
}

// GetRecentCommits returns recent commits from the repository
func (g *GitService) GetRecentCommits(repoPath string, limit int) ([]CommitInfo, error) {
	done := LogMethod("GitService.GetRecentCommits", map[string]interface{}{"repoPath": repoPath, "limit": limit})
	defer func() { done(nil, nil) }()
	if limit <= 0 {
		limit = 20
	}

	// Format: hash|short_hash|message|author|email|date|relative_date
	format := "%H|%h|%s|%an|%ae|%ci|%cr"
	result := g.runner.RunGit(repoPath, "log", "-n", strconv.Itoa(limit), "--pretty=format:"+format)
	if !result.Success {
		return nil, fmt.Errorf("failed to get commits: %s", result.Stderr)
	}

	commits := []CommitInfo{}
	lines := strings.Split(result.Stdout, "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "|", 7)
		if len(parts) < 7 {
			continue
		}

		commits = append(commits, CommitInfo{
			Hash:         parts[0],
			ShortHash:    parts[1],
			Message:      parts[2],
			Author:       parts[3],
			AuthorEmail:  parts[4],
			Date:         parts[5],
			RelativeDate: parts[6],
		})
	}

	return commits, nil
}

// ============================================================================
// Git Graph Types and Methods - For visualization
// ============================================================================

// GraphCommit represents a commit with parent references for graph visualization
type GraphCommit struct {
	Hash         string   `json:"hash"`
	ShortHash    string   `json:"shortHash"`
	Message      string   `json:"message"`
	Author       string   `json:"author"`
	AuthorEmail  string   `json:"authorEmail"`
	Date         string   `json:"date"`
	RelativeDate string   `json:"relativeDate"`
	Parents      []string `json:"parents"` // Parent commit hashes
	Refs         []string `json:"refs"`    // Branch and tag refs pointing to this commit
}

// CommitGraphResult contains commits and branch information for graph visualization
type CommitGraphResult struct {
	Commits  []GraphCommit     `json:"commits"`
	Branches map[string]string `json:"branches"` // branch name -> commit hash
	Tags     map[string]string `json:"tags"`     // tag name -> commit hash
	HasError bool              `json:"hasError"`
	Error    string            `json:"error,omitempty"`
}

// GetCommitGraph returns commits with parent references and branch/tag info for graph visualization
func (g *GitService) GetCommitGraph(repoPath string, limit int) CommitGraphResult {
	if limit <= 0 {
		limit = 50
	}

	result := CommitGraphResult{
		Commits:  []GraphCommit{},
		Branches: make(map[string]string),
		Tags:     make(map[string]string),
	}

	// Get commits with parent hashes and refs
	// Format: hash|short_hash|parents|refs|message|author|email|date|relative_date
	// %P = parent hashes (space-separated), %D = ref names
	format := "%H|%h|%P|%D|%s|%an|%ae|%ci|%cr"
	cmdResult := g.runner.RunGit(repoPath, "log", "-n", strconv.Itoa(limit), "--pretty=format:"+format, "--all")
	if !cmdResult.Success {
		result.HasError = true
		result.Error = cmdResult.Stderr
		return result
	}

	lines := strings.Split(cmdResult.Stdout, "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "|", 9)
		if len(parts) < 9 {
			continue
		}

		// Parse parent hashes (space-separated)
		var parents []string
		if parts[2] != "" {
			parents = strings.Split(parts[2], " ")
		}

		// Parse refs (comma-separated, may include "HEAD -> branch", "tag: v1.0.0", etc.)
		var refs []string
		if parts[3] != "" {
			refParts := strings.Split(parts[3], ", ")
			for _, ref := range refParts {
				ref = strings.TrimSpace(ref)
				// Clean up ref formatting
				ref = strings.TrimPrefix(ref, "HEAD -> ")
				ref = strings.TrimPrefix(ref, "tag: ")
				if ref != "" && ref != "HEAD" {
					refs = append(refs, ref)
				}
			}
		}

		result.Commits = append(result.Commits, GraphCommit{
			Hash:         parts[0],
			ShortHash:    parts[1],
			Parents:      parents,
			Refs:         refs,
			Message:      parts[4],
			Author:       parts[5],
			AuthorEmail:  parts[6],
			Date:         parts[7],
			RelativeDate: parts[8],
		})
	}

	// Get branch to commit mapping
	branchResult := g.runner.RunGit(repoPath, "branch", "-a", "--format=%(refname:short)|%(objectname)")
	if branchResult.Success {
		for _, line := range strings.Split(branchResult.Stdout, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 2)
			if len(parts) == 2 {
				branchName := strings.TrimPrefix(parts[0], "origin/")
				result.Branches[branchName] = parts[1]
			}
		}
	}

	// Get tag to commit mapping
	tagResult := g.runner.RunGit(repoPath, "tag", "--format=%(refname:short)|%(objectname)")
	if tagResult.Success {
		for _, line := range strings.Split(tagResult.Stdout, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "|", 2)
			if len(parts) == 2 {
				result.Tags[parts[0]] = parts[1]
			}
		}
	}

	return result
}

// ============================================================================
// v2 Types and Methods - History, Diffs, Branches, Recovery
// ============================================================================

// CommitDetail contains detailed information about a single commit
type CommitDetail struct {
	Hash         string           `json:"hash"`
	ShortHash    string           `json:"shortHash"`
	Message      string           `json:"message"`
	Body         string           `json:"body,omitempty"` // Full commit message body
	Author       string           `json:"author"`
	AuthorEmail  string           `json:"authorEmail"`
	Date         string           `json:"date"`
	RelativeDate string           `json:"relativeDate"`
	ParentHashes []string         `json:"parentHashes"`
	Files        []CommitFileInfo `json:"files"` // Files changed in this commit
	Stats        CommitStats      `json:"stats"` // Overall stats
	HasError     bool             `json:"hasError"`
	Error        string           `json:"error,omitempty"`
}

// CommitFileInfo represents a file changed in a commit
type CommitFileInfo struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"` // For renames
	Status    string `json:"status"`            // "added", "modified", "deleted", "renamed"
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// CommitStats contains overall statistics for a commit
type CommitStats struct {
	FilesChanged int `json:"filesChanged"`
	Additions    int `json:"additions"`
	Deletions    int `json:"deletions"`
}

// BranchInfo represents a git branch
type BranchInfo struct {
	Name            string `json:"name"`
	IsCurrent       bool   `json:"isCurrent"`
	IsRemote        bool   `json:"isRemote"`
	Upstream        string `json:"upstream,omitempty"`        // Remote tracking branch
	LastUpdatedUnix int64  `json:"lastUpdatedUnix,omitempty"` // Last commit timestamp on this branch (unix seconds)
}

// BranchList contains all branches in a repository
type BranchList struct {
	Current  string       `json:"current"`
	Local    []BranchInfo `json:"local"`
	Remote   []BranchInfo `json:"remote"`
	HasError bool         `json:"hasError"`
	Error    string       `json:"error,omitempty"`
}

// GitVersion represents parsed git version
type GitVersion struct {
	Major int
	Minor int
	Patch int
}

// GetGitVersion returns the installed git version.
// Used to determine feature compatibility (e.g., git restore requires 2.23+).
func (g *GitService) GetGitVersion() (*GitVersion, error) {
	result := g.runner.RunGit(".", "--version")
	if !result.Success {
		return nil, fmt.Errorf("failed to get git version: %s", result.Error)
	}

	output := trimOutput(result.Stdout)
	matches := gitVersionRegex.FindStringSubmatch(output)
	if len(matches) < 3 {
		return nil, fmt.Errorf("unable to parse git version: %s", output)
	}

	major, _ := strconv.Atoi(matches[1])
	minor, _ := strconv.Atoi(matches[2])
	patch := 0
	if len(matches) > 3 && matches[3] != "" {
		patch, _ = strconv.Atoi(matches[3])
	}

	return &GitVersion{Major: major, Minor: minor, Patch: patch}, nil
}

// SupportsRestore returns true if git version supports 'git restore' (2.23+)
func (g *GitService) SupportsRestore() bool {
	version, err := g.GetGitVersion()
	if err != nil {
		return false
	}
	// git restore was introduced in Git 2.23
	return version.Major > 2 || (version.Major == 2 && version.Minor >= 23)
}

// ShowCommit returns detailed information about a specific commit
// Uses concurrent goroutines to fetch metadata, numstat, and name-status in parallel
func (g *GitService) ShowCommit(repoPath string, hash string) CommitDetail {
	done := LogMethod("GitService.ShowCommit", map[string]interface{}{"repoPath": repoPath, "hash": hash})
	defer func() { done(nil, nil) }()
	result := CommitDetail{}

	if hash == "" {
		result.HasError = true
		result.Error = "Commit hash is required"
		return result
	}

	var wg sync.WaitGroup
	var showResult, statsResult, nameStatusResult CommandResult

	// Run all three git commands concurrently
	wg.Add(3)

	// Get commit metadata
	go func() {
		defer wg.Done()
		format := "%H|%h|%s|%b|%an|%ae|%ci|%cr|%P"
		showResult = g.runner.RunGit(repoPath, "show", "-s", "--pretty=format:"+format, hash)
	}()

	// Get list of files changed with stats using --numstat
	go func() {
		defer wg.Done()
		statsResult = g.runner.RunGit(repoPath, "show", "--numstat", "--pretty=format:", hash)
	}()

	// Get name-status for accurate status detection
	go func() {
		defer wg.Done()
		nameStatusResult = g.runner.RunGit(repoPath, "show", "--name-status", "--pretty=format:", hash)
	}()

	wg.Wait()

	// Process metadata result
	if !showResult.Success {
		result.HasError = true
		result.Error = "Commit not found: " + hash
		return result
	}

	parts := strings.SplitN(trimOutput(showResult.Stdout), "|", 9)
	if len(parts) < 9 {
		result.HasError = true
		result.Error = "Failed to parse commit data"
		return result
	}

	result.Hash = parts[0]
	result.ShortHash = parts[1]
	result.Message = parts[2]
	result.Body = strings.TrimSpace(parts[3])
	result.Author = parts[4]
	result.AuthorEmail = parts[5]
	result.Date = parts[6]
	result.RelativeDate = parts[7]
	if parts[8] != "" {
		result.ParentHashes = strings.Fields(parts[8])
	}

	// Process numstat result
	if statsResult.Success {
		result.Files = g.parseNumstat(statsResult.Stdout)
	}

	// Process name-status result
	if nameStatusResult.Success {
		statusMap := g.parseNameStatus(nameStatusResult.Stdout)
		for i := range result.Files {
			if status, ok := statusMap[result.Files[i].Path]; ok {
				result.Files[i].Status = status
			}
		}
	}

	// Calculate overall stats
	for _, f := range result.Files {
		result.Stats.FilesChanged++
		result.Stats.Additions += f.Additions
		result.Stats.Deletions += f.Deletions
	}

	return result
}

// parseNumstat parses git show --numstat output into a list of file changes.
// Format per line: additions<tab>deletions<tab>filepath
func (g *GitService) parseNumstat(output string) []CommitFileInfo {
	files := []CommitFileInfo{}
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}

		additions := 0
		deletions := 0
		// Binary files show "-" for additions/deletions
		if parts[0] != "-" {
			additions, _ = strconv.Atoi(parts[0])
		}
		if parts[1] != "-" {
			deletions, _ = strconv.Atoi(parts[1])
		}

		// Handle renamed files: "old => new" or "{old => new}"
		path := strings.Join(parts[2:], " ")
		oldPath := ""
		if strings.Contains(path, " => ") {
			// Handle rename format
			path, oldPath = parseRenamePath(path)
		}

		files = append(files, CommitFileInfo{
			Path:      path,
			OldPath:   oldPath,
			Additions: additions,
			Deletions: deletions,
			Status:    "modified", // Will be updated from name-status
		})
	}

	return files
}

// parseRenamePath handles git's rename path format.
// Supports formats: "old => new", "{dir/old => dir/new}", "dir/{old => new}".
func parseRenamePath(path string) (newPath, oldPath string) {
	if strings.Contains(path, "{") {
		// Complex rename with common prefix/suffix
		matches := renameWithBracesRegex.FindStringSubmatch(path)
		if len(matches) == 5 {
			prefix, oldPart, newPart, suffix := matches[1], matches[2], matches[3], matches[4]
			return prefix + newPart + suffix, prefix + oldPart + suffix
		}
	}

	// Simple rename: "old => new"
	if parts := strings.Split(path, " => "); len(parts) == 2 {
		return strings.TrimSpace(parts[1]), strings.TrimSpace(parts[0])
	}

	return path, ""
}

// parseNameStatus parses git show --name-status output
func (g *GitService) parseNameStatus(output string) map[string]string {
	statusMap := make(map[string]string)
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		statusCode := parts[0]
		path := parts[len(parts)-1] // Last part is the path (or new path for renames)

		status := "modified"
		switch {
		case strings.HasPrefix(statusCode, "A"):
			status = "added"
		case strings.HasPrefix(statusCode, "D"):
			status = "deleted"
		case strings.HasPrefix(statusCode, "R"):
			status = "renamed"
		case strings.HasPrefix(statusCode, "M"):
			status = "modified"
		case strings.HasPrefix(statusCode, "C"):
			status = "copied"
		}

		statusMap[path] = status
	}

	return statusMap
}

// RawDiffResult contains raw unified diff text for react-diff-view parsing
type RawDiffResult struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"` // "added", "modified", "deleted", "renamed"
	Binary    bool   `json:"binary"`
	RawDiff   string `json:"rawDiff"` // Raw unified diff text
	HasError  bool   `json:"hasError"`
	Error     string `json:"error,omitempty"`
	TargetRef string `json:"targetRef,omitempty"` // Resolved target ref (for merge review)
	SourceRef string `json:"sourceRef,omitempty"` // Resolved source ref (for merge review)
}

type MergeReviewFile struct {
	Path    string `json:"path"`
	Status  string `json:"status,omitempty"`
	OldPath string `json:"oldPath,omitempty"`
}

// DiffWorkingRaw returns the raw unified diff text of a file in the working tree vs HEAD
// This is designed to be consumed by react-diff-view's parseDiff function
func (g *GitService) DiffWorkingRaw(repoPath string, filePath string) RawDiffResult {
	done := LogMethod("GitService.DiffWorkingRaw", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()
	result := RawDiffResult{
		Path:   filePath,
		Status: "modified",
	}

	// Check if file exists
	fullPath := filepath.Join(repoPath, filePath)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		result.Status = "deleted"
	}

	g = g.forGitOperation()

	// Get the diff (use --textconv so filters like Git LFS can provide real content)
	diffResult := g.runner.RunGit(repoPath, "diff", "--textconv", "--", filePath)
	if !diffResult.Success {
		// Try diff for untracked files (compare with /dev/null)
		diffResult = g.runner.RunGit(repoPath, "diff", "--textconv", "--no-index", "/dev/null", filePath)
		if !diffResult.Success && diffResult.ExitCode != 1 {
			result.HasError = true
			result.Error = "Failed to get diff: " + diffResult.Stderr
			return result
		}
		result.Status = "added"
	}

	// Also try staged diff if working tree diff is empty
	if diffResult.Stdout == "" {
		stagedResult := g.runner.RunGit(repoPath, "diff", "--textconv", "--cached", "--", filePath)
		if stagedResult.Success && stagedResult.Stdout != "" {
			diffResult = stagedResult
		}
	}

	if diffResult.Stdout == "" {
		// Check if untracked file
		statusResult := g.runner.RunGit(repoPath, "status", "--porcelain", "--", filePath)
		if statusResult.Success && strings.HasPrefix(statusResult.Stdout, "??") {
			// Untracked file - create a synthetic diff
			result.Status = "added"
			content, err := os.ReadFile(fullPath)
			if err == nil {
				result.RawDiff = g.createRawAddedFileDiff(filePath, string(content))
			}
			return result
		}
		return result
	}

	// Check for binary file
	if strings.Contains(diffResult.Stdout, "Binary files") || strings.Contains(diffResult.Stdout, "GIT binary patch") {
		result.Binary = true
		return result
	}

	if containsLFSPointerDiff(diffResult.Stdout) {
		if g.tryPullLFSForFile(repoPath, filePath) {
			retryResult := g.runner.RunGit(repoPath, "diff", "--textconv", "--", filePath)
			if retryResult.Success || retryResult.ExitCode == 1 {
				if retryResult.Stdout == "" {
					stagedResult := g.runner.RunGit(repoPath, "diff", "--textconv", "--cached", "--", filePath)
					if stagedResult.Success && stagedResult.Stdout != "" {
						retryResult = stagedResult
					}
				}

				if !containsLFSPointerDiff(retryResult.Stdout) {
					if strings.Contains(retryResult.Stdout, "Binary files") || strings.Contains(retryResult.Stdout, "GIT binary patch") {
						result.Binary = true
						return result
					}
					result.RawDiff = retryResult.Stdout
					return result
				}
			}
		}

		result.HasError = true
		result.Error = g.lfsContentUnavailableError(repoPath, filePath)
		return result
	}

	result.RawDiff = diffResult.Stdout
	return result
}

// DiffCommitFileRaw returns the raw unified diff text for a specific file in a commit
func (g *GitService) DiffCommitFileRaw(repoPath string, hash string, filePath string) RawDiffResult {
	result := RawDiffResult{
		Path:   filePath,
		Status: "modified",
	}

	if hash == "" {
		result.HasError = true
		result.Error = "Commit hash is required"
		return result
	}

	g = g.forGitOperation()

	// Use git show with --textconv so filters like Git LFS can provide real content.
	args := []string{"show", "--textconv", "--pretty=format:", hash, "--", filePath}
	diffResult := g.runner.RunGit(repoPath, args...)
	if !diffResult.Success {
		result.HasError = true
		result.Error = "Failed to get diff: " + diffResult.Stderr
		return result
	}

	if diffResult.Stdout == "" {
		return result
	}

	// Check for binary file
	if strings.Contains(diffResult.Stdout, "Binary files") || strings.Contains(diffResult.Stdout, "GIT binary patch") {
		result.Binary = true
		return result
	}

	if containsLFSPointerDiff(diffResult.Stdout) {
		if g.tryFetchLFSForFile(repoPath, filePath, hash, hash+"^") {
			retryResult := g.runner.RunGit(repoPath, args...)
			if retryResult.Success {
				if strings.Contains(retryResult.Stdout, "Binary files") || strings.Contains(retryResult.Stdout, "GIT binary patch") {
					result.Binary = true
					return result
				}
				if !containsLFSPointerDiff(retryResult.Stdout) {
					result.RawDiff = retryResult.Stdout
					return result
				}
			}
		}

		result.HasError = true
		result.Error = g.lfsContentUnavailableError(repoPath, filePath)
		return result
	}

	result.RawDiff = diffResult.Stdout
	return result
}

func (g *GitService) ListMergeReviewFiles(repoPath string, targetBranch string, sourceBranch string) []MergeReviewFile {
	files := []MergeReviewFile{}

	if targetBranch == "" || sourceBranch == "" {
		return files
	}

	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return files
	}

	targetRef, err := g.resolveBranchRef(repoPath, targetBranch, true)
	if err != nil {
		return files
	}

	sourceRef, err := g.resolveBranchRef(repoPath, sourceBranch, false)
	if err != nil {
		return files
	}

	result := g.runner.RunGit(repoPath, "diff", "--name-status", "-M", targetRef+".."+sourceRef)
	if !result.Success {
		return files
	}

	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}

		statusCode := strings.TrimSpace(parts[0])
		status := "modified"
		switch {
		case strings.HasPrefix(statusCode, "A"):
			status = "added"
		case strings.HasPrefix(statusCode, "D"):
			status = "deleted"
		case strings.HasPrefix(statusCode, "R"):
			status = "renamed"
		case strings.HasPrefix(statusCode, "C"):
			status = "copied"
		case strings.HasPrefix(statusCode, "M"):
			status = "modified"
		}

		file := MergeReviewFile{Status: status}
		if strings.HasPrefix(statusCode, "R") || strings.HasPrefix(statusCode, "C") {
			if len(parts) < 3 {
				continue
			}
			file.OldPath = unquoteGitPath(parts[1])
			file.Path = unquoteGitPath(parts[2])
		} else {
			file.Path = unquoteGitPath(parts[1])
		}

		if file.Path == "" {
			continue
		}

		files = append(files, file)
	}

	return files
}

func (g *GitService) DiffMergeReviewFileRaw(repoPath string, targetBranch string, sourceBranch string, filePath string) RawDiffResult {
	result := RawDiffResult{
		Path:   filePath,
		Status: "modified",
	}

	if targetBranch == "" || sourceBranch == "" {
		result.HasError = true
		result.Error = "Both target and source branches are required"
		return result
	}

	if strings.TrimSpace(filePath) == "" {
		result.HasError = true
		result.Error = "File path is required"
		return result
	}

	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		result.HasError = true
		result.Error = "Not a valid git repository"
		return result
	}

	targetRef, err := g.resolveBranchRef(repoPath, targetBranch, true)
	if err != nil {
		result.HasError = true
		result.Error = err.Error()
		return result
	}

	sourceRef, err := g.resolveBranchRef(repoPath, sourceBranch, false)
	if err != nil {
		result.HasError = true
		result.Error = err.Error()
		return result
	}

	statusResult := g.runner.RunGit(repoPath, "diff", "--name-status", "-M", targetRef+".."+sourceRef, "--", filePath)
	if statusResult.Success {
		for _, line := range strings.Split(strings.TrimSpace(statusResult.Stdout), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			parts := strings.Split(line, "\t")
			if len(parts) < 2 {
				continue
			}
			statusCode := strings.TrimSpace(parts[0])
			switch {
			case strings.HasPrefix(statusCode, "A"):
				result.Status = "added"
			case strings.HasPrefix(statusCode, "D"):
				result.Status = "deleted"
			case strings.HasPrefix(statusCode, "R"):
				result.Status = "renamed"
				if len(parts) >= 3 {
					result.OldPath = unquoteGitPath(parts[1])
					result.Path = unquoteGitPath(parts[2])
				}
			case strings.HasPrefix(statusCode, "C"):
				result.Status = "copied"
				if len(parts) >= 3 {
					result.OldPath = unquoteGitPath(parts[1])
					result.Path = unquoteGitPath(parts[2])
				}
			default:
				result.Status = "modified"
			}
			break
		}
	}

	// Store resolved refs so the frontend can use them for specialized viewers.
	result.TargetRef = targetRef
	result.SourceRef = sourceRef

	g = g.forGitOperation()

	diffResult := g.runner.RunGit(repoPath, "diff", "--textconv", targetRef+".."+sourceRef, "--", filePath)
	if !diffResult.Success && diffResult.ExitCode != 1 {
		result.HasError = true
		result.Error = "Failed to get diff: " + getErrorMessage(diffResult)
		return result
	}

	if strings.Contains(diffResult.Stdout, "Binary files") || strings.Contains(diffResult.Stdout, "GIT binary patch") {
		result.Binary = true
		return result
	}

	if containsLFSPointerDiff(diffResult.Stdout) {
		// Auto-fetch LFS objects for both refs and retry the diff.
		if g.tryFetchLFSForFile(repoPath, filePath, targetBranch, sourceBranch, targetRef, sourceRef) {
			retryResult := g.runner.RunGit(repoPath, "diff", "--textconv", targetRef+".."+sourceRef, "--", filePath)
			if retryResult.Success || retryResult.ExitCode == 1 {
				if !containsLFSPointerDiff(retryResult.Stdout) &&
					!strings.Contains(retryResult.Stdout, "Binary files") &&
					!strings.Contains(retryResult.Stdout, "GIT binary patch") {
					result.RawDiff = retryResult.Stdout
					return result
				}
				if strings.Contains(retryResult.Stdout, "Binary files") || strings.Contains(retryResult.Stdout, "GIT binary patch") {
					result.Binary = true
					return result
				}
			}
		}
		result.HasError = true
		result.Error = g.lfsContentUnavailableError(repoPath, filePath)
		return result
	}

	result.RawDiff = diffResult.Stdout
	return result
}

// createRawAddedFileDiff creates a synthetic unified diff for a newly added file
func (g *GitService) createRawAddedFileDiff(filePath string, content string) string {
	lines := strings.Split(content, "\n")
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("diff --git a/%s b/%s\n", filePath, filePath))
	sb.WriteString("new file mode 100644\n")
	sb.WriteString("--- /dev/null\n")
	sb.WriteString(fmt.Sprintf("+++ b/%s\n", filePath))
	sb.WriteString(fmt.Sprintf("@@ -0,0 +1,%d @@\n", len(lines)))

	for _, line := range lines {
		sb.WriteString("+")
		sb.WriteString(line)
		sb.WriteString("\n")
	}

	return sb.String()
}

// ============================================================================
// File Content at Revision
// ============================================================================

// FileContentResult contains the content of a file at a specific git revision
type FileContentResult struct {
	Content  string `json:"content"`
	HasError bool   `json:"hasError"`
	Error    string `json:"error,omitempty"`
}

func (g *GitService) readFileAtRevisionWithTimeout(repoPath string, filePath string, revision string, timeout time.Duration) FileContentResult {
	if repoPath == "" {
		return FileContentResult{HasError: true, Error: "Repository path is required"}
	}
	if filePath == "" {
		return FileContentResult{HasError: true, Error: "File path is required"}
	}
	if revision == "" {
		return FileContentResult{HasError: true, Error: "Revision is required"}
	}

	relPath, err := toRepoRelativePath(repoPath, filePath)
	if err != nil {
		return FileContentResult{HasError: true, Error: err.Error()}
	}

	g = g.forGitOperation()

	showArg := revision + ":" + relPath

	// Prefer `git cat-file --filters` so smudge filters (including Git LFS)
	// are applied. This avoids returning LFS pointer text for tracked files.
	// Fall back to `git show` for compatibility.
	objectRef := showArg

	readRawWithTimeout := func(args ...string) ([]byte, error) {
		if timeout <= 0 {
			return g.runner.RunGitRaw(repoPath, args...)
		}

		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()

		result := g.runner.RunWithContext(ctx, repoPath, GitPath(), args...)
		if !result.Success {
			errMsg := result.Stderr
			if errMsg == "" {
				errMsg = result.Error
			}
			return nil, fmt.Errorf("%s", errMsg)
		}
		return []byte(result.Stdout), nil
	}

	data, err := readRawWithTimeout("cat-file", "--filters", objectRef)
	if err != nil {
		data, err = readRawWithTimeout("show", showArg)
		if err != nil {
			return buildFileContentError(err.Error(), filePath, revision)
		}
	}

	// Clearer message when LFS object resolution failed and only pointer is present.
	if isLFSPointer(data) {
		if g.tryFetchLFSForFile(repoPath, relPath, revision) || g.tryPullLFSForFile(repoPath, relPath) {
			data, err = readRawWithTimeout("cat-file", "--filters", objectRef)
			if err != nil {
				data, err = readRawWithTimeout("show", showArg)
			}
			if err == nil && !isLFSPointer(data) {
				return FileContentResult{Content: string(data)}
			}
		}

		return FileContentResult{
			HasError: true,
			Error:    fmt.Sprintf("File '%s' is stored in Git LFS but the actual content could not be retrieved. The app attempted to fetch it automatically; ensure git-lfs is installed and run 'git lfs pull' if the issue persists.", relPath),
		}
	}

	return FileContentResult{Content: string(data)}
}

func toRepoRelativePath(repoPath string, filePath string) (string, error) {
	cleaned := filepath.Clean(filePath)
	if cleaned == "." {
		return "", fmt.Errorf("File path must point to a file")
	}

	if filepath.IsAbs(cleaned) {
		rel, err := filepath.Rel(repoPath, cleaned)
		if err != nil {
			return "", fmt.Errorf("Failed to resolve file path: %w", err)
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return "", fmt.Errorf("File path must be within the repository")
		}
		return filepath.ToSlash(rel), nil
	}

	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("File path must be within the repository")
	}

	return filepath.ToSlash(cleaned), nil
}

func buildFileContentError(errMsg string, filePath string, revision string) FileContentResult {
	if strings.Contains(errMsg, "does not exist") || strings.Contains(errMsg, "not exist in") {
		return FileContentResult{
			HasError: true,
			Error:    fmt.Sprintf("File '%s' does not exist at revision '%s'", filePath, revision),
		}
	}
	if strings.Contains(errMsg, "bad revision") || strings.Contains(errMsg, "unknown revision") {
		return FileContentResult{
			HasError: true,
			Error:    fmt.Sprintf("Invalid revision: '%s'", revision),
		}
	}
	return FileContentResult{
		HasError: true,
		Error:    fmt.Sprintf("Failed to read file at revision: %s", errMsg),
	}
}

// ReadFileAtRevision returns the content of a file at a specific git revision.
// Uses `git show <revision>:<path>` to retrieve the content.
// The revision can be a commit hash, branch name, tag, HEAD~N, etc.
// For working tree content, use os.ReadFile directly instead.
func (g *GitService) ReadFileAtRevision(repoPath string, filePath string, revision string) FileContentResult {
	return g.readFileAtRevisionWithTimeout(repoPath, filePath, revision, 0)
}

// ReadFileAtRevisionLarge reads viewer text with a 2-minute timeout and the
// same size limit as working-tree text reads (including resolved LFS content).
func (g *GitService) ReadFileAtRevisionLarge(repoPath string, filePath string, revision string) FileContentResult {
	result := g.readFileAtRevisionWithTimeout(repoPath, filePath, revision, 2*time.Minute)
	if !result.HasError && len(result.Content) > maxTextViewerSize {
		return FileContentResult{HasError: true, Error: "File is too large to display (max 10MB)"}
	}
	return result
}

// FileBase64Result contains the result of reading a binary file from a git revision as base64.
type FileBase64Result struct {
	Success  bool   `json:"success"`
	Data     string `json:"data,omitempty"`     // Base64-encoded file content
	MimeType string `json:"mimeType,omitempty"` // MIME type based on extension
	Size     int64  `json:"size,omitempty"`     // Raw file size in bytes
	Error    string `json:"error,omitempty"`
}

// GetFileAtRevisionBase64 reads a binary file from a git revision and returns it as base64.
// Uses `git show <revision>:<path>` with raw byte capture so binary content (PDFs, etc.)
// is not corrupted by string conversion. The revision can be a commit hash, branch, tag,
// HEAD, HEAD~N, etc.
func (g *GitService) GetFileAtRevisionBase64(repoPath string, filePath string, revision string) FileBase64Result {
	if repoPath == "" {
		return FileBase64Result{Success: false, Error: "Repository path is required"}
	}
	if filePath == "" {
		return FileBase64Result{Success: false, Error: "File path is required"}
	}
	if revision == "" {
		return FileBase64Result{Success: false, Error: "Revision is required"}
	}

	relPath, err := toRepoRelativePath(repoPath, filePath)
	if err != nil {
		return FileBase64Result{Success: false, Error: err.Error()}
	}

	g = g.forGitOperation()

	objectRef := revision + ":" + relPath

	// Use `git cat-file --filters` to apply smudge filters (including Git LFS).
	// This ensures LFS-tracked files return actual content, not LFS pointers.
	// Falls back to `git show` if cat-file fails (older git versions).
	data, err := g.runner.RunGitRaw(repoPath, "cat-file", "--filters", objectRef)
	if err != nil {
		// Fallback: try `git show` for compatibility with older git versions
		data, err = g.runner.RunGitRaw(repoPath, "show", objectRef)
		if err != nil {
			errMsg := err.Error()
			if strings.Contains(errMsg, "does not exist") || strings.Contains(errMsg, "not exist in") {
				return FileBase64Result{Success: false, Error: fmt.Sprintf("File '%s' does not exist at revision '%s'", filePath, revision)}
			}
			if strings.Contains(errMsg, "bad revision") || strings.Contains(errMsg, "unknown revision") {
				return FileBase64Result{Success: false, Error: fmt.Sprintf("Invalid revision: '%s'", revision)}
			}
			return FileBase64Result{Success: false, Error: fmt.Sprintf("Failed to read file at revision: %s", errMsg)}
		}
	}

	if len(data) == 0 {
		return FileBase64Result{Success: false, Error: fmt.Sprintf("Empty content at %s:%s", revision, relPath)}
	}

	// Safety check: detect Git LFS pointer that wasn't resolved by filters.
	// This can happen if git-lfs is not installed or LFS objects aren't available.
	if isLFSPointer(data) {
		if g.tryFetchLFSForFile(repoPath, relPath, revision) || g.tryPullLFSForFile(repoPath, relPath) {
			data, err = g.runner.RunGitRaw(repoPath, "cat-file", "--filters", objectRef)
			if err != nil {
				data, err = g.runner.RunGitRaw(repoPath, "show", objectRef)
			}
			if err == nil && len(data) > 0 && !isLFSPointer(data) {
				ext := filepath.Ext(relPath)
				mimeType := mimeTypeFromExt(ext)
				return FileBase64Result{
					Success:  true,
					Data:     base64.StdEncoding.EncodeToString(data),
					MimeType: mimeType,
					Size:     int64(len(data)),
				}
			}
		}

		return FileBase64Result{
			Success: false,
			Error:   fmt.Sprintf("File '%s' is stored in Git LFS but the actual content could not be retrieved. The app attempted to fetch it automatically; ensure git-lfs is installed and run 'git lfs pull' if the issue persists.", relPath),
		}
	}

	ext := filepath.Ext(relPath)
	mimeType := mimeTypeFromExt(ext)

	return FileBase64Result{
		Success:  true,
		Data:     base64.StdEncoding.EncodeToString(data),
		MimeType: mimeType,
		Size:     int64(len(data)),
	}
}

// isLFSPointer checks if raw file content is a Git LFS pointer (not actual file data).
// LFS pointers start with "version https://git-lfs" and are small text files.
func isLFSPointer(data []byte) bool {
	if len(data) > 1024 {
		return false // LFS pointers are always small (<200 bytes)
	}
	return bytes.HasPrefix(data, []byte("version https://git-lfs"))
}

func containsLFSPointerDiff(rawDiff string) bool {
	if rawDiff == "" {
		return false
	}

	// Direct pointer-line changes.
	hasVersionAddOrRemove := strings.Contains(rawDiff, "\n+version https://git-lfs") ||
		strings.Contains(rawDiff, "\n-version https://git-lfs") ||
		strings.HasPrefix(rawDiff, "+version https://git-lfs") ||
		strings.HasPrefix(rawDiff, "-version https://git-lfs")
	if hasVersionAddOrRemove {
		return true
	}

	// Common LFS pointer update case: version line is unchanged context,
	// while oid/size lines are changed (+/-). In this scenario we still want
	// to surface the explicit LFS content-unavailable error.
	hasLfsVersionContext := strings.Contains(rawDiff, "\n version https://git-lfs") ||
		strings.Contains(rawDiff, "\n+version https://git-lfs") ||
		strings.Contains(rawDiff, "\n-version https://git-lfs") ||
		strings.HasPrefix(rawDiff, "version https://git-lfs") ||
		strings.HasPrefix(rawDiff, "+version https://git-lfs") ||
		strings.HasPrefix(rawDiff, "-version https://git-lfs")

	hasPointerPayloadChange := strings.Contains(rawDiff, "\n+oid sha256:") ||
		strings.Contains(rawDiff, "\n-oid sha256:") ||
		strings.HasPrefix(rawDiff, "+oid sha256:") ||
		strings.HasPrefix(rawDiff, "-oid sha256:") ||
		strings.Contains(rawDiff, "\n+size ") ||
		strings.Contains(rawDiff, "\n-size ") ||
		strings.HasPrefix(rawDiff, "+size ") ||
		strings.HasPrefix(rawDiff, "-size ")

	return hasLfsVersionContext && hasPointerPayloadChange
}

func (g *GitService) lfsContentUnavailableError(repoPath string, filePath string) string {
	lfsVersionResult := g.runner.RunGit(repoPath, "lfs", "version")
	if !lfsVersionResult.Success {
		return fmt.Sprintf("File '%s' is stored in Git LFS but the actual content could not be retrieved for diff because git-lfs is unavailable in this environment. Install git-lfs and run 'git lfs pull'.", filePath)
	}

	return fmt.Sprintf("File '%s' is stored in Git LFS but the actual content for this revision is not available locally for diff. The app attempted to fetch it automatically; run 'git lfs pull' and try again if the issue persists.", filePath)
}

// tryPullLFSForFile attempts to hydrate LFS content for the current checkout
// of a specific file path. Returns true when pull succeeds.
func (g *GitService) tryPullLFSForFile(repoPath string, filePath string) bool {
	g = g.forGitOperation()
	lfsCheck := g.runner.RunGit(repoPath, "lfs", "version")
	if !lfsCheck.Success {
		return false
	}

	remote, ok := g.getPreferredRemote(repoPath)
	if !ok {
		return false
	}

	includePath := filepath.ToSlash(strings.TrimPrefix(filePath, "./"))
	pullResult := g.runner.RunGit(repoPath, "lfs", "pull", "--include="+includePath, "--exclude=", remote)
	return pullResult.Success
}

// tryFetchLFSForFile attempts to fetch LFS objects for a specific file at the
// given refs. Returns true if the fetch completed without error (objects may
// now be available). Returns false when git-lfs is not installed or the fetch
// failed.
func (g *GitService) tryFetchLFSForFile(repoPath string, filePath string, refs ...string) bool {
	g = g.forGitOperation()
	// Verify git-lfs is available
	lfsCheck := g.runner.RunGit(repoPath, "lfs", "version")
	if !lfsCheck.Success {
		return false
	}

	remote, ok := g.getPreferredRemote(repoPath)
	if !ok {
		return false
	}

	// Normalise the path for the --include glob (forward slashes, no leading ./).
	includePath := filepath.ToSlash(strings.TrimPrefix(filePath, "./"))
	hadSuccess := false

	refCandidates := make([]string, 0, len(refs)*4)
	seenRefs := map[string]struct{}{}
	addRefCandidate := func(ref string) {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			return
		}
		if _, ok := seenRefs[ref]; ok {
			return
		}
		seenRefs[ref] = struct{}{}
		refCandidates = append(refCandidates, ref)
	}

	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}

		addRefCandidate(ref)

		if strings.HasPrefix(ref, "origin/") {
			addRefCandidate(strings.TrimPrefix(ref, "origin/"))
		}

		if !strings.HasPrefix(ref, "refs/") {
			addRefCandidate("refs/heads/" + ref)
			addRefCandidate("refs/remotes/origin/" + ref)
		}
	}

	for _, ref := range refCandidates {
		args := []string{"lfs", "fetch", "--include=" + includePath, remote, ref}
		result := g.runner.RunGit(repoPath, args...)
		if result.Success {
			hadSuccess = true
		}
	}

	if hadSuccess {
		return true
	}

	fallback := g.runner.RunGit(repoPath, "lfs", "fetch", "--include="+includePath, remote)
	if fallback.Success {
		return true
	}

	pullFallback := g.runner.RunGit(repoPath, "lfs", "pull", "--include="+includePath, "--exclude=", remote)
	if pullFallback.Success {
		return true
	}

	allFallback := g.runner.RunGit(repoPath, "lfs", "fetch", "--all", remote)
	return allFallback.Success
}

// EnsureLFSForRefs fetches LFS objects for a specific file at the given branch
// refs. This is exposed to the frontend so specialized diff viewers (image,
// PDF, L5X, 3D) can ensure LFS content is available before attempting to load
// file contents at those revisions.
func (g *GitService) EnsureLFSForRefs(repoPath string, filePath string, refs ...string) OperationResult {
	g = g.forGitOperation()
	done := LogMethod("GitService.EnsureLFSForRefs", map[string]interface{}{"repoPath": repoPath, "filePath": filePath, "refs": refs})
	defer func() { done(nil, nil) }()

	if repoPath == "" {
		return failedOp("Repository path is required")
	}
	if filePath == "" {
		return failedOp("File path is required")
	}

	lfsCheck := g.runner.RunGit(repoPath, "lfs", "version")
	if !lfsCheck.Success {
		return failedOp("Git LFS is not installed")
	}

	includePath := filepath.ToSlash(strings.TrimPrefix(filePath, "./"))
	var lastError string

	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		// Resolve the ref (handles plain branch names → origin/<branch>).
		resolved, err := g.resolveBranchRef(repoPath, ref, true)
		if err != nil {
			resolved = ref // Use as-is if resolution fails
		}
		remote, hasRemote := g.getPreferredRemote(repoPath)
		if !hasRemote {
			lastError = "No remote configured"
			continue
		}
		args := []string{"lfs", "fetch", "--include=" + includePath, remote, resolved}
		result := g.runner.RunGit(repoPath, args...)
		if !result.Success {
			lastError = getErrorMessage(result)
		}
	}

	if lastError != "" {
		// Return success anyway — best-effort. The viewer will show its own error
		// if objects are still missing.
		return successOp("LFS fetch completed with warnings")
	}
	return successOp("LFS objects fetched")
}

// EnsureOriginLFSForRef fetches LFS objects for one immutable ref from origin.
// A missing git-lfs installation is explicit but non-fatal because snapshots can
// still be used for non-LFS files.
func (g *GitService) EnsureOriginLFSForRef(repoPath string, ref string) OperationResult {
	g = g.forGitOperation()
	if repoPath == "" {
		return failedOp("Repository path is required")
	}
	if strings.TrimSpace(ref) == "" {
		return failedOp("Reference is required")
	}
	if _, err := g.OriginRemoteURL(repoPath); err != nil {
		return failedOp(err.Error())
	}

	lfsCheck := g.runner.RunGit(repoPath, "lfs", "version")
	if !lfsCheck.Success {
		available := false
		return OperationResult{
			Success:      true,
			Message:      "Git LFS is not installed; LFS objects were not hydrated",
			LFSAvailable: &available,
		}
	}

	result := g.runner.RunGit(repoPath, "lfs", "fetch", "origin", ref)
	if !result.Success {
		available := true
		return OperationResult{
			Success:      false,
			Error:        "Failed to fetch LFS objects: " + getErrorMessage(result),
			LFSAvailable: &available,
		}
	}

	available := true
	return OperationResult{
		Success:      true,
		Message:      "LFS objects fetched",
		LFSAvailable: &available,
	}
}

// Branches returns all branches in the repository
// Uses concurrent goroutines to fetch current, local, and remote branches in parallel
func (g *GitService) Branches(repoPath string) BranchList {
	done := LogMethod("GitService.Branches", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()
	result := BranchList{
		Local:  []BranchInfo{},
		Remote: []BranchInfo{},
	}

	var wg sync.WaitGroup
	var currentResult, localResult, remoteResult CommandResult

	// Run all three git commands concurrently
	wg.Add(3)

	// Get current branch
	go func() {
		defer wg.Done()
		currentResult = g.runner.RunGit(repoPath, "branch", "--show-current")
	}()

	// Get local branches with upstream info
	go func() {
		defer wg.Done()
		localResult = g.runner.RunGit(repoPath, "branch", "-vv")
	}()

	// Get remote branches
	go func() {
		defer wg.Done()
		remoteResult = g.runner.RunGit(repoPath, "branch", "-r")
	}()

	wg.Wait()

	// Process current branch result
	if currentResult.Success {
		result.Current = trimOutput(currentResult.Stdout)
	}

	// Process local branches result
	if !localResult.Success {
		result.HasError = true
		result.Error = "Failed to get branches: " + localResult.Stderr
		return result
	}

	lines := strings.Split(localResult.Stdout, "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		branch := BranchInfo{}
		branch.IsCurrent = strings.HasPrefix(line, "*")

		// Remove the * prefix and trim
		line = strings.TrimPrefix(line, "*")
		line = strings.TrimSpace(line)

		// Parse branch name (first word)
		parts := strings.Fields(line)
		if len(parts) == 0 {
			continue
		}
		branch.Name = parts[0]

		// Look for upstream in brackets [origin/main] or [origin/main: ahead 1]
		if idx := strings.Index(line, "["); idx != -1 {
			endIdx := strings.Index(line[idx:], "]")
			if endIdx != -1 {
				upstream := line[idx+1 : idx+endIdx]
				// Remove status info (: ahead, : behind, etc.)
				if colonIdx := strings.Index(upstream, ":"); colonIdx != -1 {
					upstream = upstream[:colonIdx]
				}
				branch.Upstream = upstream
			}
		}

		lastUpdatedResult := g.runner.RunGit(repoPath, "log", "-1", "--format=%ct", branch.Name)
		if lastUpdatedResult.Success {
			if unixTs, err := strconv.ParseInt(trimOutput(lastUpdatedResult.Stdout), 10, 64); err == nil {
				branch.LastUpdatedUnix = unixTs
			}
		}

		result.Local = append(result.Local, branch)
	}

	// Process remote branches result (already fetched concurrently)
	if remoteResult.Success {
		remoteLines := strings.Split(remoteResult.Stdout, "\n")
		for _, line := range remoteLines {
			line = strings.TrimSpace(line)
			if line == "" || strings.Contains(line, "->") {
				continue // Skip HEAD references like origin/HEAD -> origin/main
			}

			result.Remote = append(result.Remote, BranchInfo{
				Name:     line,
				IsRemote: true,
			})
		}
	}

	return result
}

// CheckoutBranch switches to an existing branch.
// Fails if there are uncommitted changes to prevent accidental loss.
func (g *GitService) CheckoutBranch(repoPath string, branchName string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationCheckout)
	done := LogMethod("GitService.CheckoutBranch", map[string]interface{}{"repoPath": repoPath, "branchName": branchName})
	defer func() { done(nil, nil) }()
	if branchName == "" {
		return failedOp("Branch name is required")
	}

	if err := g.requireCleanWorkingTree(repoPath); err != nil {
		return failedOp(err.Error())
	}

	result := g.runner.RunGit(repoPath, "checkout", branchName)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "did not match any") {
			return failedOp(fmt.Sprintf("Branch '%s' does not exist", branchName))
		}
		return failedOp("Failed to switch branch: " + errMsg)
	}

	return successOp(fmt.Sprintf("Switched to branch '%s'", branchName))
}

// CreateBranchAndCheckout creates a new branch and switches to it.
// Fails if there are uncommitted changes or if the branch name is invalid.
func (g *GitService) CreateBranchAndCheckout(repoPath string, branchName string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationCheckout)
	done := LogMethod("GitService.CreateBranchAndCheckout", map[string]interface{}{"repoPath": repoPath, "branchName": branchName})
	defer func() { done(nil, nil) }()
	if branchName == "" {
		return failedOp("Branch name is required")
	}

	if err := g.requireCleanWorkingTree(repoPath); err != nil {
		return failedOp(err.Error())
	}

	// Validate branch name (git's ref naming rules)
	if strings.ContainsAny(branchName, " \t\n~^:?*[\\") {
		return failedOp("Invalid branch name. Branch names cannot contain spaces or special characters like ~ ^ : ? * [ \\")
	}

	result := g.runner.RunGit(repoPath, "checkout", "-b", branchName)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "already exists") {
			return failedOp(fmt.Sprintf("Branch '%s' already exists", branchName))
		}
		return failedOp("Failed to create branch: " + errMsg)
	}

	return successOp(fmt.Sprintf("Created and switched to new branch '%s'", branchName))
}

// RenameBranch renames a local branch and, when it has an upstream, renames its
// remote-tracking branch by creating the new remote branch and deleting the old one.
// This operation is all-or-fail: on remote failures, it attempts best-effort rollback.
// Requires confirm=true as a safety measure.
func (g *GitService) RenameBranch(repoPath string, oldName string, newName string, confirm bool) OperationResult {
	done := LogMethod("GitService.RenameBranch", map[string]interface{}{"repoPath": repoPath, "oldName": oldName, "newName": newName, "confirm": confirm})
	defer func() { done(nil, nil) }()

	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)

	if oldName == "" || newName == "" {
		return failedOp("Old and new branch names are required")
	}
	if oldName == newName {
		return failedOp("New branch name must be different from the current name")
	}
	if isProtectedBranchName(oldName) {
		return failedOp(fmt.Sprintf("Branch '%s' is protected and cannot be renamed", oldName))
	}

	nameValidation := g.runner.RunGit(repoPath, "check-ref-format", "--branch", newName)
	if !nameValidation.Success {
		return failedOp("Invalid new branch name: " + getErrorMessage(nameValidation))
	}

	if !g.localBranchExists(repoPath, oldName) {
		return failedOp(fmt.Sprintf("Branch '%s' does not exist", oldName))
	}
	if g.localBranchExists(repoPath, newName) {
		return failedOp(fmt.Sprintf("Branch '%s' already exists", newName))
	}

	upstream := g.getLocalBranchUpstream(repoPath, oldName)
	remote, remoteBranch, hasUpstream := parseUpstream(upstream)

	renameResult := g.runner.RunGit(repoPath, "branch", "-m", oldName, newName)
	if !renameResult.Success {
		return failedOp("Failed to rename branch: " + getErrorMessage(renameResult))
	}

	if !hasUpstream {
		return successOp(fmt.Sprintf("Renamed branch '%s' to '%s'", oldName, newName))
	}

	g = g.forGitOperation()
	pushNewResult := g.runner.RunGit(repoPath, "push", remote, "refs/heads/"+newName+":refs/heads/"+newName)
	if !pushNewResult.Success {
		if rollbackErr := g.rollbackBranchRename(repoPath, newName, oldName); rollbackErr != nil {
			return failedOp(fmt.Sprintf("Failed to rename remote branch: %s. Also failed to rollback local rename: %s", getErrorMessage(pushNewResult), rollbackErr.Error()))
		}
		return failedOp("Failed to rename remote branch: " + getErrorMessage(pushNewResult))
	}

	setUpstreamResult := g.runner.RunGit(repoPath, "branch", "--set-upstream-to", remote+"/"+newName, newName)
	if !setUpstreamResult.Success {
		g.runner.RunGit(repoPath, "push", remote, "--delete", newName)
		if rollbackErr := g.rollbackBranchRename(repoPath, newName, oldName); rollbackErr != nil {
			return failedOp(fmt.Sprintf("Failed to update upstream after remote rename: %s. Also failed to rollback local rename: %s", getErrorMessage(setUpstreamResult), rollbackErr.Error()))
		}
		return failedOp("Failed to update upstream after remote rename: " + getErrorMessage(setUpstreamResult))
	}

	deleteOldRemoteResult := g.runner.RunGit(repoPath, "push", remote, "--delete", remoteBranch)
	if !deleteOldRemoteResult.Success {
		g.runner.RunGit(repoPath, "push", remote, "--delete", newName)
		if rollbackErr := g.rollbackBranchRename(repoPath, newName, oldName); rollbackErr != nil {
			return failedOp(fmt.Sprintf("Failed to delete old remote branch '%s/%s': %s. Also failed to rollback local rename: %s", remote, remoteBranch, getErrorMessage(deleteOldRemoteResult), rollbackErr.Error()))
		}
		return failedOp(fmt.Sprintf("Failed to delete old remote branch '%s/%s': %s", remote, remoteBranch, getErrorMessage(deleteOldRemoteResult)))
	}

	return successOp(fmt.Sprintf("Renamed branch '%s' to '%s' locally and on remote '%s'", oldName, newName, remote))
}

// DeleteBranch deletes a local branch and, when it has an upstream, deletes the remote branch too.
// Requires confirm=true as a safety measure.
func (g *GitService) DeleteBranch(repoPath string, branchName string, confirm bool) OperationResult {
	done := LogMethod("GitService.DeleteBranch", map[string]interface{}{"repoPath": repoPath, "branchName": branchName, "confirm": confirm})
	defer func() { done(nil, nil) }()

	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	branchName = strings.TrimSpace(branchName)
	if branchName == "" {
		return failedOp("Branch name is required")
	}
	if isProtectedBranchName(branchName) {
		return failedOp(fmt.Sprintf("Branch '%s' is protected and cannot be deleted", branchName))
	}
	if !g.localBranchExists(repoPath, branchName) {
		return failedOp(fmt.Sprintf("Branch '%s' does not exist", branchName))
	}

	currentBranch, err := g.GetCurrentBranch(repoPath)
	if err != nil {
		return failedOp("Failed to determine current branch: " + err.Error())
	}
	if currentBranch == branchName {
		return failedOp("Cannot delete the currently checked-out branch")
	}

	upstream := g.getLocalBranchUpstream(repoPath, branchName)
	remote, remoteBranch, hasUpstream := parseUpstream(upstream)

	if hasUpstream {
		g = g.forGitOperation()
		deleteRemoteResult := g.runner.RunGit(repoPath, "push", remote, "--delete", remoteBranch)
		if !deleteRemoteResult.Success {
			return failedOp(fmt.Sprintf("Failed to delete remote branch '%s/%s': %s", remote, remoteBranch, getErrorMessage(deleteRemoteResult)))
		}
	}

	deleteLocalResult := g.runner.RunGit(repoPath, "branch", "-D", branchName)
	if !deleteLocalResult.Success {
		if hasUpstream {
			restoreRemoteResult := g.runner.RunGit(repoPath, "push", remote, "refs/heads/"+branchName+":refs/heads/"+remoteBranch)
			if !restoreRemoteResult.Success {
				return failedOp(fmt.Sprintf("Failed to delete local branch '%s': %s. Also failed to restore remote branch '%s/%s': %s", branchName, getErrorMessage(deleteLocalResult), remote, remoteBranch, getErrorMessage(restoreRemoteResult)))
			}
		}
		return failedOp(fmt.Sprintf("Failed to delete local branch '%s': %s", branchName, getErrorMessage(deleteLocalResult)))
	}

	if hasUpstream {
		return successOp(fmt.Sprintf("Deleted branch '%s' locally and removed remote branch '%s/%s'", branchName, remote, remoteBranch))
	}

	return successOp(fmt.Sprintf("Deleted local branch '%s'", branchName))
}

// ResetHardHead resets the working directory to HEAD, discarding all uncommitted changes.
// This is the "Rewind" feature - returns to the last committed state.
// Requires confirm=true as a safety measure for destructive operations.
// This is a composite operation that combines ResetHard("HEAD") + Clean().
// For finer control, use ResetHard() and Clean() separately.
func (g *GitService) ResetHardHead(repoPath string, confirm bool) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationOther)
	done := LogMethod("GitService.ResetHardHead", map[string]interface{}{"repoPath": repoPath, "confirm": confirm})
	defer func() { done(nil, nil) }()
	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	hasChanges, err := g.HasChanges(repoPath)
	if err != nil {
		return failedOp("Failed to check status: " + err.Error())
	}
	if !hasChanges {
		return failedOp("No changes to rewind")
	}

	// Reset tracked files using primitive
	resetResult := g.ResetHard(repoPath, "HEAD")
	if !resetResult.Success {
		return failedOp("Failed to rewind: " + resetResult.Error)
	}

	// Clean untracked files using primitive (ignore failure - may have nothing to clean)
	g.Clean(repoPath)

	return successOp("Rewound to last snapshot. All uncommitted changes have been discarded.")
}

// ResetSoftHead undoes the last n commits, keeping changes staged.
// This is the "Undo Last Save" feature - changes remain in the working directory.
// Requires confirm=true as a safety measure for destructive operations.
// This is a wrapper around ResetSoft() with validation.
func (g *GitService) ResetSoftHead(repoPath string, n int, confirm bool) OperationResult {
	done := LogMethod("GitService.ResetSoftHead", map[string]interface{}{"repoPath": repoPath, "n": n, "confirm": confirm})
	defer func() { done(nil, nil) }()
	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	if n <= 0 {
		return failedOp("Number of commits to undo must be greater than 0")
	}

	// Verify sufficient commit history exists
	commits, err := g.GetRecentCommits(repoPath, n+1)
	if err != nil || len(commits) < n {
		return failedOp(fmt.Sprintf("Cannot undo %d commit(s). Not enough commits in history.", n))
	}

	// Use primitive
	resetResult := g.ResetSoft(repoPath, fmt.Sprintf("HEAD~%d", n))
	if !resetResult.Success {
		return failedOp("Failed to undo commits: " + resetResult.Error)
	}

	plural := pluralize("commit", n)
	return successOp(fmt.Sprintf("Undid last %d %s. Your changes are still staged.", n, plural))
}

// DiscardAll discards all uncommitted changes in the working directory.
// This includes modified files, staged changes, and untracked files.
// Requires confirm=true as a safety measure for destructive operations.
// This is a composite operation that combines UnstageAll() + RestoreAll() + Clean().
// For finer control, use those methods separately.
func (g *GitService) DiscardAll(repoPath string, confirm bool) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationOther)
	done := LogMethod("GitService.DiscardAll", map[string]interface{}{"repoPath": repoPath, "confirm": confirm})
	defer func() { done(nil, nil) }()
	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	hasChanges, err := g.HasChanges(repoPath)
	if err != nil {
		return failedOp("Failed to check status: " + err.Error())
	}
	if !hasChanges {
		return failedOp("No changes to discard")
	}

	// First unstage any staged changes
	g.UnstageAll(repoPath) // Ignore error - may have nothing staged

	// Restore tracked files to HEAD state using primitive
	restoreResult := g.RestoreAll(repoPath)
	if !restoreResult.Success {
		return failedOp("Failed to discard changes: " + restoreResult.Error)
	}

	// Clean untracked files using primitive (ignore failure - may have nothing to clean)
	g.Clean(repoPath)

	return successOp("All changes have been discarded")
}

// DiscardFile discards changes to a specific file.
// For untracked files, the file is deleted. For tracked files, changes are reverted to HEAD.
// Requires confirm=true as a safety measure for destructive operations.
// This is a composite operation that combines Unstage() + Restore() or file deletion.
// For finer control, use those methods separately.
func (g *GitService) DiscardFile(repoPath string, filePath string, confirm bool) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationOther)
	done := LogMethod("GitService.DiscardFile", map[string]interface{}{"repoPath": repoPath, "filePath": filePath, "confirm": confirm})
	defer func() { done(nil, nil) }()
	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	if filePath == "" {
		return failedOp("File path is required")
	}

	// Check if file has changes
	statusResult := g.runner.RunGit(repoPath, "status", "--porcelain", "--", filePath)
	if !statusResult.Success || trimOutput(statusResult.Stdout) == "" {
		return failedOp("File has no changes to discard")
	}

	// Handle untracked files by deleting them
	if len(statusResult.Stdout) >= 2 && statusResult.Stdout[:2] == "??" {
		fullPath := filepath.Join(repoPath, filePath)
		if err := os.Remove(fullPath); err != nil {
			return failedOp("Failed to remove untracked file: " + err.Error())
		}
		return successOp(fmt.Sprintf("Removed untracked file '%s'", filePath))
	}

	// For tracked files: first unstage if staged, then restore
	g.Unstage(repoPath, filePath) // Ignore error - may not be staged

	restoreResult := g.Restore(repoPath, filePath)
	if !restoreResult.Success {
		return failedOp("Failed to discard changes: " + restoreResult.Error)
	}

	return successOp(fmt.Sprintf("Discarded changes to '%s'", filePath))
}

// ============================================================================
// v2 Additions - Stash Operations
// ============================================================================

// StashEntry represents a single stash entry
type StashEntry struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`    // e.g., "stash@{0}"
	Message string `json:"message"` // Stash message
	Branch  string `json:"branch"`  // Branch the stash was created on
}

// StashPush creates a new stash with an optional message.
// Stashes all tracked changes (staged and unstaged).
func (g *GitService) StashPush(repoPath string, message string) OperationResult {
	done := LogMethod("GitService.StashPush", map[string]interface{}{"repoPath": repoPath, "message": message})
	defer func() { done(nil, nil) }()
	status := g.Status(repoPath)
	if !status.HasChanges {
		return failedOp("No changes to stash")
	}

	args := []string{"stash", "push"}
	if message != "" {
		args = append(args, "-m", message)
	}

	result := g.runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to stash changes: " + getErrorMessage(result))
	}

	return successOp("Changes stashed successfully")
}

// StashPop applies the most recent stash and removes it from the stash list.
func (g *GitService) StashPop(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationStash)
	done := LogMethod("GitService.StashPop", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()
	result := g.runner.RunGit(repoPath, "stash", "pop")
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "No stash entries") {
			return failedOp("No stashes to apply")
		}
		if strings.Contains(errMsg, "CONFLICT") || strings.Contains(errMsg, "conflict") {
			return failedOp("Conflict while applying stash. Please resolve conflicts manually.")
		}
		return failedOp("Failed to apply stash: " + errMsg)
	}

	return successOp("Stash applied and removed")
}

// StashList returns all stash entries.
func (g *GitService) StashList(repoPath string) ([]StashEntry, error) {
	result := g.runner.RunGit(repoPath, "stash", "list", "--pretty=format:%gd|%gs")
	if !result.Success {
		return nil, fmt.Errorf("failed to list stashes: %s", getErrorMessage(result))
	}

	output := strings.TrimSpace(result.Stdout)
	if output == "" {
		return []StashEntry{}, nil
	}

	lines := strings.Split(output, "\n")
	entries := make([]StashEntry, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "|", 2)
		// Parse index from stash ref like "stash@{0}"
		stashIdx := len(entries) // fallback to order in list
		if len(parts[0]) > 0 {
			// Extract number from "stash@{N}"
			if start := strings.Index(parts[0], "{"); start >= 0 {
				if end := strings.Index(parts[0], "}"); end > start {
					if n, err := strconv.Atoi(parts[0][start+1 : end]); err == nil {
						stashIdx = n
					}
				}
			}
		}

		entry := StashEntry{
			Index: stashIdx,
			Name:  parts[0],
		}
		if len(parts) > 1 {
			entry.Message = parts[1]
			// Extract branch from message like "WIP on main: abc123 commit msg"
			if strings.HasPrefix(entry.Message, "WIP on ") || strings.HasPrefix(entry.Message, "On ") {
				if colonIdx := strings.Index(entry.Message, ":"); colonIdx > 0 {
					branchPart := entry.Message[:colonIdx]
					if spaceIdx := strings.LastIndex(branchPart, " "); spaceIdx > 0 {
						entry.Branch = branchPart[spaceIdx+1:]
					}
				}
			}
		}
		entries = append(entries, entry)
	}

	return entries, nil
}

// StashDrop removes a specific stash entry by index.
// Requires confirm=true as a safety measure.
func (g *GitService) StashDrop(repoPath string, index int, confirm bool) OperationResult {
	done := LogMethod("GitService.StashDrop", map[string]interface{}{"repoPath": repoPath, "index": index, "confirm": confirm})
	defer func() { done(nil, nil) }()
	if err := requireConfirmation(confirm); err != nil {
		return failedOp(err.Error())
	}

	stashRef := fmt.Sprintf("stash@{%d}", index)
	result := g.runner.RunGit(repoPath, "stash", "drop", stashRef)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "does not exist") || strings.Contains(errMsg, "No stash entries") {
			return failedOp(fmt.Sprintf("Stash entry %s does not exist", stashRef))
		}
		return failedOp("Failed to drop stash: " + errMsg)
	}

	return successOp(fmt.Sprintf("Dropped %s", stashRef))
}

// StashAndSwitchBranch performs a safe branch switch by stashing changes first.
// Flow: stash push → checkout (or checkout -b if createNew) → stash pop
// If the stash pop fails due to conflicts, the stash is preserved.
func (g *GitService) StashAndSwitchBranch(repoPath string, targetBranch string, createNew bool) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationStash)
	done := LogMethod("GitService.StashAndSwitchBranch", map[string]interface{}{"repoPath": repoPath, "targetBranch": targetBranch, "createNew": createNew})
	defer func() { done(nil, nil) }()
	if targetBranch == "" {
		return failedOp("Branch name is required")
	}

	// Check if we have changes to stash
	status := g.Status(repoPath)
	hadChanges := status.HasChanges

	if hadChanges {
		// Stash changes
		stashResult := g.StashPush(repoPath, fmt.Sprintf("Auto-stash before switching to %s", targetBranch))
		if !stashResult.Success {
			return stashResult
		}
	}

	// Switch to the target branch
	var switchResult OperationResult
	if createNew {
		result := g.runner.RunGit(repoPath, "checkout", "-b", targetBranch)
		if !result.Success {
			errMsg := getErrorMessage(result)
			// Try to recover the stash if branch creation failed
			if hadChanges {
				g.StashPop(repoPath)
			}
			if strings.Contains(errMsg, "already exists") {
				return failedOp(fmt.Sprintf("Branch '%s' already exists", targetBranch))
			}
			return failedOp("Failed to create branch: " + errMsg)
		}
		switchResult = successOp(fmt.Sprintf("Created and switched to '%s'", targetBranch))
	} else {
		result := g.runner.RunGit(repoPath, "checkout", targetBranch)
		if !result.Success {
			errMsg := getErrorMessage(result)
			// Try to recover the stash if switch failed
			if hadChanges {
				g.StashPop(repoPath)
			}
			if strings.Contains(errMsg, "did not match") {
				return failedOp(fmt.Sprintf("Branch '%s' does not exist", targetBranch))
			}
			return failedOp("Failed to switch branch: " + errMsg)
		}
		switchResult = successOp(fmt.Sprintf("Switched to '%s'", targetBranch))
	}

	// Restore stashed changes if we had any
	if hadChanges {
		popResult := g.StashPop(repoPath)
		if !popResult.Success {
			// Stash pop failed (likely conflict) - inform user but keep on new branch
			return OperationResult{
				Success: true,
				Message: fmt.Sprintf("%s. Note: Could not restore your changes automatically. They are saved in the stash - use 'git stash pop' manually after resolving any conflicts.", switchResult.Message),
			}
		}
		return successOp(fmt.Sprintf("%s with your changes", switchResult.Message))
	}

	return switchResult
}

// ============================================================================
// v2 Additions - Conflict Resolution & Stuck State Detection
// ============================================================================

// MergeState represents the current repository operation state.
// Extended to detect all common "stuck" states that can confuse users.
// Priority for display: Locked > Merge > Cherry-Pick > Revert > Bisect > AM > Rebase (abort-only) > Detached HEAD
// Note: Rebase is detected for abort purposes only - users should abort and use merge workflow instead.
type MergeState struct {
	// Core merge state
	InMerge       bool   `json:"inMerge"`
	InSquashMerge bool   `json:"inSquashMerge"` // .git/SQUASH_MSG exists (squash merge in progress)
	InRebase      bool   `json:"inRebase"`      // Detected for abort only - rebase workflow is deprecated
	HasConflicts  bool   `json:"hasConflicts"`
	Message       string `json:"message,omitempty"` // Merge commit message if available

	// Additional stuck states
	InCherryPick bool `json:"inCherryPick"` // .git/CHERRY_PICK_HEAD exists
	InRevert     bool `json:"inRevert"`     // .git/REVERT_HEAD exists
	InBisect     bool `json:"inBisect"`     // .git/BISECT_LOG exists
	InAM         bool `json:"inAM"`         // .git/rebase-apply/applying exists
	IsDetached   bool `json:"isDetached"`   // HEAD points to commit hash, not branch
	HasLockFile  bool `json:"hasLockFile"`  // .git/index.lock exists (stale lock)

	// Additional context
	DetachedAt  string   `json:"detachedAt,omitempty"`  // Commit hash when detached
	LockFiles   []string `json:"lockFiles,omitempty"`   // List of lock files found
	StuckType   string   `json:"stuckType,omitempty"`   // Primary stuck state type for UI
	UserMessage string   `json:"userMessage,omitempty"` // User-friendly explanation
}

// ConflictedFile represents a file with merge conflicts
type ConflictedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "both-modified", "deleted-by-us", "deleted-by-them", "both-added"
}

// GetMergeState detects if the repository is in any stuck/interrupted state.
// Checks for: merge, rebase, cherry-pick, revert, bisect, AM, detached HEAD, and stale locks.
func (g *GitService) GetMergeState(repoPath string) MergeState {
	done := LogMethod("GitService.GetMergeState", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()
	state := MergeState{}

	// Ask git where its administrative files are. A linked worktree keeps
	// per-worktree state outside <repo>/.git, so joining ".git" is wrong there.
	// One rev-parse call resolves every name, in order.
	adminNames := []string{
		"MERGE_HEAD", "MERGE_MSG", "SQUASH_MSG",
		"rebase-merge", "rebase-apply", "rebase-apply/applying",
		"CHERRY_PICK_HEAD", "REVERT_HEAD",
		"BISECT_LOG", "BISECT_START", "HEAD",
		"index.lock", "HEAD.lock", "config.lock",
	}
	resolved, err := gitAdminPaths(g.runner, repoPath, adminNames...)
	if err != nil {
		return state
	}
	gitPaths := make(map[string]string, len(adminNames))
	for i, name := range adminNames {
		gitPaths[name] = resolved[i]
	}

	// Check for merge in progress (MERGE_HEAD)
	mergePath := gitPaths["MERGE_HEAD"]
	if _, err := os.Stat(mergePath); err == nil {
		state.InMerge = true
		state.StuckType = "merge"
		state.UserMessage = "A merge operation was interrupted. Resolve conflicts or abort to continue."
		// Try to read the merge message
		msgPath := gitPaths["MERGE_MSG"]
		if msgData, err := os.ReadFile(msgPath); err == nil {
			state.Message = strings.TrimSpace(string(msgData))
		}
	}

	// Check for squash merge in progress (SQUASH_MSG)
	// git merge --squash does NOT create MERGE_HEAD, so we detect it separately.
	squashMsgPath := gitPaths["SQUASH_MSG"]
	if _, err := os.Stat(squashMsgPath); err == nil {
		state.InSquashMerge = true
		if state.StuckType == "" {
			state.StuckType = "squash-merge"
			state.UserMessage = "A squash merge is in progress. Resolve any conflicts and commit, or abort."
		}
		// Try to read the squash message
		if msgData, err := os.ReadFile(squashMsgPath); err == nil {
			if state.Message == "" {
				state.Message = strings.TrimSpace(string(msgData))
			}
		}
	}

	// Check for rebase in progress (rebase-merge or rebase-apply)
	// Note: Rebase workflow is deprecated - we only detect it to help users abort
	rebasePath := gitPaths["rebase-merge"]
	rebaseApplyPath := gitPaths["rebase-apply"]
	if _, err := os.Stat(rebasePath); err == nil {
		state.InRebase = true
		if state.StuckType == "" {
			state.StuckType = "rebase"
			state.UserMessage = "A rebase operation was interrupted. Abort it to return to a clean state."
		}
	} else if _, err := os.Stat(rebaseApplyPath); err == nil {
		// Check if it's actually an AM operation (patch application)
		applyingPath := gitPaths["rebase-apply/applying"]
		if _, err := os.Stat(applyingPath); err == nil {
			state.InAM = true
			if state.StuckType == "" {
				state.StuckType = "am"
				state.UserMessage = "A patch application was interrupted. Skip the patch or abort."
			}
		} else {
			state.InRebase = true
			if state.StuckType == "" {
				state.StuckType = "rebase"
				state.UserMessage = "A rebase operation was interrupted. Abort it to return to a clean state."
			}
		}
	}

	// Check for cherry-pick in progress (CHERRY_PICK_HEAD)
	cherryPickPath := gitPaths["CHERRY_PICK_HEAD"]
	if _, err := os.Stat(cherryPickPath); err == nil {
		state.InCherryPick = true
		if state.StuckType == "" {
			state.StuckType = "cherry-pick"
			state.UserMessage = "A cherry-pick operation was interrupted. Resolve conflicts or abort."
		}
	}

	// Check for revert in progress (REVERT_HEAD)
	revertPath := gitPaths["REVERT_HEAD"]
	if _, err := os.Stat(revertPath); err == nil {
		state.InRevert = true
		if state.StuckType == "" {
			state.StuckType = "revert"
			state.UserMessage = "Undoing a previous save caused conflicts. Resolve or abort."
		}
	}

	// Check for bisect in progress (BISECT_LOG or BISECT_START)
	bisectLogPath := gitPaths["BISECT_LOG"]
	bisectStartPath := gitPaths["BISECT_START"]
	if _, err := os.Stat(bisectLogPath); err == nil {
		state.InBisect = true
		if state.StuckType == "" {
			state.StuckType = "bisect"
			state.UserMessage = "Bug search in progress. Complete the search or abort to resume normal work."
		}
	} else if _, err := os.Stat(bisectStartPath); err == nil {
		state.InBisect = true
		if state.StuckType == "" {
			state.StuckType = "bisect"
			state.UserMessage = "Bug search in progress. Complete the search or abort to resume normal work."
		}
	}

	// Check for detached HEAD state
	headPath := gitPaths["HEAD"]
	if headData, err := os.ReadFile(headPath); err == nil {
		headContent := strings.TrimSpace(string(headData))
		// If HEAD contains a commit hash instead of "ref: refs/heads/..."
		if !strings.HasPrefix(headContent, "ref:") {
			state.IsDetached = true
			state.DetachedAt = headContent
			if state.StuckType == "" {
				state.StuckType = "detached"
				state.UserMessage = "You're not on any branch. Create a branch to save your work."
			}
		}
	}

	// Check for stale lock files (index.lock and others)
	lockFiles := []string{}
	potentialLocks := []string{"index.lock", "HEAD.lock", "config.lock"}
	for _, lockFile := range potentialLocks {
		if _, err := os.Stat(gitPaths[lockFile]); err == nil {
			lockFiles = append(lockFiles, lockFile)
		}
	}
	if len(lockFiles) > 0 {
		state.HasLockFile = true
		state.LockFiles = lockFiles
		// Lock files are highest priority
		state.StuckType = "locked"
		state.UserMessage = "A previous operation didn't complete cleanly. Remove the lock to continue."
	}

	// Check for conflicts
	conflicted, _ := g.GetConflictedFiles(repoPath)
	state.HasConflicts = len(conflicted) > 0

	return state
}

// GetConflictedFiles returns a list of files with merge conflicts.
func (g *GitService) GetConflictedFiles(repoPath string) ([]ConflictedFile, error) {
	// Use git status to find files with conflicts
	result := g.runner.RunGit(repoPath, "status", "--porcelain")
	if !result.Success {
		return nil, fmt.Errorf("failed to get status: %s", getErrorMessage(result))
	}

	conflicted := []ConflictedFile{}
	lines := strings.Split(result.Stdout, "\n")
	for _, line := range lines {
		if len(line) < 3 {
			continue
		}

		xy := line[:2]
		path := unquoteGitPath(line[3:])

		// Conflict indicators in porcelain format:
		// UU = both modified (most common)
		// AA = both added
		// DD = both deleted
		// DU = deleted by us, modified by them
		// UD = modified by us, deleted by them
		// AU = added by us, modified by them
		// UA = modified by us, added by them
		var status string
		switch xy {
		case "UU":
			status = "both-modified"
		case "AA":
			status = "both-added"
		case "DD":
			status = "both-deleted"
		case "DU", "AU":
			status = "deleted-by-us"
		case "UD", "UA":
			status = "deleted-by-them"
		default:
			continue // Not a conflict
		}

		conflicted = append(conflicted, ConflictedFile{
			Path:   path,
			Status: status,
		})
	}

	return conflicted, nil
}

// ResolveConflictKeepOurs resolves a conflict by keeping our version.
// Runs: git checkout --ours <path> && git add <path>
func (g *GitService) ResolveConflictKeepOurs(repoPath string, filePath string) OperationResult {
	done := LogMethod("GitService.ResolveConflictKeepOurs", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()
	if filePath == "" {
		return failedOp("File path is required")
	}

	return g.resolveConflictWithStage(repoPath, filePath, 2, "current", g.conflictOperationActive(repoPath, true))
}

// ResolveConflictKeepTheirs resolves a conflict by keeping their version.
// Runs: git checkout --theirs <path> && git add <path>
func (g *GitService) ResolveConflictKeepTheirs(repoPath string, filePath string) OperationResult {
	done := LogMethod("GitService.ResolveConflictKeepTheirs", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()
	if filePath == "" {
		return failedOp("File path is required")
	}

	return g.resolveConflictWithStage(repoPath, filePath, 3, "incoming", g.conflictOperationActive(repoPath, true))
}

// ResolveConflictKeepBoth resolves a conflict by keeping both versions.
// The incoming (theirs) version keeps the original filename.
// The local (mine) version is saved with a timestamp suffix to avoid collisions.
// For example: file.txt becomes incoming version, file_COPY_20260115_143052.txt is local version.
func (g *GitService) ResolveConflictKeepBoth(repoPath string, filePath string) OperationResult {
	g = g.forGitOperation()
	done := LogMethod("GitService.ResolveConflictKeepBoth", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()
	if filePath == "" {
		return failedOp("File path is required")
	}

	// Use git show to get the local version (stage 2 is "ours")
	oursResult := g.runner.RunGit(repoPath, "show", ":2:"+filePath)
	if !oursResult.Success {
		return failedOp("Failed to get local version: " + getErrorMessage(oursResult))
	}
	oursContent := oursResult.Stdout

	// Generate the copy filename with timestamp to avoid collisions
	// Format: basename_COPY_YYYYMMDD_HHMMSS.ext
	ext := filepath.Ext(filePath)
	baseName := strings.TrimSuffix(filePath, ext)
	timestamp := time.Now().Format("20060102_150405") // Go reference time format
	localCopyPath := baseName + "_COPY_" + timestamp + ext
	fullLocalCopyPath := filepath.Join(repoPath, localCopyPath)

	// Write the local (mine) version to the timestamped copy file
	if err := os.WriteFile(fullLocalCopyPath, []byte(oursContent), 0644); err != nil {
		return failedOp("Failed to write local copy file: " + err.Error())
	}

	// Resolve the original file by keeping theirs (incoming version)
	result := g.runner.RunGit(repoPath, "checkout", "--theirs", "--", filePath)
	if !result.Success {
		// Clean up the copy file we created
		os.Remove(fullLocalCopyPath)
		return failedOp("Failed to resolve conflict: " + getErrorMessage(result))
	}

	// Stage both files
	addResult := g.runner.RunGit(repoPath, "add", "--", filePath, localCopyPath)
	if !addResult.Success {
		return failedOp("Failed to stage resolved files: " + getErrorMessage(addResult))
	}

	return successOp(fmt.Sprintf("Kept both versions: '%s' (incoming) and '%s' (your local copy)", filepath.Base(filePath), filepath.Base(localCopyPath)))
}

// MarkResolved marks a file as resolved after manual editing.
// Runs: git add <path>
func (g *GitService) MarkResolved(repoPath string, filePath string) OperationResult {
	done := LogMethod("GitService.MarkResolved", map[string]interface{}{"repoPath": repoPath, "filePath": filePath})
	defer func() { done(nil, nil) }()
	if filePath == "" {
		return failedOp("File path is required")
	}

	result := g.runner.RunGit(repoPath, "add", "--", filePath)
	if !result.Success {
		return failedOp("Failed to mark as resolved: " + getErrorMessage(result))
	}

	return successOp(fmt.Sprintf("Marked '%s' as resolved", filePath))
}

// prepareMergeTargetBaseline enforces the merge preflight baseline sequence:
// 1. git fetch <preferred-remote> --prune (when a remote exists)
// 2. git checkout <target>
// 3. git pull --ff-only <preferred-remote> <target> (when a remote exists)
//
// Returns the branch that was checked out before preflight started so callers can restore it
// when a failure occurs.
func (g *GitService) prepareMergeTargetBaseline(repoPath string, targetBranch string) (string, error) {
	g = g.forGitOperation()
	targetBranch = strings.TrimSpace(targetBranch)
	if targetBranch == "" {
		return "", fmt.Errorf("target branch is required")
	}

	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return "", fmt.Errorf("not a valid git repository")
	}

	originalBranch := repoInfo.Branch
	if strings.TrimSpace(originalBranch) == "" {
		return "", fmt.Errorf("could not determine current branch (detached HEAD?)")
	}

	preferredRemote, hasRemote := g.getPreferredRemote(repoPath)

	// Local-only repositories intentionally bypass remote preflight.
	if !hasRemote {
		checkoutResult := g.runner.RunGit(repoPath, "checkout", targetBranch)
		if !checkoutResult.Success {
			return originalBranch, fmt.Errorf("failed to checkout target branch '%s': %s", targetBranch, getErrorMessage(checkoutResult))
		}
		return originalBranch, nil
	}

	fetchResult := g.runner.RunGit(repoPath, "fetch", preferredRemote, "--prune")
	if !fetchResult.Success {
		return originalBranch, fmt.Errorf("failed to fetch from remote '%s' before merge: %s", preferredRemote, getErrorMessage(fetchResult))
	}

	checkoutResult := g.runner.RunGit(repoPath, "checkout", targetBranch)
	if !checkoutResult.Success {
		return originalBranch, fmt.Errorf("failed to checkout target branch '%s': %s", targetBranch, getErrorMessage(checkoutResult))
	}

	pullResult := g.runner.RunGit(repoPath, "pull", "--ff-only", preferredRemote, targetBranch)
	if !pullResult.Success {
		errMsg := getErrorMessage(pullResult)
		errMsgLower := strings.ToLower(errMsg)
		if strings.Contains(errMsgLower, "not possible to fast-forward") ||
			strings.Contains(errMsgLower, "cannot fast-forward") ||
			strings.Contains(errMsgLower, "divergent branches") ||
			strings.Contains(errMsgLower, "non-fast-forward") {
			return originalBranch, fmt.Errorf("target branch is not fast-forwardable to %s/%s. Resolve divergence first (rebase or manual merge), then retry", preferredRemote, targetBranch)
		}

		return originalBranch, fmt.Errorf("failed to update target branch '%s' from %s/%s: %s", targetBranch, preferredRemote, targetBranch, errMsg)
	}

	localHeadResult := g.runner.RunGit(repoPath, "rev-parse", "HEAD")
	remoteHeadResult := g.runner.RunGit(repoPath, "rev-parse", preferredRemote+"/"+targetBranch)
	if !localHeadResult.Success || !remoteHeadResult.Success {
		return originalBranch, fmt.Errorf("failed to validate target branch baseline against %s/%s", preferredRemote, targetBranch)
	}

	localHead := strings.TrimSpace(localHeadResult.Stdout)
	remoteHead := strings.TrimSpace(remoteHeadResult.Stdout)
	if localHead == "" || remoteHead == "" || localHead != remoteHead {
		return originalBranch, fmt.Errorf("target branch is not fast-forwardable to %s/%s. Resolve divergence first (rebase or manual merge), then retry", preferredRemote, targetBranch)
	}

	return originalBranch, nil
}

// StartMerge begins an actual merge.
// Uses --no-commit to allow the user to resolve conflicts before committing.
// This is called after CheckBranchConflicts confirms there will be conflicts.
//
// Default behavior (when sourceBranch is empty):
// - Merges the current branch INTO the targetBranch
// - First checks out targetBranch, then merges the original current branch
//
// Parameterized behavior (when both are provided):
// - Checks out targetBranch
// - Merges sourceBranch into it
//
// Parameters:
//   - repoPath: Path to the git repository
//   - targetBranch: The branch to merge INTO (e.g., "main") - required
//   - sourceBranch: The branch to merge FROM (optional, defaults to current branch)
func (g *GitService) StartMerge(repoPath string, targetBranch string, sourceBranch ...string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationMerge)
	done := LogMethod("GitService.StartMerge", map[string]interface{}{"repoPath": repoPath, "targetBranch": targetBranch})
	defer func() { done(nil, nil) }()
	if targetBranch == "" {
		return failedOp("Target branch is required")
	}

	// Determine source branch (default to current branch if not provided)
	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return failedOp("Not a valid git repository")
	}

	source := ""
	if len(sourceBranch) > 0 && sourceBranch[0] != "" {
		source = sourceBranch[0]
	} else {
		source = repoInfo.Branch
		if source == "" {
			return failedOp("Could not determine current branch (detached HEAD?)")
		}
	}

	// Don't allow merging a branch into itself
	if source == targetBranch {
		return failedOp("Cannot merge a branch into itself")
	}

	// Check if already in a merge state - if so, we can continue with existing merge
	state := g.GetMergeState(repoPath)
	if state.InMerge {
		// Already in merge state - this is fine, just return success
		conflicted, _ := g.GetConflictedFiles(repoPath)
		if len(conflicted) > 0 {
			return OperationResult{
				Success: true,
				Message: fmt.Sprintf("Merge already in progress with %d conflict(s) to resolve", len(conflicted)),
			}
		}
		return successOp("Merge already in progress - ready to commit")
	}
	if state.InRebase {
		return failedOp("Cannot start merge: rebase in progress. Abort the rebase first.")
	}

	// Check for uncommitted changes - merge requires a clean working tree
	status := g.Status(repoPath)
	if status.HasChanges {
		return failedOp("Cannot start merge: you have uncommitted changes. Please commit or stash your changes first.")
	}

	// Step 1: Run canonical target preflight to guarantee local target baseline.
	originalBranch, err := g.prepareMergeTargetBaseline(repoPath, targetBranch)
	if err != nil {
		if originalBranch != "" {
			g.runner.RunGit(repoPath, "checkout", originalBranch)
		}
		return failedOp(err.Error())
	}

	// Step 2: Determine the source ref to merge
	sourceRef, err := g.resolveBranchRef(repoPath, source, false)
	if err != nil {
		g.runner.RunGit(repoPath, "checkout", originalBranch)
		return failedOp(err.Error())
	}

	// Step 3: Start the merge with --no-commit so user can resolve conflicts
	result := g.runner.RunGit(repoPath, "merge", "--no-commit", "--no-ff", sourceRef)

	// Exit code 1 with conflicts is expected - that's what we want
	if !result.Success {
		// Check if it's a conflict situation (this is expected)
		conflicted, _ := g.GetConflictedFiles(repoPath)
		if len(conflicted) > 0 {
			return OperationResult{
				Success: true,
				Message: fmt.Sprintf("Merge started with %d conflict(s) to resolve", len(conflicted)),
			}
		}

		// Check if merge was started but no conflicts
		mergeState := g.GetMergeState(repoPath)
		if mergeState.InMerge {
			return successOp("Merge started - no conflicts detected")
		}

		// Actual error - provide detailed message
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "not something we can merge") {
			return failedOp(fmt.Sprintf("Cannot merge '%s': branch not found or invalid", source))
		}
		if strings.Contains(errMsg, "uncommitted changes") {
			return failedOp("Cannot merge: you have uncommitted changes. Commit or stash them first.")
		}
		// Checkout back to original branch on failure
		g.runner.RunGit(repoPath, "checkout", originalBranch)
		return failedOp("Failed to start merge: " + errMsg)
	}

	// Merge command succeeded (exit code 0)
	// Check if we're actually in merge state - if not, it means "Already up to date"
	mergeState := g.GetMergeState(repoPath)
	if !mergeState.InMerge {
		// Check if the output indicates "already up to date"
		outputLower := strings.ToLower(result.Stdout)
		if strings.Contains(outputLower, "already up to date") || strings.Contains(outputLower, "already up-to-date") {
			return OperationResult{
				Success: true,
				Message: "Already up to date - nothing to merge",
				Error:   "already_up_to_date", // Use error field as a status indicator
			}
		}
		// No merge state and not "already up to date" - something unexpected
		return OperationResult{
			Success: true,
			Message: "Merge completed automatically - no commit needed",
			Error:   "auto_completed",
		}
	}

	// Clean merge with changes staged, waiting for commit
	return successOp("Merge started - no conflicts detected")
}

// MergeOptions contains options for StartMergeWithOptions
type MergeOptions struct {
	Squash        bool     `json:"squash"`
	Selective     bool     `json:"selective"`
	SelectedFiles []string `json:"selectedFiles"`
}

// StartMergeWithOptions begins a merge with configurable options.
// Supports squash merge mode which combines all commits into a single commit.
//
// Parameters:
//   - repoPath: Path to the git repository
//   - targetBranch: The branch to merge INTO (e.g., "main") - required
//   - sourceBranch: The branch to merge FROM - required
//   - options: MergeOptions with squash flag
//
// When squash is true:
// - Uses `git merge --squash` instead of regular merge
// - Does NOT create a merge commit with two parents
// - All changes appear as a single commit authored by the user
// - Results in cleaner, linear history
func (g *GitService) StartMergeWithOptions(repoPath string, targetBranch string, sourceBranch string, options MergeOptions) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationMerge)
	if targetBranch == "" {
		return failedOp("Target branch is required")
	}
	if sourceBranch == "" {
		return failedOp("Source branch is required")
	}
	if options.Selective && len(options.SelectedFiles) == 0 {
		return failedOp("At least one selected file is required when selective merge is enabled")
	}

	// Verify repo exists
	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return failedOp("Not a valid git repository")
	}

	// Don't allow merging a branch into itself
	if sourceBranch == targetBranch {
		return failedOp("Cannot merge a branch into itself")
	}

	// Check if already in a merge state
	state := g.GetMergeState(repoPath)
	if state.InMerge {
		conflicted, _ := g.GetConflictedFiles(repoPath)
		if len(conflicted) > 0 {
			return OperationResult{
				Success: true,
				Message: fmt.Sprintf("Merge already in progress with %d conflict(s) to resolve", len(conflicted)),
			}
		}
		return successOp("Merge already in progress - ready to commit")
	}
	if state.InRebase {
		return failedOp("Cannot start merge: rebase in progress. Abort the rebase first.")
	}

	// Check for uncommitted changes
	status := g.Status(repoPath)
	if status.HasChanges {
		return failedOp("Cannot start merge: you have uncommitted changes. Please commit or stash your changes first.")
	}

	// Step 1: Run canonical target preflight to guarantee local target baseline.
	originalBranch, err := g.prepareMergeTargetBaseline(repoPath, targetBranch)
	if err != nil {
		if originalBranch != "" {
			g.runner.RunGit(repoPath, "checkout", originalBranch)
		}
		return failedOp(err.Error())
	}

	// Step 2: Determine the source ref
	sourceRef, err := g.resolveBranchRef(repoPath, sourceBranch, false)
	if err != nil {
		g.runner.RunGit(repoPath, "checkout", originalBranch)
		return failedOp(err.Error())
	}

	selectedSet := make(map[string]struct{})
	if options.Selective {
		for _, selected := range options.SelectedFiles {
			normalized := normalizeMergePath(selected)
			if normalized == "" {
				continue
			}
			selectedSet[normalized] = struct{}{}
		}
		if len(selectedSet) == 0 {
			g.runner.RunGit(repoPath, "checkout", originalBranch)
			return failedOp("At least one selected file is required when selective merge is enabled")
		}
	}

	unselectedPaths := []string{}
	if options.Selective {
		allChangedPaths, err := g.listChangedPathsForMerge(repoPath, targetBranch, sourceRef)
		if err != nil {
			g.runner.RunGit(repoPath, "checkout", originalBranch)
			return failedOp(err.Error())
		}

		for _, changedPath := range allChangedPaths {
			normalized := normalizeMergePath(changedPath)
			if normalized == "" {
				continue
			}
			if _, selected := selectedSet[normalized]; !selected {
				unselectedPaths = append(unselectedPaths, normalized)
			}
		}
	}

	// Step 3: Build merge command based on options
	var mergeArgs []string
	if options.Squash {
		mergeArgs = []string{"merge", "--squash", sourceRef}
	} else {
		mergeArgs = []string{"merge", "--no-commit", "--no-ff", sourceRef}
	}

	result := g.runner.RunGit(repoPath, mergeArgs...)

	postMergeState := g.GetMergeState(repoPath)
	mergeStarted := postMergeState.InMerge || postMergeState.InSquashMerge || options.Squash
	if options.Selective && mergeStarted {
		if err := g.neutralizeUnselectedPaths(repoPath, unselectedPaths); err != nil {
			return failedOp("Selective merge failed: " + err.Error())
		}

		conflictedAfterNeutralize, _ := g.GetConflictedFiles(repoPath)
		remainingUnselectedConflicts := []string{}
		for _, conflictedFile := range conflictedAfterNeutralize {
			normalized := normalizeMergePath(conflictedFile.Path)
			if _, selected := selectedSet[normalized]; !selected {
				remainingUnselectedConflicts = append(remainingUnselectedConflicts, conflictedFile.Path)
			}
		}

		if len(remainingUnselectedConflicts) > 0 {
			return failedOp("Selective merge failed: unselected conflicts remain: " + strings.Join(remainingUnselectedConflicts, ", "))
		}
	}

	// Handle merge result
	if !result.Success {
		conflicted, _ := g.GetConflictedFiles(repoPath)
		if options.Selective {
			filtered := make([]ConflictedFile, 0, len(conflicted))
			for _, conflictedFile := range conflicted {
				normalized := normalizeMergePath(conflictedFile.Path)
				if _, selected := selectedSet[normalized]; selected {
					filtered = append(filtered, conflictedFile)
				}
			}
			conflicted = filtered
		}

		if len(conflicted) > 0 {
			mergeType := "Merge"
			if options.Squash {
				mergeType = "Squash merge"
			}
			return OperationResult{
				Success: true,
				Message: fmt.Sprintf("%s started with %d conflict(s) to resolve", mergeType, len(conflicted)),
			}
		}

		// Check merge state
		mergeState := g.GetMergeState(repoPath)
		if mergeState.InMerge || options.Squash {
			// For squash, we won't be "in merge" state, but we have staged changes
			return successOp("Merge started - no conflicts detected")
		}

		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "not something we can merge") {
			return failedOp(fmt.Sprintf("Cannot merge '%s': branch not found or invalid", sourceBranch))
		}
		if strings.Contains(errMsg, "uncommitted changes") {
			return failedOp("Cannot merge: you have uncommitted changes. Commit or stash them first.")
		}
		g.runner.RunGit(repoPath, "checkout", originalBranch)
		return failedOp("Failed to start merge: " + errMsg)
	}

	// Success - check final state
	outputLower := strings.ToLower(result.Stdout)
	if strings.Contains(outputLower, "already up to date") || strings.Contains(outputLower, "already up-to-date") {
		return OperationResult{
			Success: true,
			Message: "Already up to date - nothing to merge",
			Error:   "already_up_to_date",
		}
	}

	// For squash merge, we're not in "merge" state but have staged changes
	if options.Squash {
		statusAfter := g.Status(repoPath)
		if statusAfter.HasChanges {
			return OperationResult{
				Success: true,
				Message: "Squash merge staged - ready to commit",
			}
		}
		// No changes means already up to date
		return OperationResult{
			Success: true,
			Message: "Already up to date - nothing to merge",
			Error:   "already_up_to_date",
		}
	}

	// Regular merge - check merge state
	mergeState := g.GetMergeState(repoPath)
	if !mergeState.InMerge {
		return OperationResult{
			Success: true,
			Message: "Merge completed automatically - no commit needed",
			Error:   "auto_completed",
		}
	}

	return successOp("Merge started - no conflicts detected")
}

func (g *GitService) resolveBranchRef(repoPath string, branch string, preferRemote bool) (string, error) {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return "", fmt.Errorf("branch name is required")
	}

	// A fully-qualified ref is already unambiguous. Change Request snapshots pass
	// refs/iofabrik/... names here, and prefixing them with a remote would
	// only work by accident through the fallback below.
	if strings.HasPrefix(branch, "refs/") {
		if g.runner.RunGit(repoPath, "rev-parse", "--verify", branch).Success {
			return branch, nil
		}
		return "", fmt.Errorf("ref '%s' not found", branch)
	}

	preferredRemote, hasRemote := g.getPreferredRemote(repoPath)

	if preferRemote {
		if hasRemote {
			remoteRef := preferredRemote + "/" + branch
			if g.runner.RunGit(repoPath, "rev-parse", "--verify", remoteRef).Success {
				return remoteRef, nil
			}
		}
		if g.runner.RunGit(repoPath, "rev-parse", "--verify", branch).Success {
			return branch, nil
		}
		return "", fmt.Errorf("branch '%s' not found locally or on remote", branch)
	}

	if g.runner.RunGit(repoPath, "rev-parse", "--verify", branch).Success {
		return branch, nil
	}
	if hasRemote {
		remoteRef := preferredRemote + "/" + branch
		if g.runner.RunGit(repoPath, "rev-parse", "--verify", remoteRef).Success {
			return remoteRef, nil
		}
	}

	return "", fmt.Errorf("branch '%s' not found locally or on remote", branch)
}

func (g *GitService) listChangedPathsForMerge(repoPath string, targetRef string, sourceRef string) ([]string, error) {
	result := g.runner.RunGit(repoPath, "diff", "--name-only", targetRef+".."+sourceRef)
	if !result.Success {
		return nil, fmt.Errorf("failed to list changed files for selective merge: %s", getErrorMessage(result))
	}

	paths := []string{}
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		normalized := normalizeMergePath(line)
		if normalized == "" {
			continue
		}
		paths = append(paths, normalized)
	}

	return paths, nil
}

func (g *GitService) neutralizeUnselectedPaths(repoPath string, paths []string) error {
	g = g.forGitOperation()
	for _, path := range paths {
		normalizedPath := normalizeMergePath(path)
		if normalizedPath == "" {
			continue
		}

		if g.isPathUnmerged(repoPath, normalizedPath) {
			checkoutOurs := g.runner.RunGit(repoPath, "checkout", "--ours", "--", normalizedPath)
			if !checkoutOurs.Success {
				return fmt.Errorf("failed to keep target version for '%s': %s", normalizedPath, getErrorMessage(checkoutOurs))
			}

			stageResult := g.runner.RunGit(repoPath, "add", "-A", "--", normalizedPath)
			if !stageResult.Success {
				return fmt.Errorf("failed to stage neutralized file '%s': %s", normalizedPath, getErrorMessage(stageResult))
			}
			continue
		}

		if g.isPathTracked(repoPath, normalizedPath) {
			restoreResult := g.runner.RunGit(repoPath, "restore", "--source=HEAD", "--staged", "--worktree", "--", normalizedPath)
			if !restoreResult.Success {
				return fmt.Errorf("failed to reset unselected file '%s': %s", normalizedPath, getErrorMessage(restoreResult))
			}
			continue
		}

		rmResult := g.runner.RunGit(repoPath, "rm", "--cached", "--ignore-unmatch", "--", normalizedPath)
		if !rmResult.Success {
			return fmt.Errorf("failed to unstage merge-introduced file '%s': %s", normalizedPath, getErrorMessage(rmResult))
		}

		worktreePath, err := safeRepoRelativePath(repoPath, normalizedPath)
		if err != nil {
			return fmt.Errorf("failed to normalize path '%s': %w", normalizedPath, err)
		}
		_ = os.RemoveAll(worktreePath)
	}

	return nil
}

func (g *GitService) isPathUnmerged(repoPath string, filePath string) bool {
	result := g.runner.RunGit(repoPath, "ls-files", "-u", "--", filePath)
	if !result.Success {
		return false
	}
	return strings.TrimSpace(result.Stdout) != ""
}

func (g *GitService) isPathTracked(repoPath string, filePath string) bool {
	result := g.runner.RunGit(repoPath, "ls-files", "--error-unmatch", "--", filePath)
	return result.Success
}

func normalizeMergePath(path string) string {
	normalized := filepath.ToSlash(filepath.Clean(strings.TrimSpace(path)))
	if normalized == "." {
		return ""
	}
	normalized = strings.TrimPrefix(normalized, "./")
	return normalized
}

func safeRepoRelativePath(repoPath string, relativePath string) (string, error) {
	cleanRelative := filepath.Clean(filepath.FromSlash(relativePath))
	if cleanRelative == "." || cleanRelative == "" || filepath.IsAbs(cleanRelative) {
		return "", fmt.Errorf("invalid relative path")
	}

	fullPath := filepath.Join(repoPath, cleanRelative)
	rel, err := filepath.Rel(repoPath, fullPath)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes repository")
	}

	return fullPath, nil
}

// CompleteSquashMerge commits a squash merge.
// Unlike CompleteMerge, this doesn't require being in a merge state (no MERGE_HEAD).
// It simply commits the staged changes from the squash merge.
//
// Prefer using CompleteMerge which auto-detects the merge type and delegates here
// for squash merges. This method is kept public for backward compatibility.
func (g *GitService) CompleteSquashMerge(repoPath string, message string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationMerge)
	if message == "" {
		return failedOp("Commit message is required for squash merge")
	}

	// Check for staged changes
	status := g.Status(repoPath)
	if !status.HasChanges {
		return failedOp("No changes to commit")
	}

	// Commit the squash merge
	result := g.runner.RunGit(repoPath, "commit", "-m", message)
	if !result.Success {
		return failedOp("Failed to complete squash merge: " + getErrorMessage(result))
	}

	return successOp("Squash merge completed successfully")
}

// AbortMerge aborts the current merge operation.
// Returns the repository to the state before the merge started.
// Handles both regular merges (MERGE_HEAD) and squash merges (SQUASH_MSG).
func (g *GitService) AbortMerge(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationAbort)
	done := LogMethod("GitService.AbortMerge", map[string]interface{}{"repoPath": repoPath})
	defer func() { done(nil, nil) }()
	state := g.GetMergeState(repoPath)
	if !state.InMerge && !state.InSquashMerge {
		return failedOp("No merge in progress")
	}

	// Squash merge: git merge --abort won't work because there's no MERGE_HEAD.
	// Use git reset --merge to undo the squash merge and restore the working tree.
	if state.InSquashMerge && !state.InMerge {
		result := g.runner.RunGit(repoPath, "reset", "--merge")
		if !result.Success {
			return failedOp("Failed to abort squash merge: " + getErrorMessage(result))
		}
		// Clean up the SQUASH_MSG file that git reset --merge doesn't remove
		if squashMsgPath, err := gitAdminPath(g.runner, repoPath, "SQUASH_MSG"); err == nil {
			os.Remove(squashMsgPath)
		}
		return successOp("Squash merge aborted")
	}

	// Regular merge: use git merge --abort
	result := g.runner.RunGit(repoPath, "merge", "--abort")
	if !result.Success {
		return failedOp("Failed to abort: " + getErrorMessage(result))
	}

	return successOp("Merge aborted")
}

// ============================================================================
// Cherry-Pick Operations
// ============================================================================

// AbortCherryPick aborts the current cherry-pick operation.
// Runs: git cherry-pick --abort
func (g *GitService) AbortCherryPick(repoPath string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationAbort)
	state := g.GetMergeState(repoPath)
	if !state.InCherryPick {
		return failedOp("No cherry-pick in progress")
	}

	result := g.runner.RunGit(repoPath, "cherry-pick", "--abort")
	if !result.Success {
		return failedOp("Failed to abort cherry-pick: " + getErrorMessage(result))
	}

	return successOp("Cherry-pick aborted")
}

// ContinueCherryPick continues the cherry-pick after conflicts are resolved.
// Runs: git cherry-pick --continue
func (g *GitService) ContinueCherryPick(repoPath string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationContinue)
	state := g.GetMergeState(repoPath)
	if !state.InCherryPick {
		return failedOp("No cherry-pick in progress")
	}

	// Check if there are still conflicts
	conflicted, err := g.GetConflictedFiles(repoPath)
	if err != nil {
		return failedOp("Failed to check conflicts: " + err.Error())
	}
	if len(conflicted) > 0 {
		return failedOp(fmt.Sprintf("Cannot continue cherry-pick: %d file(s) still have conflicts", len(conflicted)))
	}

	result := g.runner.RunGit(repoPath, "cherry-pick", "--continue")
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "No changes") {
			// Skip this commit
			skipResult := g.runner.RunGit(repoPath, "cherry-pick", "--skip")
			if skipResult.Success {
				return successOp("Commit skipped (no changes)")
			}
			return failedOp("Failed to skip commit: " + getErrorMessage(skipResult))
		}
		return failedOp("Failed to continue cherry-pick: " + errMsg)
	}

	// Check if cherry-pick completed
	newState := g.GetMergeState(repoPath)
	if !newState.InCherryPick {
		return successOp("Cherry-pick completed successfully")
	}
	return successOp("Cherry-pick continuing")
}

// SkipCherryPickCommit skips the current commit in a cherry-pick sequence.
// Runs: git cherry-pick --skip
func (g *GitService) SkipCherryPickCommit(repoPath string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationContinue)
	state := g.GetMergeState(repoPath)
	if !state.InCherryPick {
		return failedOp("No cherry-pick in progress")
	}

	result := g.runner.RunGit(repoPath, "cherry-pick", "--skip")
	if !result.Success {
		return failedOp("Failed to skip commit: " + getErrorMessage(result))
	}

	// Check if cherry-pick completed
	newState := g.GetMergeState(repoPath)
	if !newState.InCherryPick {
		return successOp("Cherry-pick completed successfully")
	}
	return successOp("Commit skipped, cherry-pick continuing")
}

// ============================================================================
// Revert Operations
// ============================================================================

// RevertCommit creates a new commit that undoes the changes from a specified commit.
// Unlike reset, this preserves history by creating a new "anti-commit".
// Requires a clean working tree (no uncommitted changes).
// If the revert causes conflicts, the repo will be in a revert state.
// Use AbortRevert() to cancel or ContinueRevert() after resolving conflicts.
// Runs: git revert --no-edit <commitHash>
func (g *GitService) RevertCommit(repoPath string, commitHash string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationRevert)
	done := LogMethod("GitService.RevertCommit", map[string]interface{}{"repoPath": repoPath, "commitHash": commitHash})
	defer func() { done(nil, nil) }()
	if commitHash == "" {
		return failedOp("Commit hash is required")
	}

	// Validate the commit hash exists
	result := g.runner.RunGit(repoPath, "cat-file", "-t", commitHash)
	if !result.Success {
		return failedOp("Invalid commit hash: " + commitHash)
	}
	if trimOutput(result.Stdout) != "commit" {
		return failedOp("The provided hash is not a commit")
	}

	// Check for clean working tree
	if err := g.requireCleanWorkingTree(repoPath); err != nil {
		return failedOp(err.Error())
	}

	// Check if already in a stuck state (merge, rebase, cherry-pick, revert, etc.)
	state := g.GetMergeState(repoPath)
	if state.InMerge || state.InRebase || state.InCherryPick || state.InRevert {
		return failedOp("Cannot revert: repository is in the middle of another operation. Resolve or abort it first.")
	}

	// Get short hash for user-friendly messages
	shortHashResult := g.runner.RunGit(repoPath, "rev-parse", "--short", commitHash)
	shortHash := commitHash[:7]
	if shortHashResult.Success {
		shortHash = trimOutput(shortHashResult.Stdout)
	}

	// Get the commit subject for the message
	subjectResult := g.runner.RunGit(repoPath, "log", "-1", "--format=%s", commitHash)
	subject := ""
	if subjectResult.Success {
		subject = trimOutput(subjectResult.Stdout)
		if len(subject) > 50 {
			subject = subject[:47] + "..."
		}
	}

	// Run the revert with --no-edit to use the default commit message
	revertResult := g.runner.RunGit(repoPath, "revert", "--no-edit", commitHash)
	if !revertResult.Success {
		errMsg := getErrorMessage(revertResult)

		// Check if it's a conflict
		if strings.Contains(errMsg, "conflict") || strings.Contains(errMsg, "CONFLICT") {
			// Get conflicted files for a better message
			conflicted, _ := g.GetConflictedFiles(repoPath)
			conflictCount := len(conflicted)
			if conflictCount > 0 {
				return OperationResult{
					Success: false,
					Message: fmt.Sprintf("Revert of %s caused conflicts in %d file(s). Resolve conflicts and use 'Continue Revert' or 'Abort Revert'.", shortHash, conflictCount),
					Error:   "conflicts",
				}
			}
			return failedOp(fmt.Sprintf("Revert of %s caused conflicts. Resolve them and continue or abort the revert.", shortHash))
		}

		// Check if it's an empty commit (no changes to revert)
		if strings.Contains(errMsg, "nothing to commit") || strings.Contains(errMsg, "empty") {
			return failedOp(fmt.Sprintf("Revert of %s would result in an empty commit (changes may already be undone)", shortHash))
		}

		return failedOp("Failed to revert commit: " + errMsg)
	}

	// Build success message
	if subject != "" {
		return successOp(fmt.Sprintf("Successfully reverted commit %s: \"%s\"", shortHash, subject))
	}
	return successOp(fmt.Sprintf("Successfully reverted commit %s", shortHash))
}

// RevertCommitWithMessage creates a new commit that undoes the changes from a specified commit
// with a custom commit message.
// Requires a clean working tree (no uncommitted changes).
// Runs: git revert -m <message> <commitHash> (via stdin for message)
func (g *GitService) RevertCommitWithMessage(repoPath string, commitHash string, message string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationRevert)
	if commitHash == "" {
		return failedOp("Commit hash is required")
	}
	if message == "" {
		return failedOp("Commit message is required")
	}

	// Validate the commit hash exists
	result := g.runner.RunGit(repoPath, "cat-file", "-t", commitHash)
	if !result.Success {
		return failedOp("Invalid commit hash: " + commitHash)
	}
	if trimOutput(result.Stdout) != "commit" {
		return failedOp("The provided hash is not a commit")
	}

	// Check for clean working tree
	if err := g.requireCleanWorkingTree(repoPath); err != nil {
		return failedOp(err.Error())
	}

	// Check if already in a stuck state
	state := g.GetMergeState(repoPath)
	if state.InMerge || state.InRebase || state.InCherryPick || state.InRevert {
		return failedOp("Cannot revert: repository is in the middle of another operation. Resolve or abort it first.")
	}

	// Get short hash for user-friendly messages
	shortHashResult := g.runner.RunGit(repoPath, "rev-parse", "--short", commitHash)
	shortHash := commitHash[:7]
	if shortHashResult.Success {
		shortHash = trimOutput(shortHashResult.Stdout)
	}

	// Run the revert with --no-commit first, then commit with custom message
	revertResult := g.runner.RunGit(repoPath, "revert", "--no-commit", commitHash)
	if !revertResult.Success {
		errMsg := getErrorMessage(revertResult)

		// Check if it's a conflict
		if strings.Contains(errMsg, "conflict") || strings.Contains(errMsg, "CONFLICT") {
			conflicted, _ := g.GetConflictedFiles(repoPath)
			conflictCount := len(conflicted)
			if conflictCount > 0 {
				return OperationResult{
					Success: false,
					Message: fmt.Sprintf("Revert of %s caused conflicts in %d file(s). Resolve conflicts and use 'Continue Revert' or 'Abort Revert'.", shortHash, conflictCount),
					Error:   "conflicts",
				}
			}
			return failedOp(fmt.Sprintf("Revert of %s caused conflicts. Resolve them and continue or abort the revert.", shortHash))
		}

		return failedOp("Failed to revert commit: " + errMsg)
	}

	// Commit with the custom message
	commitResult := g.runner.RunGit(repoPath, "commit", "-m", message)
	if !commitResult.Success {
		// If commit fails, try to clean up
		g.runner.RunGit(repoPath, "reset", "--hard", "HEAD")
		return failedOp("Revert staged but commit failed: " + getErrorMessage(commitResult))
	}

	return successOp(fmt.Sprintf("Successfully reverted commit %s with custom message", shortHash))
}

// AbortRevert aborts the current revert operation.
// Runs: git revert --abort
func (g *GitService) AbortRevert(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationAbort)
	state := g.GetMergeState(repoPath)
	if !state.InRevert {
		return failedOp("No revert in progress")
	}

	result := g.runner.RunGit(repoPath, "revert", "--abort")
	if !result.Success {
		return failedOp("Failed to abort revert: " + getErrorMessage(result))
	}

	return successOp("Revert aborted")
}

// ContinueRevert continues the revert after conflicts are resolved.
// Runs: git revert --continue
func (g *GitService) ContinueRevert(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationContinue)
	state := g.GetMergeState(repoPath)
	if !state.InRevert {
		return failedOp("No revert in progress")
	}

	// Check if there are still conflicts
	conflicted, err := g.GetConflictedFiles(repoPath)
	if err != nil {
		return failedOp("Failed to check conflicts: " + err.Error())
	}
	if len(conflicted) > 0 {
		return failedOp(fmt.Sprintf("Cannot continue revert: %d file(s) still have conflicts", len(conflicted)))
	}

	result := g.runner.RunGit(repoPath, "revert", "--continue")
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "No changes") {
			// Skip this commit
			skipResult := g.runner.RunGit(repoPath, "revert", "--skip")
			if skipResult.Success {
				return successOp("Commit skipped (no changes)")
			}
			return failedOp("Failed to skip commit: " + getErrorMessage(skipResult))
		}
		return failedOp("Failed to continue revert: " + errMsg)
	}

	// Check if revert completed
	newState := g.GetMergeState(repoPath)
	if !newState.InRevert {
		return successOp("Revert completed successfully")
	}
	return successOp("Revert continuing")
}

// SkipRevertCommit skips the current commit in a revert sequence.
// Runs: git revert --skip
func (g *GitService) SkipRevertCommit(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationContinue)
	state := g.GetMergeState(repoPath)
	if !state.InRevert {
		return failedOp("No revert in progress")
	}

	result := g.runner.RunGit(repoPath, "revert", "--skip")
	if !result.Success {
		return failedOp("Failed to skip commit: " + getErrorMessage(result))
	}

	// Check if revert completed
	newState := g.GetMergeState(repoPath)
	if !newState.InRevert {
		return successOp("Revert completed successfully")
	}
	return successOp("Commit skipped, revert continuing")
}

// ============================================================================
// Bisect Operations
// ============================================================================

// AbortBisect aborts the current bisect session.
// Runs: git bisect reset
func (g *GitService) AbortBisect(repoPath string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationAbort)
	state := g.GetMergeState(repoPath)
	if !state.InBisect {
		return failedOp("No bisect in progress")
	}

	result := g.runner.RunGit(repoPath, "bisect", "reset")
	if !result.Success {
		return failedOp("Failed to abort bisect: " + getErrorMessage(result))
	}

	return successOp("Bug search aborted, returned to normal state")
}

// GetBisectState returns information about the current bisect session.
func (g *GitService) GetBisectState(repoPath string) map[string]interface{} {
	info := map[string]interface{}{
		"inBisect":    false,
		"stepsLeft":   0,
		"good":        "",
		"bad":         "",
		"currentHash": "",
	}

	state := g.GetMergeState(repoPath)
	if !state.InBisect {
		return info
	}

	info["inBisect"] = true

	// Read bisect log
	bisectLogPath, err := gitAdminPath(g.runner, repoPath, "BISECT_LOG")
	if err != nil {
		return info
	}
	if data, err := os.ReadFile(bisectLogPath); err == nil {
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			if strings.HasPrefix(line, "# good:") {
				parts := strings.Fields(line)
				if len(parts) >= 3 {
					info["good"] = parts[2]
				}
			} else if strings.HasPrefix(line, "# bad:") {
				parts := strings.Fields(line)
				if len(parts) >= 3 {
					info["bad"] = parts[2]
				}
			}
		}
	}

	// Get current HEAD
	headResult := g.runner.RunGit(repoPath, "rev-parse", "--short", "HEAD")
	if headResult.Success {
		info["currentHash"] = strings.TrimSpace(headResult.Stdout)
	}

	return info
}

// ============================================================================
// AM (Apply Mailbox) Operations
// ============================================================================

// AbortAM aborts the current AM (patch application) operation.
// Runs: git am --abort
func (g *GitService) AbortAM(repoPath string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationAbort)
	state := g.GetMergeState(repoPath)
	if !state.InAM {
		return failedOp("No patch application in progress")
	}

	result := g.runner.RunGit(repoPath, "am", "--abort")
	if !result.Success {
		return failedOp("Failed to abort patch application: " + getErrorMessage(result))
	}

	return successOp("Patch application aborted")
}

// SkipAMPatch skips the current patch in an AM sequence.
// Runs: git am --skip
func (g *GitService) SkipAMPatch(repoPath string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationContinue)
	state := g.GetMergeState(repoPath)
	if !state.InAM {
		return failedOp("No patch application in progress")
	}

	result := g.runner.RunGit(repoPath, "am", "--skip")
	if !result.Success {
		return failedOp("Failed to skip patch: " + getErrorMessage(result))
	}

	// Check if AM completed
	newState := g.GetMergeState(repoPath)
	if !newState.InAM {
		return successOp("Patch application completed")
	}
	return successOp("Patch skipped, continuing")
}

// ============================================================================
// Detached HEAD Operations
// ============================================================================

// IsDetachedHead checks if the repository is in a detached HEAD state.
func (g *GitService) IsDetachedHead(repoPath string) bool {
	state := g.GetMergeState(repoPath)
	return state.IsDetached
}

// CreateBranchFromDetached creates a new branch from the current detached HEAD position.
// This saves the user's work by attaching it to a named branch.
func (g *GitService) CreateBranchFromDetached(repoPath string, branchName string) OperationResult {
	g = g.forGitOperation()
	if branchName == "" {
		return failedOp("Branch name is required")
	}

	state := g.GetMergeState(repoPath)
	if !state.IsDetached {
		return failedOp("Not in detached HEAD state")
	}

	// Create and checkout the new branch
	result := g.runner.RunGit(repoPath, "checkout", "-b", branchName)
	if !result.Success {
		errMsg := getErrorMessage(result)
		if strings.Contains(errMsg, "already exists") {
			return failedOp(fmt.Sprintf("Branch '%s' already exists. Choose a different name.", branchName))
		}
		return failedOp("Failed to create branch: " + errMsg)
	}

	return successOp(fmt.Sprintf("Created branch '%s' and switched to it. Your work is now saved.", branchName))
}

// ============================================================================
// Lock File Operations
// ============================================================================

// CheckForStaleLocks returns a list of any lock files found in .git directory.
func (g *GitService) CheckForStaleLocks(repoPath string) []string {
	state := g.GetMergeState(repoPath)
	return state.LockFiles
}

// RemoveStaleLock removes a specific lock file from the .git directory.
// This is a potentially dangerous operation - requires confirmation.
func (g *GitService) RemoveStaleLock(repoPath string, lockFile string, confirm bool) OperationResult {
	if !confirm {
		return failedOp("Confirmation required to remove lock file")
	}

	// Only allow removing known lock files (security)
	allowedLocks := map[string]bool{
		"index.lock":  true,
		"HEAD.lock":   true,
		"config.lock": true,
	}

	if !allowedLocks[lockFile] {
		return failedOp(fmt.Sprintf("Unknown lock file: %s", lockFile))
	}

	lockPath, err := gitAdminPath(g.runner, repoPath, lockFile)
	if err != nil {
		return failedOp("Could not locate this project's internal files. Reopen the project and try again.")
	}

	// Check if lock file exists
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		return failedOp("Lock file not found")
	}

	// Remove the lock file
	if err := os.Remove(lockPath); err != nil {
		return failedOp("Failed to remove lock file: " + err.Error())
	}

	return successOp(fmt.Sprintf("Removed %s - you can now continue working", lockFile))
}

// RemoveAllStaleLocks removes all stale lock files from the .git directory.
// This is a convenience method that removes all known lock files at once.
func (g *GitService) RemoveAllStaleLocks(repoPath string, confirm bool) OperationResult {
	if !confirm {
		return failedOp("Confirmation required to remove lock files")
	}

	state := g.GetMergeState(repoPath)
	if !state.HasLockFile || len(state.LockFiles) == 0 {
		return failedOp("No lock files found")
	}

	removed := []string{}
	failed := []string{}

	lockPaths, err := gitAdminPaths(g.runner, repoPath, state.LockFiles...)
	if err != nil {
		return failedOp("Could not locate this project's internal files. Reopen the project and try again.")
	}

	for i, lockFile := range state.LockFiles {
		if err := os.Remove(lockPaths[i]); err != nil {
			failed = append(failed, lockFile)
		} else {
			removed = append(removed, lockFile)
		}
	}

	if len(failed) > 0 {
		return failedOp(fmt.Sprintf("Removed %d lock(s), failed to remove: %s", len(removed), strings.Join(failed, ", ")))
	}

	return successOp(fmt.Sprintf("Removed %d lock file(s) - you can now continue working", len(removed)))
}

// ============================================================================
// Unified Abort Operation
// ============================================================================

// AbortCurrentOperation aborts whatever stuck operation is currently in progress.
// This is a convenience method that detects the state and calls the appropriate abort.
func (g *GitService) AbortCurrentOperation(repoPath string) OperationResult {
	defer g.publishRepoMutation(repoPath, RepoMutationAbort)
	state := g.GetMergeState(repoPath)

	// Priority order for abort (most critical first)
	if state.HasLockFile {
		return g.RemoveAllStaleLocks(repoPath, true)
	}
	if state.InMerge || state.InSquashMerge {
		return g.AbortMerge(repoPath)
	}
	if state.InRebase {
		result := g.runner.RunGit(repoPath, "rebase", "--abort")
		if result.Success {
			return successOp("Rebase aborted")
		}
		return failedOp("Failed to abort rebase: " + getErrorMessage(result))
	}
	if state.InCherryPick {
		return g.AbortCherryPick(repoPath)
	}
	if state.InRevert {
		return g.AbortRevert(repoPath)
	}
	if state.InBisect {
		return g.AbortBisect(repoPath)
	}
	if state.InAM {
		return g.AbortAM(repoPath)
	}
	if state.IsDetached {
		return failedOp("Cannot abort detached HEAD - create a branch to save your work instead")
	}

	return failedOp("No operation in progress to abort")
}

// CompleteMerge completes the merge by committing after all conflicts are resolved.
// Supports both regular merges (MERGE_HEAD) and squash merges (SQUASH_MSG).
func (g *GitService) CompleteMerge(repoPath string, message string) OperationResult {
	g = g.forGitOperation()
	defer g.publishRepoMutation(repoPath, RepoMutationMerge)
	state := g.GetMergeState(repoPath)
	if !state.InMerge && !state.InSquashMerge {
		return failedOp("No merge in progress")
	}

	// Capture current HEAD so we can rollback local history if push fails.
	headBeforeResult := g.runner.RunGit(repoPath, "rev-parse", "HEAD")
	if !headBeforeResult.Success {
		return failedOp("Failed to determine current HEAD before completing merge: " + getErrorMessage(headBeforeResult))
	}
	headBefore := trimOutput(headBeforeResult.Stdout)
	if headBefore == "" {
		return failedOp("Failed to determine current HEAD before completing merge")
	}

	// If this is a squash merge (no MERGE_HEAD), delegate to CompleteSquashMerge
	if state.InSquashMerge && !state.InMerge {
		squashResult := g.CompleteSquashMerge(repoPath, message)
		if !squashResult.Success {
			return squashResult
		}

		if !g.hasAnyRemote(repoPath) {
			return successOp("Merge completed successfully")
		}

		// Push the target branch after successful squash commit.
		pushResult := g.runner.RunGit(repoPath, "push")
		if !pushResult.Success {
			pushErr := getErrorMessage(pushResult)
			rollbackResult := g.runner.RunGit(repoPath, "reset", "--hard", headBefore)
			if rollbackResult.Success {
				return failedOp("Push failed after squash merge commit. Rolled back local merge commit: " + pushErr)
			}

			return failedOp("Push failed after squash merge commit and rollback also failed: " + pushErr + " | rollback error: " + getErrorMessage(rollbackResult))
		}

		return successOp("Merge completed and pushed successfully")
	}

	// Check if there are still conflicts
	conflicted, err := g.GetConflictedFiles(repoPath)
	if err != nil {
		return failedOp("Failed to check conflicts: " + err.Error())
	}
	if len(conflicted) > 0 {
		return failedOp(fmt.Sprintf("Cannot complete merge: %d file(s) still have conflicts", len(conflicted)))
	}

	// Use the provided message or the default merge message
	args := []string{"commit"}
	if message != "" {
		args = append(args, "-m", message)
	} else {
		args = append(args, "--no-edit") // Use the default merge message
	}

	result := g.runner.RunGit(repoPath, args...)
	if !result.Success {
		return failedOp("Failed to complete merge: " + getErrorMessage(result))
	}

	if !g.hasAnyRemote(repoPath) {
		return successOp("Merge completed successfully")
	}

	// Push the target branch after successful merge commit.
	pushResult := g.runner.RunGit(repoPath, "push")
	if !pushResult.Success {
		pushErr := getErrorMessage(pushResult)
		rollbackResult := g.runner.RunGit(repoPath, "reset", "--hard", headBefore)
		if rollbackResult.Success {
			return failedOp("Push failed after merge commit. Rolled back local merge commit: " + pushErr)
		}

		return failedOp("Push failed after merge commit and rollback also failed: " + pushErr + " | rollback error: " + getErrorMessage(rollbackResult))
	}

	return successOp("Merge completed and pushed successfully")
}

// ParentBranchResult contains the detected parent branch information
type ParentBranchResult struct {
	ParentBranch string `json:"parentBranch"`
	Source       string `json:"source"` // "upstream", "merge-base", "default", or "none"
	Success      bool   `json:"success"`
	Error        string `json:"error,omitempty"`
}

// defaultBranchNames are the branch names treated as integration branches:
// candidates to merge into, and never a branch we assume work is merged from.
var defaultBranchNames = []string{"main", "master", "develop", "development"}

func isDefaultBranchName(branch string) bool {
	for _, name := range defaultBranchNames {
		if branch == name {
			return true
		}
	}
	return false
}

// mergeTargetRef resolves the branch the checked-out work would merge into and
// the ref to compare against, using the same rules merge execution uses.
//
// It reports false when there is no merge worth talking about: a detached
// HEAD, no detectable parent, or an integration branch, which nobody merges
// *from*. That last case matters because GetParentBranch will happily pair a
// user sitting on main with a stale develop, and callers that run unprompted
// would then describe a merge that will never happen.
func (g *GitService) mergeTargetRef(repoPath string) (branch string, ref string, ok bool) {
	current := g.DetectRepo(repoPath).Branch
	if current == "" || isDefaultBranchName(current) {
		return "", "", false
	}

	parent := g.GetParentBranch(repoPath)
	if !parent.Success || parent.ParentBranch == "" || parent.ParentBranch == current {
		return "", "", false
	}

	targetRef, err := g.resolveBranchRef(repoPath, parent.ParentBranch, true)
	if err != nil {
		return "", "", false
	}
	return parent.ParentBranch, targetRef, true
}

// GetParentBranch attempts to detect the parent branch of the current branch.
// It uses multiple heuristics in order of reliability:
// 1. Upstream tracking branch (git config branch.<name>.merge)
// 2. Merge-base with common default branches (main, master, develop)
// 3. Falls back to "main" or "master" if they exist
//
// Returns the detected parent branch name and the source of detection.
func (g *GitService) GetParentBranch(repoPath string) ParentBranchResult {
	// Verify repo exists
	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return ParentBranchResult{
			Success: false,
			Error:   "Not a valid git repository",
		}
	}

	currentBranch := repoInfo.Branch
	if currentBranch == "" {
		return ParentBranchResult{
			Success: false,
			Error:   "Could not determine current branch (detached HEAD?)",
		}
	}

	// Strategy 1: Check upstream tracking branch
	// git config branch.<name>.merge gives us the remote ref being tracked
	upstreamResult := g.runner.RunGit(repoPath, "config", "--get", "branch."+currentBranch+".merge")
	if upstreamResult.Success {
		upstream := trimOutput(upstreamResult.Stdout)
		// upstream is like "refs/heads/main" - extract just the branch name
		if strings.HasPrefix(upstream, "refs/heads/") {
			branchName := strings.TrimPrefix(upstream, "refs/heads/")
			// Make sure it's not the same as current branch
			if branchName != currentBranch {
				return ParentBranchResult{
					ParentBranch: branchName,
					Source:       "upstream",
					Success:      true,
				}
			}
		}
	}

	// Strategy 2: Find merge-base with common default branches
	// Check which default branches exist and find the one with the most recent common ancestor
	defaultBranches := defaultBranchNames
	for _, defaultBranch := range defaultBranches {
		// Skip if current branch is the default branch
		if currentBranch == defaultBranch {
			continue
		}

		// Check if the branch exists locally or remotely
		refCheck := g.runner.RunGit(repoPath, "rev-parse", "--verify", defaultBranch)
		if !refCheck.Success {
			// Try origin/<branch>
			refCheck = g.runner.RunGit(repoPath, "rev-parse", "--verify", "origin/"+defaultBranch)
			if !refCheck.Success {
				continue
			}
		}

		// Check if current branch was created from this default branch
		// by seeing if there's a merge-base
		mergeBaseResult := g.runner.RunGit(repoPath, "merge-base", currentBranch, defaultBranch)
		if mergeBaseResult.Success {
			return ParentBranchResult{
				ParentBranch: defaultBranch,
				Source:       "merge-base",
				Success:      true,
			}
		}
	}

	// Strategy 3: Fall back to first existing default branch
	for _, defaultBranch := range defaultBranches {
		if currentBranch == defaultBranch {
			continue
		}
		refCheck := g.runner.RunGit(repoPath, "rev-parse", "--verify", defaultBranch)
		if refCheck.Success {
			return ParentBranchResult{
				ParentBranch: defaultBranch,
				Source:       "default",
				Success:      true,
			}
		}
		// Try origin/<branch>
		refCheck = g.runner.RunGit(repoPath, "rev-parse", "--verify", "origin/"+defaultBranch)
		if refCheck.Success {
			return ParentBranchResult{
				ParentBranch: defaultBranch,
				Source:       "default",
				Success:      true,
			}
		}
	}

	// No parent branch could be detected
	return ParentBranchResult{
		Success: false,
		Source:  "none",
		Error:   "Could not detect parent branch",
	}
}

// BranchConflictCheckResult contains the result of checking for conflicts between branches
type BranchConflictCheckResult struct {
	HasConflicts    bool             `json:"hasConflicts"`
	ConflictedFiles []ConflictedFile `json:"conflictedFiles"`
	ParentBranch    string           `json:"parentBranch"` // The target branch to merge INTO (kept for backward compat)
	TargetBranch    string           `json:"targetBranch"` // The target branch to merge INTO
	SourceBranch    string           `json:"sourceBranch"` // The source branch being merged
	Success         bool             `json:"success"`
	Error           string           `json:"error,omitempty"`
	Message         string           `json:"message,omitempty"`
}

// CheckBranchConflicts checks for potential merge conflicts when merging the source branch
// INTO the target branch without actually performing the merge.
// This uses `git merge-tree --write-tree` which performs a merge simulation.
//
// Default behavior (when sourceBranch is empty):
// - Checks conflicts for merging current branch INTO targetBranch
//
// Parameterized behavior (when both are provided):
// - Checks conflicts for merging sourceBranch INTO targetBranch
//
// The method:
// 1. Auto-detects target branch (parent) if not provided
// 2. Fetches the target branch from origin to ensure we have the latest
// 3. Runs git merge-tree to detect conflicts (simulating merge into target)
// 4. Returns the list of conflicted files if any
//
// Parameters:
//   - repoPath: Path to the git repository
//   - targetBranch: Name of the target branch to merge INTO (e.g., "main", "master").
//     If empty, the parent branch will be auto-detected.
//   - sourceBranch: Optional. Name of the source branch to merge FROM.
//     If empty, defaults to the current branch.
//
// Returns:
//   - BranchConflictCheckResult with conflict information
func (g *GitService) CheckBranchConflicts(repoPath string, targetBranch string, sourceBranch ...string) BranchConflictCheckResult {
	// Verify repo exists
	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return BranchConflictCheckResult{
			Success: false,
			Error:   "Not a valid git repository",
		}
	}

	// Determine source branch (default to current branch if not provided)
	source := ""
	if len(sourceBranch) > 0 && sourceBranch[0] != "" {
		source = sourceBranch[0]
	} else {
		source = repoInfo.Branch
		if source == "" {
			return BranchConflictCheckResult{
				Success: false,
				Error:   "Could not determine current branch (detached HEAD?)",
			}
		}
	}

	// Auto-detect target branch if not provided
	if targetBranch == "" {
		parentResult := g.GetParentBranch(repoPath)
		if !parentResult.Success {
			return BranchConflictCheckResult{
				Success: false,
				Error:   "Could not detect target branch: " + parentResult.Error,
			}
		}
		targetBranch = parentResult.ParentBranch
	}

	// Don't allow checking merge of a branch into itself
	if source == targetBranch {
		return BranchConflictCheckResult{
			Success: false,
			Error:   "Cannot merge a branch into itself",
		}
	}

	// Step 1: Fetch from preferred remote (if present) to refresh refs for conflict simulation.
	if preferredRemote, hasRemote := g.getPreferredRemote(repoPath); hasRemote {
		g = g.forGitOperation()
		fetchResult := g.runner.RunGit(repoPath, "fetch", preferredRemote, "--prune")
		if !fetchResult.Success {
			// Fetch might fail if branch doesn't exist on remote.
			// We can still try merge-tree with local branches.
		}
	}

	// Step 2: Resolve refs using the same canonical rules used by merge execution.
	targetRef, err := g.resolveBranchRef(repoPath, targetBranch, true)
	if err != nil {
		return BranchConflictCheckResult{
			Success: false,
			Error:   err.Error(),
		}
	}

	sourceRef, err := g.resolveBranchRef(repoPath, source, false)
	if err != nil {
		return BranchConflictCheckResult{
			Success: false,
			Error:   fmt.Sprintf("Source %s", strings.ToLower(err.Error())),
		}
	}

	// Step 3: Run merge-tree with --name-only for cleaner output
	// Order is: git merge-tree <target> <source> to simulate merging source INTO target
	mergeTreeResult := g.runner.RunGit(repoPath, "merge-tree", "--write-tree", "--name-only", targetRef, sourceRef)

	// Parse the output
	// Output format:
	// - First line is always the tree OID
	// - If exit code is 1, there are conflicts
	// - Subsequent lines (with --name-only) are conflicted file paths
	// - Informational messages come after a blank line

	conflictedFiles := []ConflictedFile{}
	output := mergeTreeResult.Stdout
	lines := strings.Split(strings.TrimSpace(output), "\n")

	// Exit code 1 means conflicts exist
	if mergeTreeResult.ExitCode == 1 {
		// Skip the first line (tree OID) and parse conflicted files
		// Lines between tree OID and blank line (or end) are file paths
		inConflictSection := false
		for i, line := range lines {
			line = strings.TrimSpace(line)

			// Skip the first line (tree OID - 40 char hex string)
			if i == 0 && len(line) >= 40 && isHexString(line[:40]) {
				inConflictSection = true
				continue
			}

			// Empty line marks end of conflict section
			if line == "" {
				break
			}

			// If we're in conflict section and have a non-empty line, it's a file path
			if inConflictSection && line != "" {
				conflictedFiles = append(conflictedFiles, ConflictedFile{
					Path:   line,
					Status: "potential-conflict",
				})
			}
		}

		return BranchConflictCheckResult{
			Success:         true,
			HasConflicts:    true,
			ConflictedFiles: conflictedFiles,
			ParentBranch:    targetBranch, // Keep for backward compat
			TargetBranch:    targetBranch,
			SourceBranch:    source,
			Message:         fmt.Sprintf("Found %d potential conflict(s) when merging '%s' into '%s'", len(conflictedFiles), source, targetBranch),
		}
	}

	// Exit code 0 means clean merge possible
	if mergeTreeResult.ExitCode == 0 {
		return BranchConflictCheckResult{
			Success:         true,
			HasConflicts:    false,
			ConflictedFiles: []ConflictedFile{},
			ParentBranch:    targetBranch, // Keep for backward compat
			TargetBranch:    targetBranch,
			SourceBranch:    source,
			Message:         fmt.Sprintf("No conflicts - '%s' can be merged cleanly into '%s'", source, targetBranch),
		}
	}

	// Other exit codes indicate an error
	return BranchConflictCheckResult{
		Success: false,
		Error:   fmt.Sprintf("Failed to check conflicts: %s", getErrorMessage(mergeTreeResult)),
	}
}

// isHexString checks if a string contains only hexadecimal characters
func isHexString(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// ConflictCommitInfo contains minimal commit info for conflict resolution display
type ConflictCommitInfo struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Message string `json:"message"`
}

// ConflictSidesInfo contains commit info for both sides of a conflict
type ConflictSidesInfo struct {
	Ours    ConflictCommitInfo `json:"ours"`   // HEAD - your local changes
	Theirs  ConflictCommitInfo `json:"theirs"` // The incoming branch
	Success bool               `json:"success"`
	Error   string             `json:"error,omitempty"`
}

// GetConflictSidesInfo returns commit information for both sides of a conflict.
// This is useful for displaying in the conflict resolution UI.
// Parameters:
//   - repoPath: Path to the git repository
//   - parentBranch: The branch being merged from (theirs)
func (g *GitService) GetConflictSidesInfo(repoPath string, parentBranch string) ConflictSidesInfo {
	result := ConflictSidesInfo{}

	// Get "ours" commit info (HEAD)
	oursFormat := "%H|%an|%cI|%s"
	oursResult := g.runner.RunGit(repoPath, "log", "-1", "--pretty=format:"+oursFormat, "HEAD")
	if oursResult.Success {
		parts := strings.SplitN(trimOutput(oursResult.Stdout), "|", 4)
		if len(parts) >= 4 {
			result.Ours = ConflictCommitInfo{
				Hash:    parts[0],
				Author:  parts[1],
				Date:    parts[2],
				Message: parts[3],
			}
		}
	}

	// Get "theirs" commit info (parent branch)
	// Try origin/<parentBranch> first, then local
	theirsRef := parentBranch
	refCheck := g.runner.RunGit(repoPath, "rev-parse", "--verify", "origin/"+parentBranch)
	if refCheck.Success {
		theirsRef = "origin/" + parentBranch
	}

	theirsResult := g.runner.RunGit(repoPath, "log", "-1", "--pretty=format:"+oursFormat, theirsRef)
	if theirsResult.Success {
		parts := strings.SplitN(trimOutput(theirsResult.Stdout), "|", 4)
		if len(parts) >= 4 {
			result.Theirs = ConflictCommitInfo{
				Hash:    parts[0],
				Author:  parts[1],
				Date:    parts[2],
				Message: parts[3],
			}
		}
	}

	result.Success = true
	return result
}

// ============================================================================
// Recovery Utilities
// ============================================================================

// LockFileInfo contains information about Git lock files in the repository
type LockFileInfo struct {
	IndexLockExists bool   `json:"indexLockExists"`
	IndexLockPath   string `json:"indexLockPath"`
	Error           string `json:"error,omitempty"`
}

// CheckLockFile checks if a .git/index.lock file exists in the repository.
// This lock file is created by Git during operations and can be left behind if
// a process crashes or is interrupted.
func (g *GitService) CheckLockFile(repoPath string) LockFileInfo {
	lockPath, err := gitAdminPath(g.runner, repoPath, "index.lock")
	if err != nil {
		return LockFileInfo{
			IndexLockExists: false,
			Error:           "Failed to check lock file: " + err.Error(),
		}
	}

	_, err = os.Stat(lockPath)
	if err != nil {
		if os.IsNotExist(err) {
			return LockFileInfo{
				IndexLockExists: false,
				IndexLockPath:   lockPath,
			}
		}
		return LockFileInfo{
			IndexLockExists: false,
			IndexLockPath:   lockPath,
			Error:           "Failed to check lock file: " + err.Error(),
		}
	}

	return LockFileInfo{
		IndexLockExists: true,
		IndexLockPath:   lockPath,
	}
}

// RemoveLockFile removes the .git/index.lock file from the repository.
// This is useful for recovering from a stale lock file left behind by a crashed
// Git process. Returns an OperationResult indicating success or failure.
//
// CAUTION: Only call this when you are certain no other Git operation is in progress.
// Removing a lock file while another Git process is running can cause corruption.
func (g *GitService) RemoveLockFile(repoPath string) OperationResult {
	// First verify this is a valid git repository
	repoInfo := g.DetectRepo(repoPath)
	if !repoInfo.IsRepo {
		return failedOp("Not a valid git repository")
	}

	lockPath, err := gitAdminPath(g.runner, repoPath, "index.lock")
	if err != nil {
		return failedOp("Failed to check lock file: " + err.Error())
	}

	// Check if lock file exists
	_, err = os.Stat(lockPath)
	if err != nil {
		if os.IsNotExist(err) {
			return OperationResult{
				Success: true,
				Message: "No lock file exists",
			}
		}
		return failedOp("Failed to check lock file: " + err.Error())
	}

	// Remove the lock file
	err = os.Remove(lockPath)
	if err != nil {
		return failedOp("Failed to remove lock file: " + err.Error())
	}

	return successOp("Lock file removed successfully")
}

// ============================================================================
// JSON Helpers
// ============================================================================

// parseJSON parses JSON data into a struct
func parseJSON(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// formatJSON formats a value as indented JSON
func formatJSON(v interface{}) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}
