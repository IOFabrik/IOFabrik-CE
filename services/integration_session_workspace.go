package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The isolated workspace is a detached, locked worktree the backend owns. It
// must never be confused with the user's project, never be reachable from
// their branches, and never be removed by anything that did not create it.

const (
	// integrationDiskSpaceMultiplier is how much room the checkout is assumed
	// to need relative to the destination tree.
	integrationDiskSpaceMultiplier = 2

	// integrationDiskSpaceFloor is the minimum free space required regardless
	// of project size, covering git's own scratch space.
	integrationDiskSpaceFloor = 256 << 20

	// windowsPathBudget is the classic MAX_PATH limit. Only enforced when long
	// path support is off.
	windowsPathBudget = 260

	integrationWorkspaceRemoveAttempts = 5
	integrationWorkspaceRemoveDelay    = 100 * time.Millisecond

	// integrationOwnershipMarkerName lives in the worktree's administrative
	// directory, outside the working tree, so it never shows up as untracked
	// content that could be swept into a resolution.
	integrationOwnershipMarkerName = "iofabrik-session.json"
)

type integrationOwnershipMarker struct {
	SessionID string `json:"sessionId"`
	CreatedAt int64  `json:"createdAt"`
}

// destinationTreeStats describes what materializing a revision would cost.
type destinationTreeStats struct {
	totalBytes       uint64
	longestPathLen   int
	hasSubmodules    bool
	trackedFileCount int
}

// createIntegrationWorkspace materializes the detached worktree for a session.
//
// LFS smudge is disabled so preparation stays fast on large projects; content
// for conflicted paths is fetched on demand later. Custom clean and smudge
// filters run normally, because a file the user resolves must look like the
// file they actually work with. Submodules are never initialized.
func createIntegrationWorkspace(runner gitAdminPathRunner, repoPath string, sessionID string, destinationOID string, workspacePath string) error {
	if !isValidIntegrationSessionID(sessionID) {
		return fmt.Errorf("invalid session id")
	}
	if strings.TrimSpace(destinationOID) == "" {
		return fmt.Errorf("destination revision is required")
	}
	if strings.TrimSpace(workspacePath) == "" {
		return fmt.Errorf("workspace path is required")
	}

	if err := checkIntegrationPreflight(runner, repoPath, destinationOID, workspacePath); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(workspacePath), integrationSessionDirMode); err != nil {
		return fmt.Errorf("failed to prepare the workspace location: %w", err)
	}

	addResult := runner.RunGit(repoPath,
		"-c", "filter.lfs.smudge=",
		"-c", "filter.lfs.process=",
		"-c", "filter.lfs.required=false",
		"worktree", "add", "--detach", workspacePath, destinationOID)
	if !addResult.Success {
		return fmt.Errorf("failed to create the review workspace: %s", getErrorMessage(addResult))
	}

	lockResult := runner.RunGit(repoPath, "worktree", "lock", "--reason", integrationWorktreeLockReason(sessionID), workspacePath)
	if !lockResult.Success {
		forceRemoveIntegrationWorkspace(runner, repoPath, workspacePath)
		return fmt.Errorf("failed to reserve the review workspace: %s", getErrorMessage(lockResult))
	}

	if err := writeIntegrationOwnershipMarker(runner, workspacePath, sessionID); err != nil {
		forceRemoveIntegrationWorkspace(runner, repoPath, workspacePath)
		return err
	}
	return nil
}

// removeIntegrationWorkspace tears down a session workspace. It is idempotent,
// and it refuses to touch a worktree this session does not own. Ownership is
// validated rather than pruned: `git worktree prune` would happily discard an
// active review that is merely unreachable at that moment.
func removeIntegrationWorkspace(runner gitAdminPathRunner, repoPath string, sessionID string, workspacePath string) error {
	if strings.TrimSpace(workspacePath) == "" {
		return nil
	}
	if _, err := os.Stat(workspacePath); err != nil {
		if os.IsNotExist(err) {
			// Already gone. Still clear any registration git may be holding.
			runner.RunGit(repoPath, "worktree", "unlock", workspacePath)
			runner.RunGit(repoPath, "worktree", "remove", "--force", workspacePath)
			return nil
		}
		return fmt.Errorf("failed to inspect the review workspace: %w", err)
	}

	if err := verifyIntegrationOwnership(runner, workspacePath, sessionID); err != nil {
		return err
	}
	return forceRemoveIntegrationWorkspace(runner, repoPath, workspacePath)
}

// forceRemoveIntegrationWorkspace skips the ownership check. Only for unwinding
// a workspace this process just created and failed to finish setting up.
func forceRemoveIntegrationWorkspace(runner gitAdminPathRunner, repoPath string, workspacePath string) error {
	runner.RunGit(repoPath, "worktree", "unlock", workspacePath)

	var lastError string
	for attempt := 0; attempt < integrationWorkspaceRemoveAttempts; attempt++ {
		result := runner.RunGit(repoPath, "worktree", "remove", "--force", workspacePath)
		if result.Success {
			lastError = ""
			break
		}
		lastError = getErrorMessage(result)
		if isMissingWorktreeMessage(lastError) {
			lastError = ""
			break
		}
		// Windows holds files open briefly after antivirus scans them.
		time.Sleep(integrationWorkspaceRemoveDelay)
	}

	// git leaves the directory behind when it was never a registered worktree.
	for attempt := 0; attempt < integrationWorkspaceRemoveAttempts; attempt++ {
		if _, err := os.Stat(workspacePath); os.IsNotExist(err) {
			return nil
		}
		if err := os.RemoveAll(workspacePath); err == nil {
			return nil
		}
		time.Sleep(integrationWorkspaceRemoveDelay)
	}

	if lastError != "" {
		return fmt.Errorf("failed to remove the review workspace: %s", lastError)
	}
	return fmt.Errorf("failed to remove the review workspace at %s", workspacePath)
}

func integrationWorktreeLockReason(sessionID string) string {
	return "IOFabrik Conflict Review " + sessionID
}

// cancelIntegrationSession removes everything a session created: its workspace,
// its prepared result ref, and its record. Neither branch is touched, and
// calling it again after it has succeeded is a no-op.
func cancelIntegrationSession(runner gitAdminPathRunner, store *integrationSessionStore, session integrationSession) error {
	if err := removeIntegrationWorkspace(runner, session.OpenProjectPath, session.SessionID, session.WorkspacePath); err != nil {
		return err
	}

	if err := deleteIntegrationResultRefs(runner, session.OpenProjectPath, session.SessionID); err != nil {
		return err
	}

	return store.delete(session.SessionID)
}

// cancelUpdateSession aborts an in-progress merge in the open project and
// verifies the feature branch is fully restored before discarding the record.
// It never rewinds a merge that already committed: once the update exists, the
// user must use Rewind, which is a separate action.
func cancelUpdateSession(runner gitAdminPathRunner, store *integrationSessionStore, session integrationSession) error {
	repo := session.OpenProjectPath

	if mergeInProgress(runner, repo) {
		if abort := runner.RunGit(repo, "merge", "--abort"); !abort.Success {
			return fmt.Errorf("Couldn't cancel the update. Close and reopen the project, then try again.")
		}
	}

	head := strings.TrimSpace(runner.RunGit(repo, "rev-parse", "--verify", "--quiet", session.SourceRef+"^{commit}").Stdout)
	if head != session.FeatureOIDBeforeMerge {
		return fmt.Errorf("This update was already added to your work. Use Rewind to undo it instead of cancelling.")
	}

	status := runner.RunGit(repo, "status", "--porcelain")
	if !status.Success || strings.TrimSpace(status.Stdout) != "" {
		return fmt.Errorf("Your work couldn't be fully restored. Close and reopen the project, then check your files.")
	}

	if err := store.delete(session.SessionID); err != nil {
		return fmt.Errorf("IOFabrik couldn't finish cancelling the update. Close and reopen IOFabrik, then try again.")
	}
	return nil
}

// mergeInProgress reports whether the open project is mid-merge, i.e. MERGE_HEAD
// exists.
func mergeInProgress(runner gitAdminPathRunner, repoPath string) bool {
	return runner.RunGit(repoPath, "rev-parse", "--verify", "--quiet", "MERGE_HEAD").Success
}

func isMissingWorktreeMessage(message string) bool {
	lowered := strings.ToLower(message)
	return strings.Contains(lowered, "is not a working tree") ||
		strings.Contains(lowered, "not a valid path") ||
		strings.Contains(lowered, "no such file or directory")
}

func writeIntegrationOwnershipMarker(runner gitAdminPathRunner, workspacePath string, sessionID string) error {
	markerPath, err := integrationOwnershipMarkerPath(runner, workspacePath)
	if err != nil {
		return err
	}

	payload, err := json.Marshal(integrationOwnershipMarker{SessionID: sessionID, CreatedAt: time.Now().Unix()})
	if err != nil {
		return fmt.Errorf("failed to encode the workspace marker: %w", err)
	}
	if err := os.WriteFile(markerPath, payload, integrationSessionFileMode); err != nil {
		return fmt.Errorf("failed to mark the review workspace: %w", err)
	}
	return nil
}

// verifyIntegrationOwnership fails unless the workspace is the one this session
// created.
func verifyIntegrationOwnership(runner gitAdminPathRunner, workspacePath string, sessionID string) error {
	markerPath, err := integrationOwnershipMarkerPath(runner, workspacePath)
	if err != nil {
		return err
	}

	payload, err := os.ReadFile(markerPath)
	if os.IsNotExist(err) {
		payload, err = os.ReadFile(filepath.Join(filepath.Dir(markerPath), "controlzebra-session.json"))
	}
	if err != nil {
		return fmt.Errorf("refusing to remove %s: it is not a IOFabrik review workspace", workspacePath)
	}

	marker := integrationOwnershipMarker{}
	if err := json.Unmarshal(payload, &marker); err != nil {
		return fmt.Errorf("refusing to remove %s: its ownership record is unreadable", workspacePath)
	}
	if marker.SessionID != sessionID {
		return fmt.Errorf("refusing to remove %s: it belongs to a different review", workspacePath)
	}
	return nil
}

func integrationOwnershipMarkerPath(runner gitAdminPathRunner, workspacePath string) (string, error) {
	adminDir, err := gitDirPath(runner, workspacePath)
	if err != nil {
		return "", fmt.Errorf("failed to locate the review workspace records: %w", err)
	}
	return filepath.Join(adminDir, integrationOwnershipMarkerName), nil
}

// checkIntegrationPreflight refuses to materialize content the machine cannot
// hold, before any worktree exists to clean up.
func checkIntegrationPreflight(runner gitAdminPathRunner, repoPath string, destinationOID string, workspacePath string) error {
	stats, err := inspectDestinationTree(runner, repoPath, destinationOID)
	if err != nil {
		return err
	}

	required := stats.totalBytes*integrationDiskSpaceMultiplier + integrationDiskSpaceFloor
	available, err := availableDiskBytesForPath(workspacePath)
	if err != nil {
		return fmt.Errorf("failed to check available disk space: %w", err)
	}
	if available < required {
		return fmt.Errorf("not enough free disk space to review these changes. Free about %d MB and try again", (required-available)/(1<<20)+1)
	}

	return checkIntegrationPathBudget(runner, repoPath, workspacePath, stats.longestPathLen)
}

// checkIntegrationPathBudget enforces the Windows MAX_PATH limit, and only when
// the repository has not opted into long paths.
func checkIntegrationPathBudget(runner gitAdminPathRunner, repoPath string, workspacePath string, longestPathLen int) error {
	if runtime.GOOS != "windows" || longestPathLen == 0 {
		return nil
	}
	if longPathsEnabled(runner, repoPath) {
		return nil
	}

	longest := len(workspacePath) + 1 + longestPathLen
	if longest >= windowsPathBudget {
		return fmt.Errorf("some file names in this project are too long to review on this computer. Move the project closer to the drive root and try again")
	}
	return nil
}

func longPathsEnabled(runner gitAdminPathRunner, repoPath string) bool {
	result := runner.RunGit(repoPath, "config", "--get", "core.longpaths")
	return result.Success && strings.EqualFold(strings.TrimSpace(result.Stdout), "true")
}

// inspectDestinationTree measures the revision one call at a time: total blob
// size, longest path, and whether submodules are present. Submodules are only
// recorded, never initialized.
func inspectDestinationTree(runner gitAdminPathRunner, repoPath string, destinationOID string) (destinationTreeStats, error) {
	stats := destinationTreeStats{}

	result := runner.RunGit(repoPath, "ls-tree", "-r", "-l", "-z", destinationOID)
	if !result.Success {
		return stats, fmt.Errorf("failed to inspect the project contents: %s", getErrorMessage(result))
	}

	for _, record := range strings.Split(result.Stdout, "\x00") {
		if record == "" {
			continue
		}
		header, path, found := strings.Cut(record, "\t")
		if !found || path == "" {
			continue
		}
		fields := strings.Fields(header)
		if len(fields) < 4 {
			continue
		}

		stats.trackedFileCount++
		if len(path) > stats.longestPathLen {
			stats.longestPathLen = len(path)
		}
		if fields[0] == gitlinkFileMode {
			stats.hasSubmodules = true
			continue
		}
		// Non-blob entries report "-" instead of a size.
		if size, err := strconv.ParseUint(fields[3], 10, 64); err == nil {
			stats.totalBytes += size
		}
	}
	return stats, nil
}

// availableDiskBytesForPath answers for a path that may not exist yet by
// walking up to the nearest existing ancestor.
func availableDiskBytesForPath(path string) (uint64, error) {
	candidate := filepath.Clean(path)
	for {
		if _, err := os.Stat(candidate); err == nil {
			return availableDiskBytes(candidate)
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return 0, fmt.Errorf("no existing directory found for %s", path)
		}
		candidate = parent
	}
}
