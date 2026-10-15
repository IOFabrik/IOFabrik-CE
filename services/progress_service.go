// Package services provides backend functionality for the IOFabrik application.
// This file contains the ProgressService which runs git operations with progress streaming.
package services

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ProgressService handles git operations with progress reporting
type ProgressService struct {
	app          *application.App
	runner       *CommandRunner
	bus          *RepoEventBus
	syncSessions syncSessionLifecycle
	mu           sync.Mutex
}

// syncSessionLifecycle lets ProgressService keep ownership of CLI execution
// while IntegrationSessionService owns crash-safe default-branch Sync state.
type syncSessionLifecycle interface {
	BeginDefaultBranchSync(repoPath string) (sessionID string, eligible bool, err error)
	ReconcileSyncPull(sessionID string) (needsDecisions bool, err error)
	CompleteSyncShare(sessionID string) error
	FailSync(sessionID string, cause error)
}

const (
	syncOutcomeSynced         = "synced"
	syncOutcomeNeedsDecisions = "needs-decisions"
	syncOutcomeFailed         = "failed"
)

// SyncResult is a structured Sync completion contract. In particular,
// needs-decisions is neither encoded in an error string nor presented as a
// generic failure.
type SyncResult struct {
	Success bool   `json:"success"`
	Outcome string `json:"outcome"`
	Message string `json:"message"`
	Error   string `json:"error,omitempty"`
}

// NewProgressService creates a new ProgressService instance
func NewProgressService(syncSessions ...syncSessionLifecycle) *ProgressService {
	service := &ProgressService{
		runner: NewCommandRunner(),
	}
	if len(syncSessions) > 0 {
		service.syncSessions = syncSessions[0]
	}
	return service
}

// SetApp sets the Wails application reference for event emission
func (p *ProgressService) SetApp(app *application.App) {
	p.app = app
}

// SetRepoEventBus wires the service to the repository event bus so state
// holding services can react to the operations it runs.
func (p *ProgressService) SetRepoEventBus(bus *RepoEventBus) {
	p.bus = bus
}

// publishRepoMutation announces that an operation may have changed the
// repository's unmerged state. It runs even when the operation failed, because
// a failed pull is exactly how conflicts appear.
func (p *ProgressService) publishRepoMutation(repoPath string, reason RepoMutationReason) {
	p.bus.Publish(RepoMutated{RepoPath: repoPath, Reason: reason})
}

// ProgressUpdate represents a progress event sent to the frontend
type ProgressUpdate struct {
	OperationID string `json:"operationId"`
	Phase       string `json:"phase"`      // "starting", "enumerating", "counting", "compressing", "writing", "receiving", "resolving", "done", "error"
	Percent     int    `json:"percent"`    // 0-100, -1 for indeterminate
	Message     string `json:"message"`    // Human-readable status
	IsComplete  bool   `json:"isComplete"` // True when operation finished
	Success     bool   `json:"success"`    // True if completed successfully
	Error       string `json:"error"`      // Error message if failed
}

// Pre-compiled regex for parsing git progress
var (
	// Matches: "Receiving objects:  45% (123/456)"
	progressPercentRegex = regexp.MustCompile(`(\w[\w\s]+):\s*(\d+)%\s*\((\d+)/(\d+)\)`)
	// Matches: "Counting objects: 123, done."
	progressDoneRegex = regexp.MustCompile(`(\w[\w\s]+):\s*(\d+),?\s*done`)
	// Matches: "remote: Counting objects: 123"
	remoteProgressRegex = regexp.MustCompile(`remote:\s*(\w[\w\s]+):\s*(\d+)`)
)

// emitProgress sends a progress update to the frontend
func (p *ProgressService) emitProgress(update ProgressUpdate) {
	if p.app != nil {
		p.app.Event.Emit("git-progress", update)
	}
}

// parseGitProgress extracts progress info from a git stderr line
func parseGitProgress(line string) (phase string, percent int, message string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", -1, ""
	}

	if matches := progressPercentRegex.FindStringSubmatch(line); matches != nil {
		phase = strings.TrimSpace(strings.ToLower(matches[1]))
		if pct, err := strconv.Atoi(matches[2]); err == nil {
			percent = pct
		}
		return phase, percent, line
	}

	if matches := progressDoneRegex.FindStringSubmatch(line); matches != nil {
		phase = strings.TrimSpace(strings.ToLower(matches[1]))
		return phase, 100, line
	}

	if matches := remoteProgressRegex.FindStringSubmatch(line); matches != nil {
		phase = "remote: " + strings.TrimSpace(strings.ToLower(matches[1]))
		return phase, -1, line
	}

	lineLower := strings.ToLower(line)
	switch {
	case strings.Contains(lineLower, "enumerating"):
		return "enumerating", -1, line
	case strings.Contains(lineLower, "counting"):
		return "counting", -1, line
	case strings.Contains(lineLower, "compressing"):
		return "compressing", -1, line
	case strings.Contains(lineLower, "writing"):
		return "writing", -1, line
	case strings.Contains(lineLower, "receiving"):
		return "receiving", -1, line
	case strings.Contains(lineLower, "resolving"):
		return "resolving", -1, line
	case strings.Contains(lineLower, "unpacking"):
		return "unpacking", -1, line
	case strings.Contains(lineLower, "updating"):
		return "updating", -1, line
	}

	return "", -1, line
}

// SyncWithProgress performs git pull + push with progress updates
// For branches without an upstream, it skips pull and just pushes with --set-upstream
// prune: if true, adds --prune to remove stale remote-tracking branches
// tags: if true, adds --tags to fetch all tags
func (p *ProgressService) SyncWithProgress(repoPath, operationID string, prune bool, tags bool) SyncResult {
	previewRelease, previewErr := previewMutationLease(repoPath)
	if previewErr != nil {
		return failedSync(previewErr.Error())
	}
	defer previewRelease()

	p.mu.Lock()
	defer p.mu.Unlock()
	defer p.publishRepoMutation(repoPath, RepoMutationPull)

	if !p.hasAnyRemote(repoPath) {
		errMsg := "No remote repository configured. Publish to cloud first."
		p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
		return failedSync(errMsg)
	}

	runner := p.runner.forGitOperation()

	hasUpstream := p.checkHasUpstream(repoPath)
	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "starting", Percent: -1, Message: "Starting sync..."})

	sessionID := ""
	if hasUpstream && p.syncSessions != nil {
		var beginErr error
		sessionID, _, beginErr = p.syncSessions.BeginDefaultBranchSync(repoPath)
		if beginErr != nil {
			errMsg := beginErr.Error()
			p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
			return failedSync(errMsg)
		}
	}

	if hasUpstream {
		pullArgs := []string{"pull", "--no-rebase", "--progress"}
		if prune {
			pullArgs = append(pullArgs, "--prune")
		}
		if tags {
			pullArgs = append(pullArgs, "--tags")
		}

		pullResult := p.runGitWithProgress(runner, repoPath, operationID, pullArgs)
		if sessionID != "" {
			needsDecisions, reconcileErr := p.syncSessions.ReconcileSyncPull(sessionID)
			if needsDecisions {
				return SyncResult{
					Outcome: syncOutcomeNeedsDecisions,
					Message: integrationSessionOutcomeMessages[integrationStateNeedsDecisions],
				}
			}
			if reconcileErr != nil && pullResult.Success {
				p.syncSessions.FailSync(sessionID, reconcileErr)
				errMsg := "Failed to verify the default-branch sync: " + reconcileErr.Error()
				p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
				return failedSync(errMsg)
			}
		}
		if !pullResult.Success {
			errMsg := pullResult.Error
			if sessionID != "" {
				p.syncSessions.FailSync(sessionID, fmt.Errorf("pull default branch: %s", errMsg))
			}
			p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
			if strings.Contains(errMsg, "no tracking information") || strings.Contains(errMsg, "no upstream") {
				return failedSync("No remote branch configured. Please set up a remote first.")
			}
			return failedSync("Failed to sync (pull): " + errMsg)
		}
	}

	pushMessage := "Pushing changes to remote..."
	if !hasUpstream {
		pushMessage = "Publishing branch to remote..."
	}
	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "pushing", Percent: -1, Message: pushMessage})

	var pushArgs []string
	if hasUpstream {
		pushArgs = []string{"push", "--progress"}
	} else {
		branchName := p.getCurrentBranch(repoPath)
		if branchName == "" {
			p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: "Cannot determine current branch", IsComplete: true, Success: false, Error: "Cannot determine current branch"})
			return failedSync("Cannot determine current branch")
		}
		remoteName, ok := p.getPreferredRemote(repoPath)
		if !ok {
			return failedSync("No remote repository configured. Publish to cloud first.")
		}
		pushArgs = []string{"push", "--set-upstream", remoteName, branchName, "--progress"}
	}

	pushResult := p.runGitWithProgress(runner, repoPath, operationID, pushArgs)
	if !pushResult.Success {
		errMsg := pushResult.Error
		if sessionID != "" {
			p.syncSessions.FailSync(sessionID, fmt.Errorf("push default branch: %s", errMsg))
		}
		p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
		if strings.Contains(errMsg, "does not appear to be a git repository") || strings.Contains(errMsg, "No configured push destination") {
			return failedSync("No remote repository configured. Publish to cloud first.")
		}
		if strings.Contains(errMsg, "no upstream") || strings.Contains(errMsg, "has no upstream") {
			return failedSync("No remote branch configured. Please set up a remote first.")
		}
		if strings.Contains(errMsg, "rejected") {
			return failedSync("Push rejected. Remote has changes. Please sync again.")
		}
		return failedSync("Failed to sync (push): " + errMsg)
	}
	if sessionID != "" {
		if err := p.syncSessions.CompleteSyncShare(sessionID); err != nil {
			errMsg := "Your work was pushed, but IOFabrik couldn't save the Sync status. Refresh the project before syncing again."
			p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
			return failedSync(errMsg)
		}
	}

	successMessage := "Synced successfully"
	if !hasUpstream {
		successMessage = "Branch published successfully"
	}
	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "done", Percent: 100, Message: successMessage, IsComplete: true, Success: true})
	return SyncResult{Success: true, Outcome: syncOutcomeSynced, Message: successMessage}
}

func failedSync(message string) SyncResult {
	return SyncResult{Outcome: syncOutcomeFailed, Message: message, Error: message}
}

// checkHasUpstream checks if the current branch has an upstream configured.
// It is robust to restricted single-branch fetch refspecs, where a published
// branch's `@{u}` does not resolve because no remote-tracking ref is mirrored.
// Treating such a branch as "no upstream" would make Sync skip the pull and then
// fail the push as rejected, trapping the user in a re-sync loop.
func (p *ProgressService) checkHasUpstream(repoPath string) bool {
	branch := p.getCurrentBranch(repoPath)
	if branch == "" {
		// Detached HEAD or unknown branch: fall back to native detection.
		return p.runner.RunGit(repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").Success
	}
	_, ok := resolveBranchUpstreamShort(p.runner, repoPath, branch)
	return ok
}

func (p *ProgressService) hasAnyRemote(repoPath string) bool {
	result := p.runner.RunGit(repoPath, "remote")
	if !result.Success {
		return false
	}
	return strings.TrimSpace(result.Stdout) != ""
}

// getPreferredRemote returns origin when available, otherwise the first configured remote.
func (p *ProgressService) getPreferredRemote(repoPath string) (string, bool) {
	result := p.runner.RunGit(repoPath, "remote")
	if !result.Success {
		return "", false
	}

	lines := strings.Split(strings.TrimSpace(result.Stdout), "\n")
	remotes := make([]string, 0, len(lines))
	for _, line := range lines {
		name := strings.TrimSpace(line)
		if name != "" {
			remotes = append(remotes, name)
		}
	}

	if len(remotes) == 0 {
		return "", false
	}
	for _, remote := range remotes {
		if remote == "origin" {
			return remote, true
		}
	}
	return remotes[0], true
}

// getCurrentBranch returns the current branch name
func (p *ProgressService) getCurrentBranch(repoPath string) string {
	result := p.runner.RunGit(repoPath, "branch", "--show-current")
	if result.Success {
		return strings.TrimSpace(result.Stdout)
	}
	return ""
}

// PullWithProgress performs git pull with progress updates
func (p *ProgressService) PullWithProgress(repoPath, operationID string) OperationResult {
	previewRelease, previewErr := previewMutationLease(repoPath)
	if previewErr != nil {
		return failedOp(previewErr.Error())
	}
	defer previewRelease()

	p.mu.Lock()
	defer p.mu.Unlock()
	defer p.publishRepoMutation(repoPath, RepoMutationPull)

	if !p.hasAnyRemote(repoPath) {
		errMsg := "No remote repository configured. Publish to cloud first."
		p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
		return failedOp(errMsg)
	}

	runner := p.runner.forGitOperation()
	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "starting", Percent: -1, Message: "Fetching from remote..."})

	// Using merge strategy (not rebase) for safer conflict resolution
	result := p.runGitWithProgress(runner, repoPath, operationID, []string{"pull", "--no-rebase", "--progress"})
	if !result.Success {
		p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Message: result.Error, IsComplete: true, Success: false, Error: result.Error})
		return failedOp("Pull failed: " + result.Error)
	}

	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "done", Percent: 100, Message: "Pull complete", IsComplete: true, Success: true})
	return successOp("Pull complete")
}

// PushWithProgress performs git push with progress updates
func (p *ProgressService) PushWithProgress(repoPath, operationID string) OperationResult {
	previewRelease, previewErr := previewMutationLease(repoPath)
	if previewErr != nil {
		return failedOp(previewErr.Error())
	}
	defer previewRelease()

	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.hasAnyRemote(repoPath) {
		errMsg := "No remote repository configured. Publish to cloud first."
		p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Percent: 0, Message: errMsg, IsComplete: true, Success: false, Error: errMsg})
		return failedOp(errMsg)
	}

	runner := p.runner.forGitOperation()
	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "starting", Percent: -1, Message: "Pushing to remote..."})

	result := p.runGitWithProgress(runner, repoPath, operationID, []string{"push", "--progress"})
	if !result.Success {
		p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "error", Message: result.Error, IsComplete: true, Success: false, Error: result.Error})
		return failedOp("Push failed: " + result.Error)
	}

	p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: "done", Percent: 100, Message: "Push complete", IsComplete: true, Success: true})
	return successOp("Push complete")
}

// runGitWithProgress executes through the common runner and parses stderr.
func (p *ProgressService) runGitWithProgress(runner *CommandRunner, repoPath, operationID string, args []string) CommandResult {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var stdoutBuf, stderrBuf strings.Builder
	reader, writer := io.Pipe()
	parsed := make(chan struct{})
	go func() {
		defer close(parsed)
		defer reader.Close()
		input := bufio.NewReader(reader)
		var lastUpdate time.Time
		for {
			line, err := input.ReadString('\n')
			if line != "" {
				stderrBuf.WriteString(line)
				now := time.Now()
				if now.Sub(lastUpdate) >= 100*time.Millisecond {
					lastUpdate = now
					phase, percent, message := parseGitProgress(line)
					if phase != "" || message != "" {
						p.emitProgress(ProgressUpdate{OperationID: operationID, Phase: phase, Percent: percent, Message: strings.TrimSpace(message)})
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	result := runner.runWithWriters(ctx, repoPath, &stdoutBuf, writer, GitPath(), args...)
	writer.Close()
	<-parsed
	result.Stdout, result.Stderr = stdoutBuf.String(), stderrBuf.String()
	if !result.Success && result.Stderr != "" {
		result.Error = result.Stderr
	}
	return result
}
