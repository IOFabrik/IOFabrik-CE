// Package services provides backend functionality for the IOFabrik application.
// This file owns the local snapshot lifecycle for GitHub Change Requests: the
// private refs a request is compared against, and the per-file availability
// checks that run before a viewer materializes any content.
package services

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// changeRequestRefNamespace holds the private refs a Change Request is
	// compared against. These refs are deliberately outside refs/heads and
	// refs/remotes so they never appear as branches to the user.
	changeRequestRefNamespace = "refs/iofabrik/change-requests"

	// Snapshot fetches routinely exceed the 30-second CommandRunner default on
	// the large binary repositories this product targets.
	changeRequestFetchTimeout = 10 * time.Minute
	changeRequestLFSTimeout   = 10 * time.Minute

	// changeRequestMaxSideBytes caps a single comparison side. Binary sides
	// cross the Wails bridge as base64 inside JSON (roughly 1.33x the file)
	// and are then copied into a UTF-16 JavaScript string, so an uncapped
	// large asset freezes or crashes the window instead of rendering.
	changeRequestMaxSideBytes int64 = 64 << 20

	// changeRequestPointerProbeBytes matches isLFSPointer's own ceiling. Blobs
	// larger than this are never LFS pointers, so we avoid reading them.
	changeRequestPointerProbeBytes int64 = 1024
)

// ============================================================================
// Types
// ============================================================================

// ChangeRequestSnapshot names the immutable local refs a Change Request is
// compared against. Callers use the ref names, never the OIDs, so specialized
// viewer cache keys stay stable across refreshes.
type ChangeRequestSnapshot struct {
	Number int `json:"number"`

	// HeadRef mirrors GitHub's refs/pull/<n>/head.
	HeadRef string `json:"headRef"`

	// BaseRef resolves to the merge base of the head and the base branch tip.
	// It is the merge base rather than the branch tip so that a two-dot
	// BaseRef..HeadRef diff equals GitHub's own three-dot file list.
	BaseRef string `json:"baseRef"`

	HeadOID    string `json:"headOid"`
	BaseOID    string `json:"baseOid"`
	BaseTipOID string `json:"baseTipOid"`
}

// ChangeRequestSnapshotResult reports the outcome of preparing local snapshots.
type ChangeRequestSnapshotResult struct {
	Success  bool                  `json:"success"`
	Snapshot ChangeRequestSnapshot `json:"snapshot,omitempty"`

	// ObservedHeadOID is set only on snapshot_stale so the frontend can reload
	// request detail before retrying.
	ObservedHeadOID string `json:"observedHeadOid,omitempty"`

	Message   string                       `json:"message,omitempty"`
	Error     string                       `json:"error,omitempty"`
	ErrorCode GitHubChangeRequestErrorCode `json:"errorCode"`
}

// ChangeRequestFileSide describes one side of a Change Request file comparison.
type ChangeRequestFileSide struct {
	Ref  string `json:"ref"`
	Path string `json:"path"`

	// Exists is false for the absent side of an addition or a deletion, which
	// is a normal state rather than an error.
	Exists bool `json:"exists"`

	// Size is the real file size. For an LFS-tracked file this is the size
	// recorded in the pointer, not the pointer's own byte length.
	Size int64 `json:"size"`

	IsLFS       bool `json:"isLfs"`
	LFSHydrated bool `json:"lfsHydrated"`
	TooLarge    bool `json:"tooLarge"`
}

// ChangeRequestFileContentResult reports whether a file can be compared in-app
// before any viewer attempts to load it.
type ChangeRequestFileContentResult struct {
	Success bool                  `json:"success"`
	OldSide ChangeRequestFileSide `json:"oldSide"`
	NewSide ChangeRequestFileSide `json:"newSide"`

	// Comparable gates viewer mount. Success reports whether the inspection
	// itself ran; Comparable reports whether the content can be shown.
	Comparable   bool  `json:"comparable"`
	MaxSizeBytes int64 `json:"maxSizeBytes"`

	Message   string                       `json:"message,omitempty"`
	Error     string                       `json:"error,omitempty"`
	ErrorCode GitHubChangeRequestErrorCode `json:"errorCode"`
}

// ============================================================================
// Per-repository serialization
// ============================================================================

// lockChangeRequestRepo acquires the per-repository lock and returns its
// release function.
//
// This lock lives in the backend on purpose. A React-side operation lock cannot
// serialize against RepositorySettingsService, which runs auto-fetch, LFS fetch,
// and maintenance from Go timers. It delegates to the shared repository
// coordinator so linked worktrees of one repository serialize together.
func lockChangeRequestRepo(repoPath string) func() {
	return sharedRepositoryCoordinator.lockRepo(repoPath)
}

// ============================================================================
// Ref naming
// ============================================================================

func changeRequestRefPrefix(number int) string {
	return changeRequestRefNamespace + "/" + strconv.Itoa(number)
}

func changeRequestHeadRef(number int) string {
	return changeRequestRefPrefix(number) + "/head"
}

// changeRequestBaseTipRef retains the fetched base branch tip. It is kept
// rather than discarded so a later phase can tell the user that the target
// branch has moved since the request was opened.
func changeRequestBaseTipRef(number int) string {
	return changeRequestRefPrefix(number) + "/basetip"
}

func changeRequestBaseRef(number int) string {
	return changeRequestRefPrefix(number) + "/base"
}

// ============================================================================
// Phase 3a-1: Snapshot refs
// ============================================================================

// EnsureChangeRequestSnapshotsLocal materializes the immutable local refs a
// Change Request is compared against.
//
// The base side is the merge base of the request head and the base branch tip,
// not the branch tip itself. GitHub's own file list is a three-dot diff, while
// the renderer this feature reuses is two-dot. Comparing against the branch tip
// would render every commit merged into the target branch after the work branch
// was cut as a reversal inside an unrelated Change Request.
//
// expectedHeadOID is GitHub's reported headRefOid and is verified strictly.
// The base is deliberately not verified against GitHub's baseRefOid: that value
// tracks the base branch tip, which moves on every merge into the default
// branch, so equality checking would report snapshot_stale on most opens.
func (g *GitService) EnsureChangeRequestSnapshotsLocal(
	repoPath string,
	number int,
	baseRefName string,
	expectedHeadOID string,
	isCrossRepository bool,
) (snapshotResult ChangeRequestSnapshotResult) {
	done := LogMethod("GitService.EnsureChangeRequestSnapshotsLocal", map[string]interface{}{
		"repoPath":          repoPath,
		"number":            number,
		"baseRefName":       baseRefName,
		"isCrossRepository": isCrossRepository,
	})
	defer func() { done(snapshotResult, nil) }()

	baseRefName = strings.TrimSpace(baseRefName)
	expectedHeadOID = strings.TrimSpace(expectedHeadOID)

	if strings.TrimSpace(repoPath) == "" {
		return changeRequestSnapshotFailure(GitHubChangeRequestErrorInternal, "Repository path is required")
	}
	if number <= 0 {
		return changeRequestSnapshotFailure(GitHubChangeRequestErrorInternal, "A Change Request number is required")
	}
	if baseRefName == "" {
		return changeRequestSnapshotFailure(GitHubChangeRequestErrorInternal, "The Change Request target branch is required")
	}
	if isCrossRepository {
		return changeRequestSnapshotFailure(
			GitHubChangeRequestErrorSnapshotUnsupported,
			"This Change Request comes from a separate copy of the project. Open it on GitHub to review the changes.",
		)
	}
	if _, err := g.OriginRemoteURL(repoPath); err != nil {
		return changeRequestSnapshotFailure(
			GitHubChangeRequestErrorOriginMissing,
			"This project needs its GitHub connection before Change Requests can be compared.",
		)
	}

	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	// The snapshot fetch uses the git transport, so gh's API session alone does
	// not authorize a private-repository fetch.
	g = g.forGitOperation()

	headRef := changeRequestHeadRef(number)
	baseTipRef := changeRequestBaseTipRef(number)
	baseRef := changeRequestBaseRef(number)

	ctx, cancel := context.WithTimeout(context.Background(), changeRequestFetchTimeout)
	defer cancel()

	// --prune is deliberately omitted: with explicit single-destination
	// refspecs it achieves nothing and only adds risk.
	fetchResult := g.runner.RunWithContext(
		ctx,
		repoPath,
		GitPath(),
		"fetch", "--no-tags", "--atomic", "origin",
		fmt.Sprintf("+refs/pull/%d/head:%s", number, headRef),
		"+refs/heads/"+baseRefName+":"+baseTipRef,
	)
	if !fetchResult.Success {
		return changeRequestSnapshotFailure(
			mapChangeRequestFetchError(fetchResult),
			changeRequestFetchErrorMessage(fetchResult),
		)
	}

	headOID, headResolved := g.resolveChangeRequestCommit(repoPath, headRef)
	if !headResolved {
		return changeRequestSnapshotFailure(
			GitHubChangeRequestErrorSnapshotUnavailable,
			"IOFabrik could not read this Change Request's latest changes from GitHub.",
		)
	}

	if expectedHeadOID != "" && !strings.EqualFold(expectedHeadOID, headOID) {
		return ChangeRequestSnapshotResult{
			ObservedHeadOID: headOID,
			ErrorCode:       GitHubChangeRequestErrorSnapshotStale,
			Error:           "This Change Request has been updated on GitHub. Refresh to load the latest changes.",
		}
	}

	baseTipOID, baseTipResolved := g.resolveChangeRequestCommit(repoPath, baseTipRef)
	if !baseTipResolved {
		return changeRequestSnapshotFailure(
			GitHubChangeRequestErrorSnapshotUnavailable,
			"IOFabrik could not read the '"+baseRefName+"' branch this Change Request targets.",
		)
	}

	mergeBaseResult := g.runner.RunGit(repoPath, "merge-base", headOID, baseTipOID)
	mergeBaseOID := trimOutput(mergeBaseResult.Stdout)
	if !mergeBaseResult.Success || mergeBaseOID == "" {
		return changeRequestSnapshotFailure(
			GitHubChangeRequestErrorSnapshotUnavailable,
			"IOFabrik could not find a common starting point between this Change Request and '"+baseRefName+"'.",
		)
	}

	if updateResult := g.runner.RunGit(repoPath, "update-ref", baseRef, mergeBaseOID); !updateResult.Success {
		return changeRequestSnapshotFailure(
			GitHubChangeRequestErrorSnapshotUnavailable,
			"IOFabrik could not prepare this Change Request for comparison: "+getErrorMessage(updateResult),
		)
	}

	return ChangeRequestSnapshotResult{
		Success: true,
		Message: "Change Request is ready to review",
		Snapshot: ChangeRequestSnapshot{
			Number:     number,
			HeadRef:    headRef,
			BaseRef:    baseRef,
			HeadOID:    headOID,
			BaseOID:    mergeBaseOID,
			BaseTipOID: baseTipOID,
		},
	}
}

// ClearChangeRequestSnapshots removes every Change Request snapshot ref for a
// repository. Call this on repository open as well as close: a crash otherwise
// leaves refs behind that anchor objects indefinitely.
func (g *GitService) ClearChangeRequestSnapshots(repoPath string) OperationResult {
	return g.deleteChangeRequestRefs(repoPath, changeRequestRefNamespace)
}

// ClearChangeRequestSnapshot removes the snapshot refs for a single request,
// used when a previously selected request is merged or closed upstream.
func (g *GitService) ClearChangeRequestSnapshot(repoPath string, number int) OperationResult {
	if number <= 0 {
		return failedOp("A Change Request number is required")
	}
	return g.deleteChangeRequestRefs(repoPath, changeRequestRefPrefix(number))
}

// deleteChangeRequestRefs deletes refs under a prefix in a single batch.
//
// CommandRunner executes through os/exec with no shell, so a `for-each-ref |
// xargs update-ref -d` pipeline is not available. The refs are listed, then
// deleted with one `update-ref --stdin` batch.
func (g *GitService) deleteChangeRequestRefs(repoPath string, refPrefix string) OperationResult {
	if strings.TrimSpace(repoPath) == "" {
		return failedOp("Repository path is required")
	}

	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	listResult := g.runner.RunGit(repoPath, "for-each-ref", "--format=%(refname)", refPrefix)
	if !listResult.Success {
		return failedOp("Failed to list Change Request snapshots: " + getErrorMessage(listResult))
	}

	var batch bytes.Buffer
	deleted := 0
	for _, line := range strings.Split(listResult.Stdout, "\n") {
		ref := strings.TrimSpace(line)
		// Guard against ever deleting outside the private namespace.
		if !strings.HasPrefix(ref, changeRequestRefNamespace+"/") {
			continue
		}
		batch.WriteString("delete " + ref + "\n")
		deleted++
	}

	if deleted == 0 {
		return successOp("No Change Request snapshots to remove")
	}

	deleteResult := g.runner.RunWithStdin(repoPath, batch.String(), GitPath(), "update-ref", "--stdin")
	if !deleteResult.Success {
		return failedOp("Failed to remove Change Request snapshots: " + getErrorMessage(deleteResult))
	}

	return successOp(fmt.Sprintf("Removed %d Change Request snapshot reference(s)", deleted))
}

// ============================================================================
// Phase 3a-2: Content availability
// ============================================================================

// EnsureChangeRequestFileContent reports whether a Change Request file can be
// compared inside the app, and hydrates only the LFS objects that file needs.
//
// LFS hydration is per file and per side on purpose. A whole-ref `git lfs fetch`
// downloads every LFS object in the tree at that ref — for both sides — which on
// a CAD or media repository is a multi-gigabyte blocking download to review a
// two-file request.
//
// An empty ref or path marks an absent side, which is the normal state for the
// old side of an addition and the new side of a deletion.
func (g *GitService) EnsureChangeRequestFileContent(
	repoPath string,
	oldRef string,
	oldPath string,
	newRef string,
	newPath string,
) (contentResult ChangeRequestFileContentResult) {
	done := LogMethod("GitService.EnsureChangeRequestFileContent", map[string]interface{}{
		"repoPath": repoPath,
		"oldRef":   oldRef,
		"oldPath":  oldPath,
		"newRef":   newRef,
		"newPath":  newPath,
	})
	defer func() { done(contentResult, nil) }()

	if strings.TrimSpace(repoPath) == "" {
		return ChangeRequestFileContentResult{
			Error:        "Repository path is required",
			ErrorCode:    GitHubChangeRequestErrorInternal,
			MaxSizeBytes: changeRequestMaxSideBytes,
		}
	}

	unlock := lockChangeRequestRepo(repoPath)
	defer unlock()

	g = g.forGitOperation()
	oldSide := g.inspectChangeRequestFileSide(repoPath, oldRef, oldPath)
	newSide := g.inspectChangeRequestFileSide(repoPath, newRef, newPath)

	result := ChangeRequestFileContentResult{
		Success:      true,
		OldSide:      oldSide,
		NewSide:      newSide,
		MaxSizeBytes: changeRequestMaxSideBytes,
	}

	switch {
	case oldSide.TooLarge || newSide.TooLarge:
		result.ErrorCode = GitHubChangeRequestErrorContentTooLarge
		result.Error = "This file is too large to compare inside IOFabrik. Open the Change Request on GitHub to review it."

	case changeRequestNeedsLFS(oldSide) || changeRequestNeedsLFS(newSide):
		result.ErrorCode = GitHubChangeRequestErrorContentLFSUnavailable
		result.Error = "This file is stored in Git LFS and its contents could not be downloaded. Check that Git LFS is installed and that you have access to this project's LFS storage."

	case !oldSide.Exists && !newSide.Exists:
		result.ErrorCode = GitHubChangeRequestErrorSnapshotUnavailable
		result.Error = "This file is not present in either version of the Change Request."

	default:
		result.Comparable = true
		result.Message = "File is ready to compare"
	}

	return result
}

// changeRequestNeedsLFS reports a side whose LFS content could not be hydrated.
func changeRequestNeedsLFS(side ChangeRequestFileSide) bool {
	return side.Exists && side.IsLFS && !side.LFSHydrated
}

// inspectChangeRequestFileSide resolves one side's blob, real size, and LFS
// state, then hydrates that single path when it is within the size limit.
func (g *GitService) inspectChangeRequestFileSide(repoPath string, ref string, path string) ChangeRequestFileSide {
	ref = strings.TrimSpace(ref)
	path = strings.TrimSpace(path)

	side := ChangeRequestFileSide{Ref: ref, Path: path}
	if ref == "" || path == "" {
		return side
	}

	relPath := filepath.ToSlash(strings.TrimPrefix(path, "./"))
	blobResult := g.runner.RunGit(repoPath, "rev-parse", "--verify", "--quiet", ref+":"+relPath)
	blobOID := trimOutput(blobResult.Stdout)
	if !blobResult.Success || blobOID == "" {
		// Absent side: normal for additions and deletions.
		return side
	}
	side.Exists = true

	sizeResult := g.runner.RunGit(repoPath, "cat-file", "-s", blobOID)
	if sizeResult.Success {
		if parsed, err := strconv.ParseInt(trimOutput(sizeResult.Stdout), 10, 64); err == nil {
			side.Size = parsed
		}
	}

	// Only blobs small enough to be a pointer are read back.
	if side.Size > 0 && side.Size <= changeRequestPointerProbeBytes {
		if data, err := g.runner.RunGitRaw(repoPath, "cat-file", "blob", blobOID); err == nil && isLFSPointer(data) {
			side.IsLFS = true
			if realSize, ok := parseLFSPointerSize(data); ok {
				side.Size = realSize
			}
		}
	}

	if side.Size > changeRequestMaxSideBytes {
		side.TooLarge = true
		return side
	}

	if side.IsLFS {
		side.LFSHydrated = g.hydrateChangeRequestLFSObject(repoPath, ref, relPath)
	}

	return side
}

// hydrateChangeRequestLFSObject fetches the LFS objects for one path at one ref
// from origin.
func (g *GitService) hydrateChangeRequestLFSObject(repoPath string, ref string, relPath string) bool {
	if !g.runner.RunGit(repoPath, "lfs", "version").Success {
		return false
	}

	g = g.forGitOperation()
	ctx, cancel := context.WithTimeout(context.Background(), changeRequestLFSTimeout)
	defer cancel()

	result := g.runner.RunWithContext(
		ctx,
		repoPath,
		GitPath(),
		"lfs", "fetch", "--include="+relPath, "origin", ref,
	)
	return result.Success
}

// parseLFSPointerSize reads the real file size recorded in an LFS pointer.
func parseLFSPointerSize(data []byte) (int64, bool) {
	for _, line := range strings.Split(string(data), "\n") {
		value, found := strings.CutPrefix(strings.TrimSpace(line), "size ")
		if !found {
			continue
		}
		size, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			return 0, false
		}
		return size, true
	}
	return 0, false
}

// ============================================================================
// Shared helpers
// ============================================================================

func (g *GitService) resolveChangeRequestCommit(repoPath string, ref string) (string, bool) {
	result := g.runner.RunGit(repoPath, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	oid := trimOutput(result.Stdout)
	if !result.Success || oid == "" {
		return "", false
	}
	return oid, true
}

func changeRequestSnapshotFailure(code GitHubChangeRequestErrorCode, message string) ChangeRequestSnapshotResult {
	return ChangeRequestSnapshotResult{ErrorCode: code, Error: message}
}

func mapChangeRequestFetchError(result CommandResult) GitHubChangeRequestErrorCode {
	message := strings.ToLower(strings.Join([]string{result.Stderr, result.Stdout, result.Error}, "\n"))
	switch {
	case strings.Contains(message, "could not resolve host"),
		strings.Contains(message, "network is unreachable"),
		strings.Contains(message, "connection refused"),
		strings.Contains(message, "connection timed out"),
		strings.Contains(message, "operation timed out"),
		strings.Contains(message, "failed to connect"):
		return GitHubChangeRequestErrorNetworkUnavailable
	case strings.Contains(message, "authentication failed"),
		strings.Contains(message, "could not read username"),
		strings.Contains(message, "terminal prompts disabled"),
		strings.Contains(message, "permission denied"),
		strings.Contains(message, "access denied"):
		return GitHubChangeRequestErrorPermissionDenied
	default:
		return GitHubChangeRequestErrorSnapshotUnavailable
	}
}

func changeRequestFetchErrorMessage(result CommandResult) string {
	switch mapChangeRequestFetchError(result) {
	case GitHubChangeRequestErrorNetworkUnavailable:
		return "IOFabrik could not reach GitHub to download this Change Request. Check your connection and try again."
	case GitHubChangeRequestErrorPermissionDenied:
		return "Your GitHub account does not have access to download this Change Request."
	default:
		return "IOFabrik could not download this Change Request from GitHub: " + getErrorMessage(result)
	}
}
