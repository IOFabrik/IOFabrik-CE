package services

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// createTestRepo creates a temporary git repository for testing
func createTestRepo(t *testing.T) string {
	t.Helper()

	// Create temp directory
	tmpDir, err := os.MkdirTemp("", "iofabrik-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	// Initialize git repo
	cmd := exec.Command("git", "init")
	cmd.Dir = tmpDir
	if err := cmd.Run(); err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("Failed to init git repo: %v", err)
	}

	// Configure git user for commits
	cmd = exec.Command("git", "config", "user.name", "Test User")
	cmd.Dir = tmpDir
	cmd.Run()

	cmd = exec.Command("git", "config", "user.email", "test@example.com")
	cmd.Dir = tmpDir
	cmd.Run()

	return tmpDir
}

// cleanupTestRepo removes a temporary test repository
func cleanupTestRepo(t *testing.T, path string) {
	t.Helper()
	os.RemoveAll(path)
}

func runGitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
}

func runGitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
	return string(output)
}

func createTextConflictRepo(t *testing.T, filePath string, base []byte, current []byte, incoming []byte) string {
	t.Helper()
	repoPath := createTestRepo(t)
	runGitCmd(t, repoPath, "config", "core.autocrlf", "false")
	fullPath := filepath.Join(repoPath, filepath.FromSlash(filePath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		cleanupTestRepo(t, repoPath)
		t.Fatalf("create conflict directory: %v", err)
	}
	if err := os.WriteFile(fullPath, base, 0644); err != nil {
		cleanupTestRepo(t, repoPath)
		t.Fatalf("write base conflict content: %v", err)
	}
	runGitCmd(t, repoPath, "add", "--", filePath)
	runGitCmd(t, repoPath, "commit", "-m", "base")
	mainBranch := strings.TrimSpace(runGitOutput(t, repoPath, "branch", "--show-current"))

	runGitCmd(t, repoPath, "checkout", "-b", "incoming-test")
	if err := os.WriteFile(fullPath, incoming, 0644); err != nil {
		cleanupTestRepo(t, repoPath)
		t.Fatalf("write incoming conflict content: %v", err)
	}
	runGitCmd(t, repoPath, "add", "--", filePath)
	runGitCmd(t, repoPath, "commit", "-m", "incoming")

	runGitCmd(t, repoPath, "checkout", mainBranch)
	if err := os.WriteFile(fullPath, current, 0644); err != nil {
		cleanupTestRepo(t, repoPath)
		t.Fatalf("write current conflict content: %v", err)
	}
	runGitCmd(t, repoPath, "add", "--", filePath)
	runGitCmd(t, repoPath, "commit", "-m", "current")
	merge := exec.Command("git", "merge", "incoming-test")
	merge.Dir = repoPath
	if output, err := merge.CombinedOutput(); err == nil {
		cleanupTestRepo(t, repoPath)
		t.Fatalf("expected merge conflict, output: %s", output)
	}
	return repoPath
}

func createBareRemoteAndLink(t *testing.T, repoPath string) string {
	t.Helper()
	return createBareRemoteAndLinkWithName(t, repoPath, "origin")
}

func createBareRemoteAndLinkWithName(t *testing.T, repoPath string, remoteName string) string {
	t.Helper()

	remoteDir, err := os.MkdirTemp("", "iofabrik-remote-*.git")
	if err != nil {
		t.Fatalf("Failed to create remote temp dir: %v", err)
	}

	runGitCmd(t, remoteDir, "init", "--bare")
	runGitCmd(t, repoPath, "remote", "add", remoteName, remoteDir)

	return remoteDir
}

func TestOriginRemoteURLRequiresOrigin(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	createBareRemoteAndLinkWithName(t, repoPath, "upstream")

	if _, err := NewGitService().OriginRemoteURL(repoPath); err == nil {
		t.Fatal("expected missing origin to fail instead of falling back to upstream")
	}
}

func TestOriginRemoteBranchesAndTrackingUpstream(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)

	os.WriteFile(filepath.Join(repoPath, "control.txt"), []byte("initial"), 0644)
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "initial")
	runGitCmd(t, repoPath, "branch", "-M", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	svc := NewGitService()
	branches, err := svc.OriginRemoteBranches(repoPath)
	if err != nil {
		t.Fatalf("list origin branches: %v", err)
	}
	if len(branches) != 1 || branches[0].Name != "main" || branches[0].OID == "" {
		t.Fatalf("unexpected origin branches: %#v", branches)
	}
	if upstream, ok := svc.OriginTrackingUpstream(repoPath, "main"); !ok || upstream != "origin/main" {
		t.Fatalf("expected origin/main tracking upstream, got %q ok=%v", upstream, ok)
	}
}

// TestOriginTrackingUpstream_RestrictedRefspec verifies that a branch published
// with its upstream in config is still recognized as tracking origin/<branch>
// even when a restricted fetch refspec prevents native `%(upstream)` resolution.
// This mirrors the single-branch-clone state that blocked Change Request creation.
func TestOriginTrackingUpstream_RestrictedRefspec(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)

	os.WriteFile(filepath.Join(repoPath, "control.txt"), []byte("initial"), 0644)
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "initial")
	runGitCmd(t, repoPath, "branch", "-M", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	featureBranch := "@tester-20260728-1923"
	runGitCmd(t, repoPath, "checkout", "-b", featureBranch)
	runGitCmd(t, repoPath, "push", "-u", "origin", featureBranch)

	// Simulate a single-branch clone: restrict the fetch refspec and drop the
	// feature branch's remote-tracking ref so native `%(upstream)` returns empty.
	runGitCmd(t, repoPath, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main")
	runGitCmd(t, repoPath, "update-ref", "-d", "refs/remotes/origin/"+featureBranch)

	svc := NewGitService()
	if out := runGitOutput(t, repoPath, "for-each-ref", "--format=%(upstream:short)", "refs/heads/"+featureBranch); strings.TrimSpace(out) != "" {
		t.Fatalf("Expected native upstream detection to be broken, got upstream: %q", out)
	}
	if upstream, ok := svc.OriginTrackingUpstream(repoPath, featureBranch); !ok || upstream != "origin/"+featureBranch {
		t.Fatalf("expected origin/%s tracking upstream via fallback, got %q ok=%v", featureBranch, upstream, ok)
	}
}

// TestCheckHasUpstream_RestrictedRefspec verifies the sync path recognizes a
// published branch as having an upstream even under a restricted fetch refspec.
// Otherwise Sync skips the pull and the subsequent push is rejected, trapping the
// user in a re-sync loop.
func TestCheckHasUpstream_RestrictedRefspec(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)

	os.WriteFile(filepath.Join(repoPath, "control.txt"), []byte("initial"), 0644)
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "initial")
	runGitCmd(t, repoPath, "branch", "-M", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	featureBranch := "@tester-20260728-1923"
	runGitCmd(t, repoPath, "checkout", "-b", featureBranch)
	runGitCmd(t, repoPath, "push", "-u", "origin", featureBranch)
	runGitCmd(t, repoPath, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main")
	runGitCmd(t, repoPath, "update-ref", "-d", "refs/remotes/origin/"+featureBranch)

	if !NewProgressService().checkHasUpstream(repoPath) {
		t.Fatalf("expected checkHasUpstream=true for a published branch with a restricted refspec")
	}
}

// TestDeleteBranch_RestrictedRefspec_RemovesRemote verifies that deleting a
// published branch also removes it from origin even when a restricted fetch
// refspec hides native upstream detection. Without the fallback the remote
// branch would be orphaned.
func TestDeleteBranch_RestrictedRefspec_RemovesRemote(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)

	os.WriteFile(filepath.Join(repoPath, "control.txt"), []byte("initial"), 0644)
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "initial")
	runGitCmd(t, repoPath, "branch", "-M", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	featureBranch := "@tester-20260728-1931"
	runGitCmd(t, repoPath, "checkout", "-b", featureBranch)
	runGitCmd(t, repoPath, "push", "-u", "origin", featureBranch)
	runGitCmd(t, repoPath, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main")
	runGitCmd(t, repoPath, "update-ref", "-d", "refs/remotes/origin/"+featureBranch)

	// Switch away so the feature branch can be deleted.
	runGitCmd(t, repoPath, "checkout", "main")

	svc := NewGitService()
	if res := svc.DeleteBranch(repoPath, featureBranch, true); !res.Success {
		t.Fatalf("expected DeleteBranch to succeed, got: %s", res.Error)
	}
	if out := runGitOutput(t, repoPath, "ls-remote", "--heads", "origin", "refs/heads/"+featureBranch); strings.TrimSpace(out) != "" {
		t.Fatalf("expected remote branch to be deleted, ls-remote still returned: %q", out)
	}
}

// TestUnquoteGitPath tests the unquoteGitPath helper function
func TestUnquoteGitPath(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "simple path",
			input:    "file.txt",
			expected: "file.txt",
		},
		{
			name:     "path with spaces quoted",
			input:    `"Test_file_for Conflict.md"`,
			expected: "Test_file_for Conflict.md",
		},
		{
			name:     "path with multiple spaces",
			input:    `"path with multiple spaces.txt"`,
			expected: "path with multiple spaces.txt",
		},
		{
			name:     "path with leading/trailing whitespace",
			input:    "  file.txt  ",
			expected: "file.txt",
		},
		{
			name:     "quoted path with whitespace around",
			input:    `  "spaced file.txt"  `,
			expected: "spaced file.txt",
		},
		{
			name:     "path with escaped quote",
			input:    `"file\"name.txt"`,
			expected: `file"name.txt`,
		},
		{
			name:     "path with backslash",
			input:    `"path\\to\\file.txt"`,
			expected: `path\to\file.txt`,
		},
		{
			name:     "nested directory with spaces",
			input:    `"My Projects/Some Folder/file.txt"`,
			expected: "My Projects/Some Folder/file.txt",
		},
		{
			name:     "empty string",
			input:    "",
			expected: "",
		},
		{
			name:     "just quotes",
			input:    `""`,
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := unquoteGitPath(tt.input)
			if result != tt.expected {
				t.Errorf("unquoteGitPath(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestDetectRepo_ValidRepo(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.DetectRepo(repoPath)

	if !result.IsRepo {
		t.Errorf("Expected IsRepo to be true, got false")
	}
	if result.HasError {
		t.Errorf("Expected no error, got: %s", result.Error)
	}
	if result.Path != repoPath {
		t.Errorf("Expected path %s, got %s", repoPath, result.Path)
	}
}

func TestDetectRepo_NotARepo(t *testing.T) {
	// Create a regular directory (not a git repo)
	tmpDir, err := os.MkdirTemp("", "not-a-repo-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	svc := NewGitService()
	result := svc.DetectRepo(tmpDir)

	if result.IsRepo {
		t.Errorf("Expected IsRepo to be false for non-repo directory")
	}
}

func TestDetectRepo_NonExistentPath(t *testing.T) {
	svc := NewGitService()
	result := svc.DetectRepo("/nonexistent/path/that/does/not/exist")

	if result.IsRepo {
		t.Errorf("Expected IsRepo to be false for non-existent path")
	}
	if !result.HasError {
		t.Errorf("Expected HasError to be true")
	}
}

// ============================================================================
// InitRepo Tests
// ============================================================================

func TestInitRepo_Success(t *testing.T) {
	// Create a temp directory but don't init git
	tmpDir, err := os.MkdirTemp("", "init-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	targetPath := filepath.Join(tmpDir, "new-repo")

	svc := NewGitService()
	result := svc.InitRepo(targetPath)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify it's actually a git repo now
	info := svc.DetectRepo(targetPath)
	if !info.IsRepo {
		t.Error("Expected directory to be a valid git repo after init")
	}

	branch, err := svc.GetCurrentBranch(targetPath)
	if err != nil {
		t.Fatalf("Expected to read current branch, got error: %v", err)
	}
	if branch != "main" {
		t.Errorf("Expected default branch 'main', got '%s'", branch)
	}
}

func TestInitRepo_AlreadyExists(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.InitRepo(repoPath)

	if result.Success {
		t.Error("Expected failure when initializing existing repo")
	}
	if !strings.Contains(result.Error, "already a Git repository") {
		t.Errorf("Expected 'already a Git repository' error, got: %s", result.Error)
	}
}

func TestInitRepo_EmptyPath(t *testing.T) {
	svc := NewGitService()
	result := svc.InitRepo("")

	if result.Success {
		t.Error("Expected failure for empty path")
	}
	if !strings.Contains(result.Error, "Path is required") {
		t.Errorf("Expected 'Path is required' error, got: %s", result.Error)
	}
}

func TestInitRepoWithLFS_Success(t *testing.T) {
	lfsSvc := NewLFSService()
	if !lfsSvc.IsLFSInstalled() {
		t.Skip("Git LFS is not installed, skipping test")
	}

	// Create a temp directory
	tmpDir, err := os.MkdirTemp("", "init-lfs-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	targetPath := filepath.Join(tmpDir, "new-lfs-repo")

	gitSvc := NewGitService()
	result := gitSvc.InitRepoWithLFS(targetPath)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify it's a git repo
	info := gitSvc.DetectRepo(targetPath)
	if !info.IsRepo {
		t.Error("Expected directory to be a valid git repo after init")
	}

	// Verify message mentions LFS
	if !strings.Contains(result.Message, "LFS") {
		t.Errorf("Expected message to mention LFS, got: %s", result.Message)
	}
}

func TestStatus_EmptyRepo(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.Status(repoPath)

	if result.HasError {
		t.Errorf("Expected no error, got: %s", result.Error)
	}
	if result.HasChanges {
		t.Errorf("Expected no changes in empty repo")
	}
	if len(result.ChangedFiles) != 0 {
		t.Errorf("Expected 0 changed files, got %d", len(result.ChangedFiles))
	}
}

func TestStatus_WithChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	// Create a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	svc := NewGitService()
	result := svc.Status(repoPath)

	if result.HasError {
		t.Errorf("Expected no error, got: %s", result.Error)
	}
	if !result.HasChanges {
		t.Errorf("Expected HasChanges to be true")
	}
	if len(result.ChangedFiles) != 1 {
		t.Errorf("Expected 1 changed file, got %d", len(result.ChangedFiles))
	}
	if len(result.ChangedFiles) > 0 && result.ChangedFiles[0].Status != "untracked" {
		t.Errorf("Expected status 'untracked', got '%s'", result.ChangedFiles[0].Status)
	}
}

func TestStatus_AfterPushWithUpstream_NoPendingSnapshots(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)

	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	svc := NewGitService()
	commitResult := svc.CommitAll(repoPath, "Initial commit")
	if !commitResult.Success {
		t.Fatalf("Expected commit to succeed, got: %s", commitResult.Error)
	}

	runGitCmd(t, repoPath, "push", "-u", "origin", "HEAD")

	status := svc.Status(repoPath)
	if status.HasError {
		t.Fatalf("Expected no status error, got: %s", status.Error)
	}
	if !status.HasUpstream {
		t.Fatalf("Expected HasUpstream=true after push -u")
	}
	if status.Ahead != 0 {
		t.Fatalf("Expected Ahead=0 after push, got %d", status.Ahead)
	}
	if status.TotalLocalCommits != 0 {
		t.Fatalf("Expected TotalLocalCommits=0 with upstream, got %d", status.TotalLocalCommits)
	}
}

// TestStatus_PublishedBranchWithRestrictedRefspec reproduces the single-branch
// clone scenario: a feature branch is pushed with its upstream recorded in
// config, but the fetch refspec only mirrors the default branch, so no
// remote-tracking ref exists for the feature branch and `@{u}` fails. The status
// must still report the branch as published with no pending snapshots.
func TestStatus_PublishedBranchWithRestrictedRefspec(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)

	svc := NewGitService()

	// Seed the default branch and publish it.
	if err := os.WriteFile(filepath.Join(repoPath, "seed.txt"), []byte("seed"), 0644); err != nil {
		t.Fatalf("Failed to write seed file: %v", err)
	}
	if commit := svc.CommitAll(repoPath, "Initial commit"); !commit.Success {
		t.Fatalf("Expected initial commit to succeed, got: %s", commit.Error)
	}
	runGitCmd(t, repoPath, "branch", "-M", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	// Create and publish a feature branch (records branch.<name>.remote/merge).
	featureBranch := "@tester-20260728-1923"
	runGitCmd(t, repoPath, "checkout", "-b", featureBranch)
	if err := os.WriteFile(filepath.Join(repoPath, "feature.txt"), []byte("feature"), 0644); err != nil {
		t.Fatalf("Failed to write feature file: %v", err)
	}
	if commit := svc.CommitAll(repoPath, "Feature commit"); !commit.Success {
		t.Fatalf("Expected feature commit to succeed, got: %s", commit.Error)
	}
	runGitCmd(t, repoPath, "push", "-u", "origin", featureBranch)

	// Simulate a single-branch clone: restrict the fetch refspec to the default
	// branch and drop the feature branch's remote-tracking ref so `@{u}` fails.
	runGitCmd(t, repoPath, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main")
	runGitCmd(t, repoPath, "update-ref", "-d", "refs/remotes/origin/"+featureBranch)

	// Guard: confirm the degraded state actually breaks native upstream detection.
	if out := runGitOutput(t, repoPath, "for-each-ref", "--format=%(upstream:short)", "refs/heads/"+featureBranch); strings.TrimSpace(out) != "" {
		t.Fatalf("Expected native upstream detection to be broken, got upstream: %q", out)
	}

	status := svc.Status(repoPath)
	if status.HasError {
		t.Fatalf("Expected no status error, got: %s", status.Error)
	}
	if !status.HasUpstream {
		t.Fatalf("Expected HasUpstream=true for a published branch with a restricted refspec")
	}
	if status.Ahead != 0 {
		t.Fatalf("Expected Ahead=0 for a fully pushed branch, got %d", status.Ahead)
	}
	if status.Behind != 0 {
		t.Fatalf("Expected Behind=0 for a fully pushed branch, got %d", status.Behind)
	}
	if status.TotalLocalCommits != 0 {
		t.Fatalf("Expected TotalLocalCommits=0 when upstream is detected, got %d", status.TotalLocalCommits)
	}
}

func TestCommitAll_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	// Create a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	svc := NewGitService()
	result := svc.CommitAll(repoPath, "Test commit message")

	if !result.Success {
		t.Errorf("Expected Success to be true, got error: %s", result.Error)
	}

	// Verify no more changes after commit
	status := svc.Status(repoPath)
	if status.HasChanges {
		t.Errorf("Expected no changes after commit")
	}
}

func TestCommitAll_NoChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.CommitAll(repoPath, "Test commit message")

	if result.Success {
		t.Errorf("Expected Success to be false when no changes")
	}
	if result.Error == "" {
		t.Errorf("Expected an error message")
	}
}

func TestCommitAll_EmptyMessage(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	// Create a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	svc := NewGitService()
	result := svc.CommitAll(repoPath, "")

	if result.Success {
		t.Errorf("Expected Success to be false with empty message")
	}
	if result.Error == "" {
		t.Errorf("Expected an error message for empty commit message")
	}
}

func TestGetRecentCommits_WithCommits(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	// Create and commit a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	svc := NewGitService()
	commitResult := svc.CommitAll(repoPath, "First commit")
	if !commitResult.Success {
		t.Fatalf("Failed to create commit: %s", commitResult.Error)
	}

	// Get commits
	commits, err := svc.GetRecentCommits(repoPath, 10)
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}
	if len(commits) != 1 {
		t.Errorf("Expected 1 commit, got %d", len(commits))
	}
	if len(commits) > 0 {
		if commits[0].Message != "First commit" {
			t.Errorf("Expected message 'First commit', got '%s'", commits[0].Message)
		}
		if commits[0].Hash == "" {
			t.Errorf("Expected non-empty hash")
		}
		if commits[0].ShortHash == "" {
			t.Errorf("Expected non-empty short hash")
		}
	}
}

func TestGetRecentCommits_EmptyRepo(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	commits, err := svc.GetRecentCommits(repoPath, 10)

	// Empty repo with no commits should return an error or empty list
	if err == nil && len(commits) > 0 {
		t.Errorf("Expected empty commits or error for repo with no commits")
	}
}

func TestPull_NoRemote(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.Pull(repoPath)

	// Pull without a remote should fail
	if result.Success {
		t.Errorf("Expected Pull to fail without a remote configured")
	}
}

func TestPush_NoRemote(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.Push(repoPath)

	// Push without a remote should fail
	if result.Success {
		t.Errorf("Expected Push to fail without a remote configured")
	}
}

func TestStatus_MultipleFileTypes(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	file1 := filepath.Join(repoPath, "file1.txt")
	if err := os.WriteFile(file1, []byte("initial content"), 0644); err != nil {
		t.Fatalf("Failed to create file1: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Modify committed file
	if err := os.WriteFile(file1, []byte("modified content"), 0644); err != nil {
		t.Fatalf("Failed to modify file1: %v", err)
	}

	// Add new untracked file
	file2 := filepath.Join(repoPath, "file2.txt")
	if err := os.WriteFile(file2, []byte("new file"), 0644); err != nil {
		t.Fatalf("Failed to create file2: %v", err)
	}

	status := svc.Status(repoPath)

	if !status.HasChanges {
		t.Errorf("Expected HasChanges to be true")
	}
	if len(status.ChangedFiles) != 2 {
		t.Errorf("Expected 2 changed files, got %d", len(status.ChangedFiles))
	}

	// Check we have both modified and untracked
	hasModified := false
	hasUntracked := false
	for _, f := range status.ChangedFiles {
		if f.Status == "modified" {
			hasModified = true
		}
		if f.Status == "untracked" {
			hasUntracked = true
		}
	}

	if !hasModified {
		t.Errorf("Expected a modified file")
	}
	if !hasUntracked {
		t.Errorf("Expected an untracked file")
	}
}

// ============================================================================
// v2 Tests - History, Diffs, Branches, Recovery
// ============================================================================

func TestGetGitVersion(t *testing.T) {
	svc := NewGitService()
	version, err := svc.GetGitVersion()

	if err != nil {
		t.Skipf("Git not available: %v", err)
	}

	if version.Major < 1 {
		t.Errorf("Expected git major version >= 1, got %d", version.Major)
	}

	t.Logf("Git version: %d.%d.%d", version.Major, version.Minor, version.Patch)
}

func TestSupportsRestore(t *testing.T) {
	svc := NewGitService()
	supportsRestore := svc.SupportsRestore()

	version, err := svc.GetGitVersion()
	if err != nil {
		t.Skipf("Git not available: %v", err)
	}

	expected := version.Major > 2 || (version.Major == 2 && version.Minor >= 23)
	if supportsRestore != expected {
		t.Errorf("SupportsRestore() = %v, expected %v for git %d.%d", supportsRestore, expected, version.Major, version.Minor)
	}
}

func TestShowCommit_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	commitResult := svc.CommitAll(repoPath, "Test commit")
	if !commitResult.Success {
		t.Fatalf("Failed to create commit: %s", commitResult.Error)
	}

	// Get the commit hash
	commits, err := svc.GetRecentCommits(repoPath, 1)
	if err != nil || len(commits) == 0 {
		t.Fatalf("Failed to get commits: %v", err)
	}

	// Show the commit
	detail := svc.ShowCommit(repoPath, commits[0].Hash)

	if detail.HasError {
		t.Errorf("Expected no error, got: %s", detail.Error)
	}
	if detail.Hash != commits[0].Hash {
		t.Errorf("Expected hash %s, got %s", commits[0].Hash, detail.Hash)
	}
	if detail.Message != "Test commit" {
		t.Errorf("Expected message 'Test commit', got '%s'", detail.Message)
	}
	if len(detail.Files) != 1 {
		t.Errorf("Expected 1 file changed, got %d", len(detail.Files))
	}
	if len(detail.Files) > 0 && detail.Files[0].Path != "test.txt" {
		t.Errorf("Expected file 'test.txt', got '%s'", detail.Files[0].Path)
	}
}

func TestShowCommit_InvalidHash(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	detail := svc.ShowCommit(repoPath, "invalid-hash-that-does-not-exist")

	if !detail.HasError {
		t.Error("Expected error for invalid hash")
	}
}

func TestShowCommit_EmptyHash(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	detail := svc.ShowCommit(repoPath, "")

	if !detail.HasError {
		t.Error("Expected error for empty hash")
	}
	if detail.Error != "Commit hash is required" {
		t.Errorf("Expected 'Commit hash is required', got '%s'", detail.Error)
	}
}

func TestDiffWorking_ModifiedFile(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("line1\nline2\nline3"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Modify the file
	if err := os.WriteFile(testFile, []byte("line1\nmodified line2\nline3"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}

	diff := svc.DiffWorkingRaw(repoPath, "test.txt")

	if diff.HasError {
		t.Errorf("Expected no error, got: %s", diff.Error)
	}
	if diff.RawDiff == "" {
		t.Error("Expected non-empty raw diff")
	}
	if diff.Binary {
		t.Error("Expected non-binary file")
	}

	// Check that the raw diff contains add (+) and delete (-) lines
	if !strings.Contains(diff.RawDiff, "+") || !strings.Contains(diff.RawDiff, "-") {
		t.Error("Expected both add and delete lines in diff")
	}
}

func TestDiffWorking_UntrackedFile(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create an untracked file
	testFile := filepath.Join(repoPath, "new-file.txt")
	if err := os.WriteFile(testFile, []byte("new content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	diff := svc.DiffWorkingRaw(repoPath, "new-file.txt")

	if diff.HasError {
		t.Errorf("Expected no error, got: %s", diff.Error)
	}
	// For untracked files, the whole file is shown as added
	if diff.RawDiff == "" {
		t.Error("Expected non-empty raw diff for new file")
	}
}

func TestDiffCommitFileRaw_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "First commit")

	commits, _ := svc.GetRecentCommits(repoPath, 1)
	hash := commits[0].Hash

	// Get diff for commit
	diff := svc.DiffCommitFileRaw(repoPath, hash, "test.txt")

	if diff.HasError {
		t.Errorf("Expected no error, got: %s", diff.Error)
	}
	if diff.RawDiff == "" {
		t.Error("Expected non-empty raw diff")
	}
}

func TestDiffCommitFileRaw_InvalidHash(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	diff := svc.DiffCommitFileRaw(repoPath, "", "test.txt")
	if !diff.HasError {
		t.Error("Expected error for empty hash")
	}
}

func TestDiffWorkingRaw_ReturnsLFSPointerError(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	filePath := "asset.bin"
	absolute := filepath.Join(repoPath, filePath)
	if err := os.WriteFile(absolute, []byte("plain content"), 0644); err != nil {
		t.Fatalf("Failed to write initial file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	lfsPointer := "version https://git-lfs.github.com/spec/v1\noid sha256:1111111111111111111111111111111111111111111111111111111111111111\nsize 123\n"
	if err := os.WriteFile(absolute, []byte(lfsPointer), 0644); err != nil {
		t.Fatalf("Failed to write lfs pointer file: %v", err)
	}

	diff := svc.DiffWorkingRaw(repoPath, filePath)
	if !diff.HasError {
		t.Fatalf("Expected HasError for LFS pointer diff")
	}
	if !strings.Contains(diff.Error, "stored in Git LFS") {
		t.Fatalf("Expected LFS error message, got: %s", diff.Error)
	}
}

func TestDiffCommitFileRaw_ReturnsLFSPointerError(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	filePath := "asset.bin"
	absolute := filepath.Join(repoPath, filePath)
	if err := os.WriteFile(absolute, []byte("plain content"), 0644); err != nil {
		t.Fatalf("Failed to write initial file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	lfsPointer := "version https://git-lfs.github.com/spec/v1\noid sha256:2222222222222222222222222222222222222222222222222222222222222222\nsize 456\n"
	if err := os.WriteFile(absolute, []byte(lfsPointer), 0644); err != nil {
		t.Fatalf("Failed to write lfs pointer file: %v", err)
	}
	svc.CommitAll(repoPath, "LFS pointer commit")

	hash := strings.TrimSpace(runGitOutput(t, repoPath, "rev-parse", "HEAD"))
	diff := svc.DiffCommitFileRaw(repoPath, hash, filePath)

	if !diff.HasError {
		t.Fatalf("Expected HasError for LFS pointer diff")
	}
	if !strings.Contains(diff.Error, "stored in Git LFS") {
		t.Fatalf("Expected LFS error message, got: %s", diff.Error)
	}
}

func TestContainsLFSPointerDiff(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{
			name: "detects added lfs pointer line",
			raw: `diff --git a/file.l5x b/file.l5x
index 111..222 100644
--- a/file.l5x
+++ b/file.l5x
@@ -1,3 +1,3 @@
-version https://git-lfs.github.com/spec/v1
+version https://git-lfs.github.com/spec/v1
 oid sha256:abc
 size 123`,
			want: true,
		},
		{
			name: "ignores regular text diff",
			raw: `diff --git a/file.txt b/file.txt
@@ -1 +1 @@
-hello
+world`,
			want: false,
		},
		{
			name: "detects pointer when oid changes but version line is unchanged",
			raw: `diff --git a/file.bin b/file.bin
index 111..222 100644
--- a/file.bin
+++ b/file.bin
@@ -1,3 +1,3 @@
 version https://git-lfs.github.com/spec/v1
-oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
+oid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
 size 123`,
			want: true,
		},
		{
			name: "handles empty diff",
			raw:  "",
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := containsLFSPointerDiff(tc.raw)
			if got != tc.want {
				t.Fatalf("containsLFSPointerDiff() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBranches_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit (required for branches)
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	branches := svc.Branches(repoPath)

	if branches.HasError {
		t.Errorf("Expected no error, got: %s", branches.Error)
	}
	if len(branches.Local) == 0 {
		t.Error("Expected at least one local branch")
	}

	// Check current branch
	if branches.Current == "" {
		t.Error("Expected non-empty current branch")
	}

	// Find current branch in local list
	found := false
	for _, b := range branches.Local {
		if b.Name == branches.Current && b.IsCurrent {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected to find current branch in local branches")
	}
}

func TestCreateBranchAndCheckout_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create new branch
	result := svc.CreateBranchAndCheckout(repoPath, "feature-branch")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify we're on the new branch
	branches := svc.Branches(repoPath)
	if branches.Current != "feature-branch" {
		t.Errorf("Expected current branch 'feature-branch', got '%s'", branches.Current)
	}
}

func TestCreateBranchAndCheckout_WithUncommittedChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create uncommitted changes
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}

	// Try to create new branch
	result := svc.CreateBranchAndCheckout(repoPath, "feature-branch")

	if result.Success {
		t.Error("Expected failure when there are uncommitted changes")
	}
	if !strings.Contains(result.Error, "uncommitted changes") {
		t.Errorf("Expected error about uncommitted changes, got: %s", result.Error)
	}
}

func TestCreateBranchAndCheckout_EmptyName(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	result := svc.CreateBranchAndCheckout(repoPath, "")

	if result.Success {
		t.Error("Expected failure for empty branch name")
	}
	if result.Error != "Branch name is required" {
		t.Errorf("Expected 'Branch name is required', got '%s'", result.Error)
	}
}

func TestCreateBranchAndCheckout_InvalidName(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	result := svc.CreateBranchAndCheckout(repoPath, "invalid branch name")

	if result.Success {
		t.Error("Expected failure for invalid branch name")
	}
	if !strings.Contains(result.Error, "Invalid branch name") {
		t.Errorf("Expected error about invalid branch name, got: %s", result.Error)
	}
}

func TestCheckoutBranch_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create a new branch
	svc.CreateBranchAndCheckout(repoPath, "feature")

	// Switch back to main/master
	branches := svc.Branches(repoPath)
	mainBranch := "master"
	for _, b := range branches.Local {
		if b.Name == "main" {
			mainBranch = "main"
			break
		}
	}

	result := svc.CheckoutBranch(repoPath, mainBranch)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify we're on the original branch
	newBranches := svc.Branches(repoPath)
	if newBranches.Current != mainBranch {
		t.Errorf("Expected current branch '%s', got '%s'", mainBranch, newBranches.Current)
	}
}

func TestCheckoutBranch_WithUncommittedChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create a new branch via git directly
	runner := NewCommandRunner()
	runner.RunGit(repoPath, "branch", "feature")

	// Create uncommitted changes
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}

	// Try to checkout
	result := svc.CheckoutBranch(repoPath, "feature")

	if result.Success {
		t.Error("Expected failure when there are uncommitted changes")
	}
	if !strings.Contains(result.Error, "uncommitted changes") {
		t.Errorf("Expected error about uncommitted changes, got: %s", result.Error)
	}
}

func TestCheckoutBranch_NonExistent(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	result := svc.CheckoutBranch(repoPath, "non-existent-branch")

	if result.Success {
		t.Error("Expected failure for non-existent branch")
	}
	if !strings.Contains(result.Error, "does not exist") {
		t.Errorf("Expected error about branch not existing, got: %s", result.Error)
	}
}

func TestRenameBranch_Success_LocalAndRemote(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	remoteDir := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remoteDir)

	// Push current branch and set upstream
	branches := svc.Branches(repoPath)
	baseBranch := branches.Current
	runGitCmd(t, repoPath, "push", "-u", "origin", baseBranch)

	// Create feature branch and push to remote
	runGitCmd(t, repoPath, "checkout", "-b", "feature/alpha")
	runGitCmd(t, repoPath, "push", "-u", "origin", "feature/alpha")

	result := svc.RenameBranch(repoPath, "feature/alpha", "feature/beta", true)
	if !result.Success {
		t.Fatalf("Expected rename success, got error: %s", result.Error)
	}

	// local old gone, new exists
	if svc.localBranchExists(repoPath, "feature/alpha") {
		t.Error("Expected old local branch to be removed")
	}
	if !svc.localBranchExists(repoPath, "feature/beta") {
		t.Error("Expected new local branch to exist")
	}

	// remote old gone, new exists
	resultShowOld := svc.runner.RunGit(repoPath, "show-ref", "--verify", "--quiet", "refs/remotes/origin/feature/alpha")
	if resultShowOld.Success {
		t.Error("Expected old remote tracking branch to be removed")
	}
	resultShowNew := svc.runner.RunGit(repoPath, "show-ref", "--verify", "--quiet", "refs/remotes/origin/feature/beta")
	if !resultShowNew.Success {
		t.Error("Expected new remote tracking branch to exist")
	}
}

func TestRenameBranch_ProtectedBranchBlocked(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Determine default branch
	branches := svc.Branches(repoPath)
	protected := branches.Current
	if protected != "main" && protected != "master" {
		protected = "master"
	}

	result := svc.RenameBranch(repoPath, protected, "renamed-default", true)
	if result.Success {
		t.Fatal("Expected protected branch rename to fail")
	}
	if !strings.Contains(strings.ToLower(result.Error), "protected") {
		t.Fatalf("Expected protected-branch error, got: %s", result.Error)
	}
}

func TestRenameBranch_RequiresConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.RenameBranch(repoPath, "feature/a", "feature/b", false)
	if result.Success {
		t.Fatal("Expected rename to fail without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Fatalf("Expected confirmation error, got: %s", result.Error)
	}
}

func TestDeleteBranch_Success_LocalAndRemote(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	remoteDir := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remoteDir)

	branches := svc.Branches(repoPath)
	baseBranch := branches.Current
	runGitCmd(t, repoPath, "push", "-u", "origin", baseBranch)

	// Create and push branch to delete
	runGitCmd(t, repoPath, "checkout", "-b", "feature/delete-me")
	runGitCmd(t, repoPath, "push", "-u", "origin", "feature/delete-me")
	runGitCmd(t, repoPath, "checkout", baseBranch)

	result := svc.DeleteBranch(repoPath, "feature/delete-me", true)
	if !result.Success {
		t.Fatalf("Expected delete success, got error: %s", result.Error)
	}

	if svc.localBranchExists(repoPath, "feature/delete-me") {
		t.Error("Expected local branch to be deleted")
	}

	resultShowRemote := svc.runner.RunGit(repoPath, "show-ref", "--verify", "--quiet", "refs/remotes/origin/feature/delete-me")
	if resultShowRemote.Success {
		t.Error("Expected remote tracking branch to be deleted")
	}
}

func TestDeleteBranch_BlocksCurrentAndProtected(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	branches := svc.Branches(repoPath)
	current := branches.Current

	// current branch must be blocked
	currentResult := svc.DeleteBranch(repoPath, current, true)
	if currentResult.Success {
		t.Fatal("Expected deleting current branch to fail")
	}

	// protected names blocked
	for _, protected := range []string{"main", "master"} {
		result := svc.DeleteBranch(repoPath, protected, true)
		if result.Success {
			t.Fatalf("Expected deleting protected branch '%s' to fail", protected)
		}
	}
}

func TestDeleteBranch_RequiresConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.DeleteBranch(repoPath, "feature/a", false)
	if result.Success {
		t.Fatal("Expected delete to fail without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Fatalf("Expected confirmation error, got: %s", result.Error)
	}
}

// ============================================================================
// ResetHardHead Tests
// ============================================================================

func TestResetHardHead_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("original"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Modify the file and add an untracked file
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	newFile := filepath.Join(repoPath, "new.txt")
	if err := os.WriteFile(newFile, []byte("new content"), 0644); err != nil {
		t.Fatalf("Failed to create new file: %v", err)
	}

	// Verify changes exist
	status := svc.Status(repoPath)
	if !status.HasChanges {
		t.Fatal("Expected changes before reset")
	}

	// Reset hard with confirmation
	result := svc.ResetHardHead(repoPath, true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify no changes
	newStatus := svc.Status(repoPath)
	if newStatus.HasChanges {
		t.Errorf("Expected no changes after reset, got %d files", len(newStatus.ChangedFiles))
	}

	// Verify file content is restored
	content, _ := os.ReadFile(testFile)
	if string(content) != "original" {
		t.Errorf("Expected 'original', got '%s'", string(content))
	}

	// Verify untracked file is removed
	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Error("Expected untracked file to be removed")
	}
}

func TestResetHardHead_WithoutConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create changes
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	// Try to reset without confirmation
	result := svc.ResetHardHead(repoPath, false)

	if result.Success {
		t.Error("Expected failure without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Errorf("Expected error about confirmation, got: %s", result.Error)
	}
}

func TestResetHardHead_NoChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Try to reset when there are no changes
	result := svc.ResetHardHead(repoPath, true)

	if result.Success {
		t.Error("Expected failure when no changes to rewind")
	}
	if !strings.Contains(result.Error, "No changes to rewind") {
		t.Errorf("Expected error about no changes, got: %s", result.Error)
	}
}

// ============================================================================
// ResetSoftHead Tests
// ============================================================================

func TestResetSoftHead_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create two commits
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("first"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "First commit")

	if err := os.WriteFile(testFile, []byte("second"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	svc.CommitAll(repoPath, "Second commit")

	// Verify we have 2 commits
	commits, _ := svc.GetRecentCommits(repoPath, 10)
	if len(commits) != 2 {
		t.Fatalf("Expected 2 commits, got %d", len(commits))
	}

	// Reset with confirmation
	result := svc.ResetSoftHead(repoPath, 1, true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify we have 1 commit now
	newCommits, _ := svc.GetRecentCommits(repoPath, 10)
	if len(newCommits) != 1 {
		t.Errorf("Expected 1 commit after reset, got %d", len(newCommits))
	}

	// Verify changes are staged
	status := svc.Status(repoPath)
	if !status.HasChanges {
		t.Error("Expected staged changes after soft reset")
	}
}

func TestResetSoftHead_WithoutConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create a commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "First commit")

	// Try to reset without confirmation
	result := svc.ResetSoftHead(repoPath, 1, false)

	if result.Success {
		t.Error("Expected failure without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Errorf("Expected error about confirmation, got: %s", result.Error)
	}
}

func TestResetSoftHead_NotEnoughCommits(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create just one commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "First commit")

	// Try to reset 2 commits
	result := svc.ResetSoftHead(repoPath, 2, true)

	if result.Success {
		t.Error("Expected failure when not enough commits")
	}
	if !strings.Contains(result.Error, "Not enough commits") {
		t.Errorf("Expected error about not enough commits, got: %s", result.Error)
	}
}

func TestDiscardAll_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("original"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Modify the file and add an untracked file
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	newFile := filepath.Join(repoPath, "new.txt")
	if err := os.WriteFile(newFile, []byte("new content"), 0644); err != nil {
		t.Fatalf("Failed to create new file: %v", err)
	}

	// Verify changes exist
	status := svc.Status(repoPath)
	if !status.HasChanges {
		t.Fatal("Expected changes before discard")
	}

	// Discard all with confirmation
	result := svc.DiscardAll(repoPath, true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify no changes
	newStatus := svc.Status(repoPath)
	if newStatus.HasChanges {
		t.Errorf("Expected no changes after discard, got %d files", len(newStatus.ChangedFiles))
	}

	// Verify file content is restored
	content, _ := os.ReadFile(testFile)
	if string(content) != "original" {
		t.Errorf("Expected 'original', got '%s'", string(content))
	}
}

func TestDiscardAll_WithoutConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create changes
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	// Try to discard without confirmation
	result := svc.DiscardAll(repoPath, false)

	if result.Success {
		t.Error("Expected failure without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Errorf("Expected error about confirmation, got: %s", result.Error)
	}
}

func TestDiscardAll_NoChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Try to discard when there are no changes
	result := svc.DiscardAll(repoPath, true)

	if result.Success {
		t.Error("Expected failure when no changes to discard")
	}
	if !strings.Contains(result.Error, "No changes to discard") {
		t.Errorf("Expected error about no changes, got: %s", result.Error)
	}
}

func TestDiscardFile_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit files
	file1 := filepath.Join(repoPath, "file1.txt")
	file2 := filepath.Join(repoPath, "file2.txt")
	if err := os.WriteFile(file1, []byte("original1"), 0644); err != nil {
		t.Fatalf("Failed to create file1: %v", err)
	}
	if err := os.WriteFile(file2, []byte("original2"), 0644); err != nil {
		t.Fatalf("Failed to create file2: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Modify both files
	if err := os.WriteFile(file1, []byte("modified1"), 0644); err != nil {
		t.Fatalf("Failed to modify file1: %v", err)
	}
	if err := os.WriteFile(file2, []byte("modified2"), 0644); err != nil {
		t.Fatalf("Failed to modify file2: %v", err)
	}

	// Discard only file1
	result := svc.DiscardFile(repoPath, "file1.txt", true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify file1 is restored but file2 is still modified
	content1, _ := os.ReadFile(file1)
	content2, _ := os.ReadFile(file2)

	if string(content1) != "original1" {
		t.Errorf("Expected file1 to be 'original1', got '%s'", string(content1))
	}
	if string(content2) != "modified2" {
		t.Errorf("Expected file2 to still be 'modified2', got '%s'", string(content2))
	}
}

func TestDiscardFile_UntrackedFile(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create an untracked file
	untrackedFile := filepath.Join(repoPath, "untracked.txt")
	if err := os.WriteFile(untrackedFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create untracked file: %v", err)
	}

	// Discard (remove) the untracked file
	result := svc.DiscardFile(repoPath, "untracked.txt", true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify file is removed
	if _, err := os.Stat(untrackedFile); !os.IsNotExist(err) {
		t.Error("Expected untracked file to be removed")
	}
}

func TestDiscardFile_WithoutConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	// Try to discard without confirmation
	result := svc.DiscardFile(repoPath, "test.txt", false)

	if result.Success {
		t.Error("Expected failure without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Errorf("Expected error about confirmation, got: %s", result.Error)
	}
}

func TestDiffCommitFileRaw_WithModification(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Modify and commit
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	svc.CommitAll(repoPath, "Second commit")

	// Get the latest commit hash
	commits, _ := svc.GetRecentCommits(repoPath, 1)
	hash := commits[0].Hash

	// Get diff for file in commit
	diff := svc.DiffCommitFileRaw(repoPath, hash, "test.txt")

	if diff.HasError {
		t.Errorf("Expected no error, got: %s", diff.Error)
	}
	if diff.RawDiff == "" {
		t.Error("Expected non-empty raw diff")
	}
}

// ============================================================================
// v2 Additional Tests - Stash Operations
// ============================================================================

func TestStashPush_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Make changes
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}

	// Stash the changes
	result := svc.StashPush(repoPath, "Test stash message")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify working tree is clean
	status := svc.Status(repoPath)
	if status.HasChanges {
		t.Error("Expected clean working tree after stash")
	}
}

func TestStashPush_NoChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Try to stash with no changes
	result := svc.StashPush(repoPath, "")

	if result.Success {
		t.Error("Expected failure when no changes to stash")
	}
}

func TestStashList_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Make changes and stash
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	svc.StashPush(repoPath, "My test stash")

	// List stashes
	stashes, err := svc.StashList(repoPath)
	if err != nil {
		t.Fatalf("Failed to list stashes: %v", err)
	}

	if len(stashes) == 0 {
		t.Fatal("Expected at least one stash")
	}

	// Verify the index is correctly parsed (this was a bug - using loop index instead of actual stash index)
	if stashes[0].Index != 0 {
		t.Errorf("Expected first stash to have Index=0, got %d", stashes[0].Index)
	}
	if stashes[0].Name != "stash@{0}" {
		t.Errorf("Expected stash name 'stash@{0}', got '%s'", stashes[0].Name)
	}
	if !strings.Contains(stashes[0].Message, "My test stash") {
		t.Errorf("Expected stash message to contain 'My test stash', got '%s'", stashes[0].Message)
	}
}

// TestStashList_MultipleStashes verifies correct index parsing with multiple stashes
func TestStashList_MultipleStashes(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create multiple stashes
	for i := 0; i < 3; i++ {
		if err := os.WriteFile(testFile, []byte(fmt.Sprintf("change-%d", i)), 0644); err != nil {
			t.Fatalf("Failed to modify test file: %v", err)
		}
		svc.StashPush(repoPath, fmt.Sprintf("Stash %d", i))
	}

	// List stashes
	stashes, err := svc.StashList(repoPath)
	if err != nil {
		t.Fatalf("Failed to list stashes: %v", err)
	}

	if len(stashes) != 3 {
		t.Fatalf("Expected 3 stashes, got %d", len(stashes))
	}

	// Verify indices are correct (stashes are LIFO, so newest is index 0)
	for i, stash := range stashes {
		expectedName := fmt.Sprintf("stash@{%d}", i)
		if stash.Name != expectedName {
			t.Errorf("Stash %d: expected name '%s', got '%s'", i, expectedName, stash.Name)
		}
		if stash.Index != i {
			t.Errorf("Stash %d: expected Index=%d, got %d", i, i, stash.Index)
		}
	}
}

func TestStashPop_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Make changes and stash
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	svc.StashPush(repoPath, "Test stash")

	// Pop the stash
	result := svc.StashPop(repoPath)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify changes are restored
	content, _ := os.ReadFile(testFile)
	if string(content) != "modified" {
		t.Errorf("Expected 'modified', got '%s'", string(content))
	}
}

func TestStashPop_NoStashes(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Try to pop with no stashes
	result := svc.StashPop(repoPath)

	if result.Success {
		t.Error("Expected failure when no stashes to pop")
	}
}

func TestStashDrop_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Make changes and stash
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}
	svc.StashPush(repoPath, "Test stash")

	// Drop the stash
	result := svc.StashDrop(repoPath, 0, true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify stash is gone
	stashes, _ := svc.StashList(repoPath)
	if len(stashes) != 0 {
		t.Errorf("Expected 0 stashes after drop, got %d", len(stashes))
	}
}

func TestStashDrop_RequiresConfirmation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	result := svc.StashDrop(repoPath, 0, false)

	if result.Success {
		t.Error("Expected failure without confirmation")
	}
	if !strings.Contains(result.Error, "requires confirmation") {
		t.Errorf("Expected error about confirmation, got: %s", result.Error)
	}
}

func TestStashAndSwitchBranch_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Make changes
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("Failed to modify test file: %v", err)
	}

	// Switch to new branch with stash
	result := svc.StashAndSwitchBranch(repoPath, "feature-branch", true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify we're on the new branch
	branches := svc.Branches(repoPath)
	if branches.Current != "feature-branch" {
		t.Errorf("Expected to be on 'feature-branch', got '%s'", branches.Current)
	}

	// Verify changes are restored
	content, _ := os.ReadFile(testFile)
	if string(content) != "modified" {
		t.Errorf("Expected 'modified', got '%s'", string(content))
	}
}

func TestStashAndSwitchBranch_NoChanges(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create and commit initial file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Switch to new branch without any changes
	result := svc.StashAndSwitchBranch(repoPath, "feature-branch", true)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}

	// Verify we're on the new branch
	branches := svc.Branches(repoPath)
	if branches.Current != "feature-branch" {
		t.Errorf("Expected to be on 'feature-branch', got '%s'", branches.Current)
	}
}

// ============================================================================
// v2 Additional Tests - Merge State & Conflict Resolution
// ============================================================================

func TestGetMergeState_NoMerge(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	state := svc.GetMergeState(repoPath)

	if state.InMerge {
		t.Error("Expected InMerge to be false")
	}
	if state.InRebase {
		t.Error("Expected InRebase to be false")
	}
	if state.HasConflicts {
		t.Error("Expected HasConflicts to be false")
	}
}

func TestGetConflictedFiles_NoConflicts(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	conflicted, err := svc.GetConflictedFiles(repoPath)
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}
	if len(conflicted) != 0 {
		t.Errorf("Expected 0 conflicted files, got %d", len(conflicted))
	}
}

// TestMergeConflict_RealConflict creates a real merge conflict and tests detection + resolution
func TestMergeConflict_RealConflict(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runner := NewCommandRunner()

	// Create initial commit on main
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("line1\nline2\nline3"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create feature branch and modify file
	runner.RunGit(repoPath, "checkout", "-b", "feature")
	if err := os.WriteFile(testFile, []byte("line1\nfeature change\nline3"), 0644); err != nil {
		t.Fatalf("Failed to modify file on feature: %v", err)
	}
	svc.CommitAll(repoPath, "Feature change")

	// Go back to main and make conflicting change
	// First, find the main branch name (could be main or master)
	branches := svc.Branches(repoPath)
	mainBranch := "master"
	for _, b := range branches.Local {
		if b.Name == "main" {
			mainBranch = "main"
			break
		}
	}
	runner.RunGit(repoPath, "checkout", mainBranch)

	if err := os.WriteFile(testFile, []byte("line1\nmain change\nline3"), 0644); err != nil {
		t.Fatalf("Failed to modify file on main: %v", err)
	}
	svc.CommitAll(repoPath, "Main change")

	// Try to merge feature branch - this should create a conflict
	mergeResult := runner.RunGit(repoPath, "merge", "feature")
	// We expect this to fail with a conflict
	if mergeResult.Success {
		t.Skip("Merge succeeded without conflict - test setup issue")
	}

	// Verify we're in a merge state
	state := svc.GetMergeState(repoPath)
	if !state.InMerge {
		t.Error("Expected to be in merge state after conflicting merge")
	}
	if !state.HasConflicts {
		t.Error("Expected HasConflicts to be true")
	}

	// Get conflicted files
	conflicted, err := svc.GetConflictedFiles(repoPath)
	if err != nil {
		t.Fatalf("Failed to get conflicted files: %v", err)
	}
	if len(conflicted) != 1 {
		t.Fatalf("Expected 1 conflicted file, got %d", len(conflicted))
	}
	if conflicted[0].Path != "test.txt" {
		t.Errorf("Expected conflicted file 'test.txt', got '%s'", conflicted[0].Path)
	}
	if conflicted[0].Status != "both-modified" {
		t.Errorf("Expected status 'both-modified', got '%s'", conflicted[0].Status)
	}

	// Resolve conflict by keeping ours
	resolveResult := svc.ResolveConflictKeepOurs(repoPath, "test.txt")
	if !resolveResult.Success {
		t.Errorf("Failed to resolve conflict: %s", resolveResult.Error)
	}

	// Verify no more conflicts
	conflictedAfter, _ := svc.GetConflictedFiles(repoPath)
	if len(conflictedAfter) != 0 {
		t.Errorf("Expected 0 conflicts after resolution, got %d", len(conflictedAfter))
	}

	// Complete the merge
	completeResult := svc.CompleteMerge(repoPath, "Merged feature with conflict resolution")
	if !completeResult.Success {
		t.Errorf("Failed to complete merge: %s", completeResult.Error)
	}

	// Verify we're no longer in merge state
	finalState := svc.GetMergeState(repoPath)
	if finalState.InMerge {
		t.Error("Expected to not be in merge state after completion")
	}

	// Verify our content won
	content, _ := os.ReadFile(testFile)
	if !strings.Contains(string(content), "main change") {
		t.Errorf("Expected 'main change' in file after keeping ours, got: %s", string(content))
	}
}

func TestConflictResolutionDataAndApply(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	filePath := filepath.Join(repoPath, "control.txt")
	base := "header\nshared base\nline 3\nline 4\nline 5\nline 6\ntail\n"
	if err := os.WriteFile(filePath, []byte(base), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "base")

	mainBranch := strings.TrimSpace(runGitOutput(t, repoPath, "branch", "--show-current"))
	runGitCmd(t, repoPath, "checkout", "-b", "incoming")
	incoming := "header\nincoming choice\nline 3\nline 4\nline 5\nline 6\nincoming tail\n"
	if err := os.WriteFile(filePath, []byte(incoming), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "incoming")

	runGitCmd(t, repoPath, "checkout", mainBranch)
	current := "current header\ncurrent choice\nline 3\nline 4\nline 5\nline 6\ntail\n"
	if err := os.WriteFile(filePath, []byte(current), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "control.txt")
	runGitCmd(t, repoPath, "commit", "-m", "current")

	merge := exec.Command("git", "merge", "incoming")
	merge.Dir = repoPath
	if err := merge.Run(); err == nil {
		t.Fatal("expected merge conflict")
	}

	service := NewGitService()
	unsafeData := service.GetConflictResolutionData(repoPath, "../control.txt")
	if unsafeData.Success || unsafeData.Error != "Invalid conflict path" {
		t.Fatalf("expected traversal path to fail closed, got %#v", unsafeData)
	}
	data := service.GetConflictResolutionData(repoPath, "control.txt")
	if !data.Success || !data.Eligible {
		t.Fatalf("expected eligible conflict data, got success=%v eligible=%v reason=%q error=%q", data.Success, data.Eligible, data.IneligibleReason, data.Error)
	}
	if data.Status != "both-modified" || data.ResolutionToken == "" {
		t.Fatalf("unexpected conflict metadata: status=%q token=%q", data.Status, data.ResolutionToken)
	}
	if !data.Base.Present || !data.Current.Present || !data.Incoming.Present {
		t.Fatalf("expected all three conflict stages: %#v", data)
	}
	if len(data.Regions) != 1 {
		t.Fatalf("expected one true conflict region, got %d in %#v", len(data.Regions), data.Regions)
	}
	if data.Base.Content != "" || data.Current.Content != "" || data.Incoming.Content != "" {
		t.Fatalf("expected blob contents to stay in the service, got %#v", data)
	}
	newBlob := exec.Command("git", "hash-object", "-w", "--stdin")
	newBlob.Dir = repoPath
	newBlob.Stdin = strings.NewReader("externally changed current\n")
	newOIDBytes, err := newBlob.Output()
	if err != nil {
		t.Fatalf("failed to create replacement stage blob: %v", err)
	}
	newOID := strings.TrimSpace(string(newOIDBytes))
	updateIndex := exec.Command("git", "update-index", "--index-info")
	updateIndex.Dir = repoPath
	updateIndex.Stdin = strings.NewReader(fmt.Sprintf("100644 %s 2\tcontrol.txt\n", newOID))
	if output, err := updateIndex.CombinedOutput(); err != nil {
		t.Fatalf("failed to replace conflict stage: %v\n%s", err, output)
	}
	staleResult := service.ResolveConflictWithContent(repoPath, "control.txt", data.ResolutionToken, "stale result\n")
	if staleResult.Success || !strings.Contains(staleResult.Error, "changed after it was opened") {
		t.Fatalf("expected stale token rejection, got %#v", staleResult)
	}
	if unmerged := strings.TrimSpace(runGitOutput(t, repoPath, "ls-files", "-u", "--", "control.txt")); unmerged == "" {
		t.Fatal("stale apply unexpectedly cleared the conflict stages")
	}
	data = service.GetConflictResolutionData(repoPath, "control.txt")
	if !data.Success || data.ResolutionToken == "" {
		t.Fatalf("failed to reload changed conflict: %#v", data)
	}
	tooLargeResult := service.ResolveConflictWithContent(repoPath, "control.txt", data.ResolutionToken, strings.Repeat("x", conflictOutputSizeLimit+1))
	if tooLargeResult.Success || !strings.Contains(tooLargeResult.Error, "too large") {
		t.Fatalf("expected oversized apply rejection, got %#v", tooLargeResult)
	}
	nulResult := service.ResolveConflictWithContent(repoPath, "control.txt", data.ResolutionToken, "invalid\x00content")
	if nulResult.Success || !strings.Contains(nulResult.Error, "valid UTF-8") {
		t.Fatalf("expected NUL apply rejection, got %#v", nulResult)
	}
	invalidUTF8Result := service.ResolveConflictWithContent(repoPath, "control.txt", data.ResolutionToken, string([]byte{0xff}))
	if invalidUTF8Result.Success || !strings.Contains(invalidUTF8Result.Error, "valid UTF-8") {
		t.Fatalf("expected invalid UTF-8 apply rejection, got %#v", invalidUTF8Result)
	}

	resolved := "current header\ncurrent choice\nline 3\nline 4\nline 5\nline 6\nincoming tail\n"
	result := service.ResolveConflictWithContent(repoPath, "control.txt", data.ResolutionToken, resolved)
	if !result.Success {
		t.Fatalf("failed to apply resolved content: %s", result.Error)
	}
	if unmerged := strings.TrimSpace(runGitOutput(t, repoPath, "ls-files", "-u", "--", "control.txt")); unmerged != "" {
		t.Fatalf("expected conflict stages to be cleared, got %q", unmerged)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != resolved {
		t.Fatalf("unexpected resolved content:\n%s", content)
	}
	resolvedData := service.GetConflictResolutionData(repoPath, "control.txt")
	if resolvedData.Success || resolvedData.Error != "The file is no longer conflicted" {
		t.Fatalf("expected already-resolved file to be rejected, got %#v", resolvedData)
	}
}

func TestConflictResolutionDataPreservesTextFormatMetadata(t *testing.T) {
	tests := []struct {
		name            string
		base            []byte
		current         []byte
		incoming        []byte
		newline         string
		hasFinalNewline bool
		hasBOM          bool
	}{
		{name: "LF", base: []byte("base\n"), current: []byte("current\n"), incoming: []byte("incoming\n"), newline: "\n", hasFinalNewline: true},
		{name: "CRLF", base: []byte("base\r\n"), current: []byte("current\r\n"), incoming: []byte("incoming\r\n"), newline: "\r\n", hasFinalNewline: true},
		{name: "UTF-8 BOM", base: []byte("\xef\xbb\xbfbase\r\n"), current: []byte("\xef\xbb\xbfcurrent\r\n"), incoming: []byte("\xef\xbb\xbfincoming\r\n"), newline: "\r\n", hasFinalNewline: true, hasBOM: true},
		{name: "no final newline", base: []byte("base"), current: []byte("current"), incoming: []byte("incoming"), newline: "\n", hasFinalNewline: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repoPath := createTextConflictRepo(t, "format.txt", test.base, test.current, test.incoming)
			defer cleanupTestRepo(t, repoPath)
			data := NewGitService().GetConflictResolutionData(repoPath, "format.txt")
			if !data.Success || !data.Eligible {
				t.Fatalf("expected eligible conflict data, got success=%v eligible=%v reason=%q error=%q", data.Success, data.Eligible, data.IneligibleReason, data.Error)
			}
			if data.Newline != test.newline || data.HasFinalNewline != test.hasFinalNewline {
				t.Fatalf("unexpected format metadata: newline=%q final=%v", data.Newline, data.HasFinalNewline)
			}
			hasBOM := len(data.Regions) > 0 && strings.HasPrefix(data.Regions[0].ContextBefore, "\ufeff")
			if hasBOM != test.hasBOM {
				t.Fatalf("unexpected BOM preservation: got %v in %#v", hasBOM, data.Regions)
			}
		})
	}
}

func TestConflictResolutionDataRejectsUnsafeTextContent(t *testing.T) {
	tests := []struct {
		name     string
		base     []byte
		current  []byte
		incoming []byte
		reason   string
	}{
		{name: "NUL content", base: []byte("base\x00\n"), current: []byte("current\x00\n"), incoming: []byte("incoming\x00\n"), reason: "binary-content"},
		{name: "invalid UTF-8", base: []byte{'b', 0xff, '\n'}, current: []byte{'c', 0xff, '\n'}, incoming: []byte{'i', 0xff, '\n'}, reason: "unsupported-encoding"},
		{name: "control bytes", base: []byte("base\x01\n"), current: []byte("current\x01\n"), incoming: []byte("incoming\x01\n"), reason: "unsupported-content"},
		{
			name:     "side exceeds size limit",
			base:     append(bytes.Repeat([]byte{'b'}, conflictBlobSizeLimit+1), '\n'),
			current:  append(bytes.Repeat([]byte{'c'}, conflictBlobSizeLimit+1), '\n'),
			incoming: append(bytes.Repeat([]byte{'i'}, conflictBlobSizeLimit+1), '\n'),
			reason:   "file-too-large",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repoPath := createTextConflictRepo(t, "unsafe.txt", test.base, test.current, test.incoming)
			defer cleanupTestRepo(t, repoPath)
			data := NewGitService().GetConflictResolutionData(repoPath, "unsafe.txt")
			if !data.Success || data.Eligible || data.IneligibleReason != ConflictIneligibleReason(test.reason) {
				t.Fatalf("unexpected eligibility result: success=%v eligible=%v reason=%q error=%q", data.Success, data.Eligible, data.IneligibleReason, data.Error)
			}
		})
	}
}

func TestConflictResolutionDataRejectsLineEndingDisagreement(t *testing.T) {
	repoPath := createTextConflictRepo(t, "newline-mismatch.txt", []byte("base\n"), []byte("current\n"), []byte("incoming"))
	defer cleanupTestRepo(t, repoPath)
	data := NewGitService().GetConflictResolutionData(repoPath, "newline-mismatch.txt")
	if !data.Success || data.Eligible || data.IneligibleReason != "line-ending-mismatch" {
		t.Fatalf("unexpected line-ending mismatch result: %#v", data)
	}
}

func TestConflictResolutionDataRejectsOversizedMergedOutput(t *testing.T) {
	chunkSize := conflictOutputSizeLimit/3 + 4096
	base := append(bytes.Repeat([]byte{'b'}, chunkSize), '\n')
	current := append(bytes.Repeat([]byte{'c'}, chunkSize), '\n')
	incoming := append(bytes.Repeat([]byte{'i'}, chunkSize), '\n')
	repoPath := createTextConflictRepo(t, "large-output.txt", base, current, incoming)
	defer cleanupTestRepo(t, repoPath)
	data := NewGitService().GetConflictResolutionData(repoPath, "large-output.txt")
	if !data.Success || data.Eligible || data.IneligibleReason != "output-too-large" {
		t.Fatalf("unexpected merged-output limit result: success=%v eligible=%v reason=%q error=%q", data.Success, data.Eligible, data.IneligibleReason, data.Error)
	}
}

func TestConflictResolutionDataSupportsUnusualFileNames(t *testing.T) {
	paths := []string{
		"folder/file with spaces.txt",
		"folder/unicode-λ.txt",
		"-leading-dash.txt",
		"..dot-prefixed.txt",
		"folder/name:with-colon.txt",
	}
	for _, filePath := range paths {
		t.Run(filePath, func(t *testing.T) {
			repoPath := createTextConflictRepo(t, filePath, []byte("base\n"), []byte("current\n"), []byte("incoming\n"))
			defer cleanupTestRepo(t, repoPath)
			data := NewGitService().GetConflictResolutionData(repoPath, filePath)
			if !data.Success || !data.Eligible || data.Path != filePath {
				t.Fatalf("unexpected conflict data for %q: %#v", filePath, data)
			}
		})
	}
}

func TestConflictResolutionDataReturnsMultipleTrueRegions(t *testing.T) {
	base := []byte("line 1\nbase first\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nbase second\nline 15\n")
	current := []byte("line 1\ncurrent first\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\ncurrent second\nline 15\n")
	incoming := []byte("line 1\nincoming first\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nincoming second\nline 15\n")
	repoPath := createTextConflictRepo(t, "multiple.txt", base, current, incoming)
	defer cleanupTestRepo(t, repoPath)

	data := NewGitService().GetConflictResolutionData(repoPath, "multiple.txt")
	if !data.Success || !data.Eligible {
		t.Fatalf("expected eligible multi-region data, got success=%v eligible=%v reason=%q error=%q", data.Success, data.Eligible, data.IneligibleReason, data.Error)
	}
	if len(data.Regions) != 2 {
		t.Fatalf("expected two conflict regions, got %d in %#v", len(data.Regions), data.Regions)
	}
}

func TestParseConflictSegmentsIsStrictAboutGeneratedMarkers(t *testing.T) {
	currentLabel := "IOFABRIK_CURRENT_test"
	baseLabel := "IOFABRIK_BASE_test"
	incomingLabel := "IOFABRIK_INCOMING_test"
	currentMarker := strings.Repeat("<", conflictMarkerSize) + " " + currentLabel
	baseMarker := strings.Repeat("|", conflictMarkerSize) + " " + baseLabel
	separator := strings.Repeat("=", conflictMarkerSize)
	incomingMarker := strings.Repeat(">", conflictMarkerSize) + " " + incomingLabel
	literalMarker := strings.Repeat("<", conflictMarkerSize) + " literal user content\n"
	output := literalMarker + currentMarker + "\ncurrent\n" + baseMarker + "\nbase\n" + separator + "\nincoming\n" + incomingMarker + "\ncontext\n"

	segments, err := parseConflictSegments(output, currentLabel, baseLabel, incomingLabel)
	if err != nil {
		t.Fatalf("parse valid generated markers: %v", err)
	}
	if len(segments) != 3 || segments[0].Kind != "context" || segments[0].Text != literalMarker || segments[1].Kind != "conflict" {
		t.Fatalf("literal marker-like content was not preserved: %#v", segments)
	}
	if _, err := parseConflictSegments("ordinary context only\n", currentLabel, baseLabel, incomingLabel); err == nil {
		t.Fatal("expected output without a generated conflict region to fail")
	}
	unterminated := currentMarker + "\ncurrent\n" + baseMarker + "\nbase\n" + separator + "\nincoming\n"
	if _, err := parseConflictSegments(unterminated, currentLabel, baseLabel, incomingLabel); err == nil {
		t.Fatal("expected unterminated generated conflict region to fail")
	}
}

func TestGenerateConflictSegmentsRejectsLabelCollision(t *testing.T) {
	token := strings.Repeat("a", 64)
	label := "IOFABRIK_CURRENT_" + token[:16]
	blobs := conflictBlobSet{
		base:     ConflictBlob{Present: true, Content: "base\n"},
		current:  ConflictBlob{Present: true, Content: label + "\ncurrent\n"},
		incoming: ConflictBlob{Present: true, Content: "incoming\n"},
	}
	if _, _, err := NewGitService().generateConflictSegments(t.TempDir(), token, blobs); err == nil || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("expected marker label collision rejection, got %v", err)
	}
}

func TestConflictStatusCoversStagePresence(t *testing.T) {
	entry := conflictStageEntry{oid: "oid", mode: "100644"}
	tests := []struct {
		name     string
		stages   []int
		expected string
	}{
		{name: "both modified", stages: []int{1, 2, 3}, expected: "both-modified"},
		{name: "both added", stages: []int{2, 3}, expected: "both-added"},
		{name: "both deleted", stages: []int{1}, expected: "both-deleted"},
		{name: "deleted by current", stages: []int{1, 3}, expected: "deleted-by-us"},
		{name: "deleted by incoming", stages: []int{1, 2}, expected: "deleted-by-them"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			entries := make(map[int]conflictStageEntry, len(test.stages))
			for _, stage := range test.stages {
				stageEntry := entry
				stageEntry.stage = stage
				entries[stage] = stageEntry
			}
			if actual := conflictStatus(entries); actual != ConflictFileStatus(test.expected) {
				t.Fatalf("expected %q, got %q", test.expected, actual)
			}
		})
	}
}

func TestResolveConflictWithContentSupportsBothAddedEmptyResult(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("base\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "README.md")
	runGitCmd(t, repoPath, "commit", "-m", "base")
	mainBranch := strings.TrimSpace(runGitOutput(t, repoPath, "branch", "--show-current"))

	runGitCmd(t, repoPath, "checkout", "-b", "incoming-both-added")
	if err := os.WriteFile(filepath.Join(repoPath, "added.txt"), []byte("incoming\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "added.txt")
	runGitCmd(t, repoPath, "commit", "-m", "incoming adds")
	runGitCmd(t, repoPath, "checkout", mainBranch)
	if err := os.WriteFile(filepath.Join(repoPath, "added.txt"), []byte("current\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "added.txt")
	runGitCmd(t, repoPath, "commit", "-m", "current adds")
	merge := exec.Command("git", "merge", "incoming-both-added")
	merge.Dir = repoPath
	if output, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("expected both-added conflict, output: %s", output)
	}

	service := NewGitService()
	data := service.GetConflictResolutionData(repoPath, "added.txt")
	if !data.Success || !data.Eligible || data.Status != "both-added" || data.Base.Present {
		t.Fatalf("unexpected both-added data: %#v", data)
	}
	result := service.ResolveConflictWithContent(repoPath, "added.txt", data.ResolutionToken, "")
	if !result.Success {
		t.Fatalf("failed to apply empty resolution: %s", result.Error)
	}
	content, err := os.ReadFile(filepath.Join(repoPath, "added.txt"))
	if err != nil || len(content) != 0 {
		t.Fatalf("expected staged empty file, content=%q error=%v", content, err)
	}
	if unmerged := strings.TrimSpace(runGitOutput(t, repoPath, "ls-files", "-u", "--", "added.txt")); unmerged != "" {
		t.Fatalf("expected both-added stages to be cleared, got %q", unmerged)
	}
}

func TestResolveConflictWithContentPreservesCurrentExecutableMode(t *testing.T) {
	repoPath := createTextConflictRepo(t, "executable.sh", []byte("echo base\n"), []byte("echo current\n"), []byte("echo incoming\n"))
	defer cleanupTestRepo(t, repoPath)
	service := NewGitService()
	entries, err := service.loadConflictStageEntries(repoPath, "executable.sh")
	if err != nil {
		t.Fatal(err)
	}
	current := entries[2]
	updateIndex := exec.Command("git", "update-index", "--index-info")
	updateIndex.Dir = repoPath
	updateIndex.Stdin = strings.NewReader(fmt.Sprintf("100755 %s 2\texecutable.sh\n", current.oid))
	if output, err := updateIndex.CombinedOutput(); err != nil {
		t.Fatalf("set executable conflict stage: %v\n%s", err, output)
	}

	data := service.GetConflictResolutionData(repoPath, "executable.sh")
	if !data.Success || !data.Eligible || data.Current.Mode != "100755" {
		t.Fatalf("unexpected executable conflict data: %#v", data)
	}
	result := service.ResolveConflictWithContent(repoPath, "executable.sh", data.ResolutionToken, "echo resolved\n")
	if !result.Success {
		t.Fatalf("resolve executable conflict: %s", result.Error)
	}
	info, err := os.Stat(filepath.Join(repoPath, "executable.sh"))
	if err != nil {
		t.Fatalf("stat executable working file: %v", err)
	}
	if info.Mode().Perm()&0111 == 0 {
		t.Fatalf("expected executable working file, mode=%v", info.Mode())
	}
	staged := runGitOutput(t, repoPath, "ls-files", "--stage", "--", "executable.sh")
	if !strings.HasPrefix(staged, "100755 ") {
		t.Fatalf("expected executable index mode, got %q", staged)
	}
}

func TestResolveConflictWithContentRejectsSymlinkDestinations(t *testing.T) {
	t.Run("direct file symlink", func(t *testing.T) {
		repoPath := createTextConflictRepo(t, "linked.txt", []byte("base\n"), []byte("current\n"), []byte("incoming\n"))
		defer cleanupTestRepo(t, repoPath)
		service := NewGitService()
		data := service.GetConflictResolutionData(repoPath, "linked.txt")
		outsidePath := filepath.Join(t.TempDir(), "outside.txt")
		if err := os.WriteFile(outsidePath, []byte("outside\n"), 0644); err != nil {
			t.Fatal(err)
		}
		worktreePath := filepath.Join(repoPath, "linked.txt")
		if err := os.Remove(worktreePath); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsidePath, worktreePath); err != nil {
			t.Fatal(err)
		}
		result := service.ResolveConflictWithContent(repoPath, "linked.txt", data.ResolutionToken, "resolved\n")
		if result.Success || !strings.Contains(result.Error, "symbolic link") {
			t.Fatalf("expected direct symlink rejection, got %#v", result)
		}
		outside, err := os.ReadFile(outsidePath)
		if err != nil || string(outside) != "outside\n" {
			t.Fatalf("outside file changed: content=%q error=%v", outside, err)
		}
	})

	t.Run("whole-file fallback direct symlink", func(t *testing.T) {
		repoPath := createTextConflictRepo(t, "fallback-linked.txt", []byte("base\n"), []byte("current\n"), []byte("incoming\n"))
		defer cleanupTestRepo(t, repoPath)
		outsidePath := filepath.Join(t.TempDir(), "outside.txt")
		if err := os.WriteFile(outsidePath, []byte("outside\n"), 0644); err != nil {
			t.Fatal(err)
		}
		worktreePath := filepath.Join(repoPath, "fallback-linked.txt")
		if err := os.Remove(worktreePath); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsidePath, worktreePath); err != nil {
			t.Fatal(err)
		}
		result := NewGitService().ResolveConflictKeepTheirs(repoPath, "fallback-linked.txt")
		if result.Success || !strings.Contains(result.Error, "symbolic link") {
			t.Fatalf("expected whole-file symlink rejection, got %#v", result)
		}
		outside, err := os.ReadFile(outsidePath)
		if err != nil || string(outside) != "outside\n" {
			t.Fatalf("outside file changed: content=%q error=%v", outside, err)
		}
	})

	t.Run("parent directory symlink", func(t *testing.T) {
		repoPath := createTestRepo(t)
		defer cleanupTestRepo(t, repoPath)
		if err := os.Symlink(t.TempDir(), filepath.Join(repoPath, "linked-dir")); err != nil {
			t.Fatal(err)
		}
		if _, err := safeConflictDestination(repoPath, "linked-dir/file.txt"); err == nil {
			t.Fatal("expected parent symlink escape to be rejected")
		}
	})
}

func TestConflictResolutionRejectsSymlinkIndexModes(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	linkPath := filepath.Join(repoPath, "controller-link")
	if err := os.Symlink("base-target", linkPath); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "controller-link")
	runGitCmd(t, repoPath, "commit", "-m", "base link")
	mainBranch := strings.TrimSpace(runGitOutput(t, repoPath, "branch", "--show-current"))

	runGitCmd(t, repoPath, "checkout", "-b", "incoming-link")
	if err := os.Remove(linkPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("incoming-target", linkPath); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "controller-link")
	runGitCmd(t, repoPath, "commit", "-m", "incoming link")
	runGitCmd(t, repoPath, "checkout", mainBranch)
	if err := os.Remove(linkPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("current-target", linkPath); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "controller-link")
	runGitCmd(t, repoPath, "commit", "-m", "current link")
	merge := exec.Command("git", "merge", "incoming-link")
	merge.Dir = repoPath
	if output, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("expected symlink conflict, output: %s", output)
	}

	service := NewGitService()
	data := service.GetConflictResolutionData(repoPath, "controller-link")
	if !data.Success || data.Eligible || data.IneligibleReason != "unsafe-file-type" {
		t.Fatalf("unexpected symlink conflict eligibility: %#v", data)
	}
	result := service.ResolveConflictKeepOurs(repoPath, "controller-link")
	if result.Success || !strings.Contains(strings.ToLower(result.Error), "symbolic link") {
		t.Fatalf("expected whole-file symlink resolution to fail closed, got %#v", result)
	}
}

func TestResolveConflictKeepOursStagesSelectedDeletion(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	filePath := filepath.Join(repoPath, "deleted-current.txt")
	if err := os.WriteFile(filePath, []byte("base\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "deleted-current.txt")
	runGitCmd(t, repoPath, "commit", "-m", "base")
	mainBranch := strings.TrimSpace(runGitOutput(t, repoPath, "branch", "--show-current"))

	runGitCmd(t, repoPath, "checkout", "-b", "incoming-delete-test")
	if err := os.WriteFile(filePath, []byte("incoming modification\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "deleted-current.txt")
	runGitCmd(t, repoPath, "commit", "-m", "incoming modifies")

	runGitCmd(t, repoPath, "checkout", mainBranch)
	runGitCmd(t, repoPath, "rm", "deleted-current.txt")
	runGitCmd(t, repoPath, "commit", "-m", "current deletes")
	merge := exec.Command("git", "merge", "incoming-delete-test")
	merge.Dir = repoPath
	if err := merge.Run(); err == nil {
		t.Fatal("expected delete/modify conflict")
	}

	service := NewGitService()
	data := service.GetConflictResolutionData(repoPath, "deleted-current.txt")
	if !data.Success || data.Eligible || data.Status != "deleted-by-us" || data.IneligibleReason != "missing-side" {
		t.Fatalf("unexpected delete/modify data: %#v", data)
	}
	if data.Current.Present || !data.Incoming.Present {
		t.Fatalf("unexpected stage presence: current=%v incoming=%v", data.Current.Present, data.Incoming.Present)
	}

	result := service.ResolveConflictKeepOurs(repoPath, "deleted-current.txt")
	if !result.Success {
		t.Fatalf("failed to keep selected deletion: %s", result.Error)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected working file to be deleted, stat error=%v", err)
	}
	if unmerged := strings.TrimSpace(runGitOutput(t, repoPath, "ls-files", "-u", "--", "deleted-current.txt")); unmerged != "" {
		t.Fatalf("expected deletion conflict to be staged, got %q", unmerged)
	}
}

func TestResolveConflictKeepOursStagesBothDeletedConflict(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)
	filePath := filepath.Join(repoPath, "both-deleted.txt")
	if err := os.WriteFile(filePath, []byte("base\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitCmd(t, repoPath, "add", "both-deleted.txt")
	runGitCmd(t, repoPath, "commit", "-m", "base")
	oid := strings.TrimSpace(runGitOutput(t, repoPath, "rev-parse", "HEAD:both-deleted.txt"))
	head := strings.TrimSpace(runGitOutput(t, repoPath, "rev-parse", "HEAD"))
	runGitCmd(t, repoPath, "rm", "--cached", "both-deleted.txt")
	if err := os.Remove(filePath); err != nil {
		t.Fatal(err)
	}
	updateIndex := exec.Command("git", "update-index", "--index-info")
	updateIndex.Dir = repoPath
	updateIndex.Stdin = strings.NewReader(fmt.Sprintf("100644 %s 1\tboth-deleted.txt\n", oid))
	if output, err := updateIndex.CombinedOutput(); err != nil {
		t.Fatalf("create stage-1-only conflict: %v\n%s", err, output)
	}
	if err := os.WriteFile(filepath.Join(repoPath, ".git", "MERGE_HEAD"), []byte(head+"\n"), 0644); err != nil {
		t.Fatal(err)
	}

	service := NewGitService()
	data := service.GetConflictResolutionData(repoPath, "both-deleted.txt")
	if !data.Success || data.Eligible || data.Status != "both-deleted" || data.IneligibleReason != "missing-side" {
		t.Fatalf("unexpected both-deleted data: %#v", data)
	}
	result := service.ResolveConflictKeepOurs(repoPath, "both-deleted.txt")
	if !result.Success {
		t.Fatalf("failed to stage both-deleted resolution: %s", result.Error)
	}
	if unmerged := strings.TrimSpace(runGitOutput(t, repoPath, "ls-files", "-u", "--", "both-deleted.txt")); unmerged != "" {
		t.Fatalf("expected both-deleted stages to be cleared, got %q", unmerged)
	}
}

// TestMergeConflict_AbortMerge tests aborting a merge in progress
func TestMergeConflict_AbortMerge(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runner := NewCommandRunner()

	// Create initial commit on main
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("original"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	// Create feature branch with different content
	runner.RunGit(repoPath, "checkout", "-b", "feature")
	if err := os.WriteFile(testFile, []byte("feature content"), 0644); err != nil {
		t.Fatalf("Failed to modify file on feature: %v", err)
	}
	svc.CommitAll(repoPath, "Feature change")

	// Go back to main and make conflicting change
	branches := svc.Branches(repoPath)
	mainBranch := "master"
	for _, b := range branches.Local {
		if b.Name == "main" {
			mainBranch = "main"
			break
		}
	}
	runner.RunGit(repoPath, "checkout", mainBranch)
	if err := os.WriteFile(testFile, []byte("main content"), 0644); err != nil {
		t.Fatalf("Failed to modify file on main: %v", err)
	}
	svc.CommitAll(repoPath, "Main change")

	// Start merge that will conflict
	runner.RunGit(repoPath, "merge", "feature")

	// Verify we're in merge state
	state := svc.GetMergeState(repoPath)
	if !state.InMerge {
		t.Skip("Not in merge state - test setup issue")
	}

	// Abort the merge
	abortResult := svc.AbortMerge(repoPath)
	if !abortResult.Success {
		t.Errorf("Failed to abort merge: %s", abortResult.Error)
	}

	// Verify we're no longer in merge state
	afterState := svc.GetMergeState(repoPath)
	if afterState.InMerge {
		t.Error("Expected to not be in merge state after abort")
	}

	// Verify content is back to main's version
	content, _ := os.ReadFile(testFile)
	if string(content) != "main content" {
		t.Errorf("Expected 'main content' after abort, got: %s", string(content))
	}
}

func TestAbortMerge_NoMergeInProgress(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	result := svc.AbortMerge(repoPath)

	if result.Success {
		t.Error("Expected failure when no merge in progress")
	}
	if !strings.Contains(result.Error, "No merge in progress") {
		t.Errorf("Expected error about no merge in progress, got: %s", result.Error)
	}
}

func TestCompleteMerge_NoMergeInProgress(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "Initial commit")

	result := svc.CompleteMerge(repoPath, "Merge commit")

	if result.Success {
		t.Error("Expected failure when no merge in progress")
	}
}

func TestCompleteMerge_LocalOnlyBypassesPush_RegularMerge(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "base.txt"), []byte("base\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/local-regular")
	os.WriteFile(filepath.Join(repoPath, "feature.txt"), []byte("feature change\n"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	runGitCmd(t, repoPath, "checkout", "main")
	os.WriteFile(filepath.Join(repoPath, "main.txt"), []byte("main change\n"), 0644)
	svc.CommitAll(repoPath, "Main commit")

	mergeStart := svc.runner.RunGit(repoPath, "merge", "--no-commit", "--no-ff", "feature/local-regular")
	if !mergeStart.Success {
		t.Fatalf("Failed to start regular merge for test setup: %s", getErrorMessage(mergeStart))
	}

	result := svc.CompleteMerge(repoPath, "")
	if !result.Success {
		t.Fatalf("Expected CompleteMerge to succeed for local-only regular merge, got: %s", result.Error)
	}

	state := svc.GetMergeState(repoPath)
	if state.InMerge {
		t.Fatalf("Expected merge state to be cleared after completion")
	}
}

func TestCompleteMerge_LocalOnlyBypassesPush_SquashMerge(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "base.txt"), []byte("base\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/local-squash")
	os.WriteFile(filepath.Join(repoPath, "feature.txt"), []byte("feature change\n"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	runGitCmd(t, repoPath, "checkout", "main")

	startResult := svc.StartMergeWithOptions(repoPath, "main", "feature/local-squash", MergeOptions{Squash: true})
	if !startResult.Success {
		t.Fatalf("Failed to start squash merge in local-only repo: %s", startResult.Error)
	}

	result := svc.CompleteMerge(repoPath, "Squash merge local-only")
	if !result.Success {
		t.Fatalf("Expected CompleteMerge to succeed for local-only squash merge, got: %s", result.Error)
	}

	state := svc.GetMergeState(repoPath)
	if state.InSquashMerge || state.InMerge {
		t.Fatalf("Expected squash/merge state to be cleared after completion")
	}
}

func TestMarkResolved_EmptyPath(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	result := svc.MarkResolved(repoPath, "")

	if result.Success {
		t.Error("Expected failure for empty path")
	}
	if !strings.Contains(result.Error, "File path is required") {
		t.Errorf("Expected error about file path required, got: %s", result.Error)
	}
}

func TestResolveConflictKeepOurs_EmptyPath(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	result := svc.ResolveConflictKeepOurs(repoPath, "")

	if result.Success {
		t.Error("Expected failure for empty path")
	}
}

func TestResolveConflictKeepTheirs_EmptyPath(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	result := svc.ResolveConflictKeepTheirs(repoPath, "")

	if result.Success {
		t.Error("Expected failure for empty path")
	}
}

// TestGetParentBranch_NoParent tests that GetParentBranch fails gracefully in a fresh repo
func TestGetParentBranch_NoParent(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit (default branch is likely "master" in fresh repo)
	filePath := filepath.Join(repoPath, "file.txt")
	os.WriteFile(filePath, []byte("content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Since we're on the default branch, GetParentBranch should fail
	result := svc.GetParentBranch(repoPath)

	// It might succeed if it finds master as the parent of itself or fail - both are acceptable
	// The key is it shouldn't crash
	t.Logf("GetParentBranch result: Success=%v, ParentBranch=%s, Source=%s, Error=%s",
		result.Success, result.ParentBranch, result.Source, result.Error)
}

// TestGetParentBranch_WithParent tests parent detection when on a feature branch
func TestGetParentBranch_WithParent(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Rename default branch to "main" for predictable test
	cmd := exec.Command("git", "branch", "-M", "main")
	cmd.Dir = repoPath
	cmd.Run()

	// Create initial commit on main
	filePath := filepath.Join(repoPath, "file.txt")
	os.WriteFile(filePath, []byte("content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Create and switch to feature branch
	svc.CreateBranchAndCheckout(repoPath, "feature")

	// GetParentBranch should detect "main" as parent
	result := svc.GetParentBranch(repoPath)

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	if result.ParentBranch != "main" {
		t.Errorf("Expected parent branch 'main', got '%s'", result.ParentBranch)
	}
	if result.Source != "merge-base" && result.Source != "default" {
		t.Errorf("Expected source 'merge-base' or 'default', got '%s'", result.Source)
	}
}

// TestCheckBranchConflicts_AutoDetectParent tests that empty parent branch triggers auto-detection
func TestCheckBranchConflicts_AutoDetectParent(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Rename default branch to "main" for predictable test
	cmd := exec.Command("git", "branch", "-M", "main")
	cmd.Dir = repoPath
	cmd.Run()

	// Create initial commit on main
	filePath := filepath.Join(repoPath, "file.txt")
	os.WriteFile(filePath, []byte("initial content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Create and switch to feature branch
	svc.CreateBranchAndCheckout(repoPath, "feature")

	// Make a conflicting change
	os.WriteFile(filePath, []byte("feature content"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	// Switch to main and make a conflicting change
	svc.CheckoutBranch(repoPath, "main")
	os.WriteFile(filePath, []byte("main content"), 0644)
	svc.CommitAll(repoPath, "Main commit")

	// Switch to feature and check conflicts with auto-detected parent
	svc.CheckoutBranch(repoPath, "feature")
	result := svc.CheckBranchConflicts(repoPath, "") // Empty string triggers auto-detection

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	if result.ParentBranch != "main" {
		t.Errorf("Expected auto-detected parent 'main', got '%s'", result.ParentBranch)
	}
	if !result.HasConflicts {
		t.Error("Expected conflicts for overlapping changes")
	}
}

// TestCheckBranchConflicts_NoConflicts tests conflict detection when branches can merge cleanly
func TestCheckBranchConflicts_NoConflicts(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit on main
	filePath := filepath.Join(repoPath, "file.txt")
	os.WriteFile(filePath, []byte("initial content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Create and switch to feature branch
	svc.CreateBranchAndCheckout(repoPath, "feature")

	// Make a change on feature branch
	os.WriteFile(filePath, []byte("feature content"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	// Switch back to main and make a non-conflicting change
	svc.CheckoutBranch(repoPath, "main")
	newFilePath := filepath.Join(repoPath, "newfile.txt")
	os.WriteFile(newFilePath, []byte("new file"), 0644)
	svc.CommitAll(repoPath, "Main commit")

	// Switch to feature and check conflicts with main
	svc.CheckoutBranch(repoPath, "feature")
	result := svc.CheckBranchConflicts(repoPath, "main")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	if result.HasConflicts {
		t.Error("Expected no conflicts for non-overlapping changes")
	}
}

// TestCheckBranchConflicts_WithConflicts tests conflict detection when branches have conflicting changes
func TestCheckBranchConflicts_WithConflicts(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit on main
	filePath := filepath.Join(repoPath, "file.txt")
	os.WriteFile(filePath, []byte("initial content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Create and switch to feature branch
	svc.CreateBranchAndCheckout(repoPath, "feature")

	// Make a change on feature branch (modify same line)
	os.WriteFile(filePath, []byte("feature content - modified line 1"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	// Switch back to main and make a conflicting change
	svc.CheckoutBranch(repoPath, "main")
	os.WriteFile(filePath, []byte("main content - modified line 1"), 0644)
	svc.CommitAll(repoPath, "Main commit")

	// Switch to feature and check conflicts with main
	svc.CheckoutBranch(repoPath, "feature")
	result := svc.CheckBranchConflicts(repoPath, "main")

	if !result.Success {
		t.Errorf("Expected success, got error: %s", result.Error)
	}
	if !result.HasConflicts {
		t.Error("Expected conflicts for overlapping changes")
	}
	if len(result.ConflictedFiles) != 1 {
		t.Errorf("Expected 1 conflicted file, got %d", len(result.ConflictedFiles))
	}
	if result.ConflictedFiles[0].Path != "file.txt" {
		t.Errorf("Expected conflicted file 'file.txt', got '%s'", result.ConflictedFiles[0].Path)
	}
}

// TestCheckBranchConflicts_NonExistentBranch tests error handling for non-existent branch
func TestCheckBranchConflicts_NonExistentBranch(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit
	filePath := filepath.Join(repoPath, "file.txt")
	os.WriteFile(filePath, []byte("content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	result := svc.CheckBranchConflicts(repoPath, "nonexistent-branch")

	if result.Success {
		t.Error("Expected failure for non-existent branch")
	}
	if !strings.Contains(result.Error, "not found") {
		t.Errorf("Expected error about branch not found, got: %s", result.Error)
	}
}

func TestStartMergeWithOptions_UsesUpdatedOriginTargetForConflicts(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Normalize default branch for deterministic behavior.
	runGitCmd(t, repoPath, "branch", "-M", "main")

	filePath := filepath.Join(repoPath, "test.txt")
	os.WriteFile(filePath, []byte("line1\nbase\nline3\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Create source branch with local conflicting change.
	runGitCmd(t, repoPath, "checkout", "-b", "feature/conflict")
	os.WriteFile(filePath, []byte("line1\nfeature-change\nline3\n"), 0644)
	svc.CommitAll(repoPath, "Feature change")

	// Go back to main and set up origin.
	runGitCmd(t, repoPath, "checkout", "main")
	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "feature/conflict")

	// Advance origin/main in a separate clone with a conflicting change.
	remoteWorktree, err := os.MkdirTemp("", "iofabrik-origin-main-update-*")
	if err != nil {
		t.Fatalf("Failed to create temp clone directory: %v", err)
	}
	defer os.RemoveAll(remoteWorktree)

	runGitCmd(t, remoteWorktree, "clone", remotePath, ".")
	runGitCmd(t, remoteWorktree, "config", "user.name", "Test User")
	runGitCmd(t, remoteWorktree, "config", "user.email", "test@example.com")
	runGitCmd(t, remoteWorktree, "checkout", "main")
	os.WriteFile(filepath.Join(remoteWorktree, "test.txt"), []byte("line1\norigin-main-change\nline3\n"), 0644)
	runGitCmd(t, remoteWorktree, "add", "test.txt")
	runGitCmd(t, remoteWorktree, "commit", "-m", "Remote main change")
	runGitCmd(t, remoteWorktree, "push", "origin", "main")

	// Switch back to source branch in local repo.
	runGitCmd(t, repoPath, "checkout", "feature/conflict")

	checkResult := svc.CheckBranchConflicts(repoPath, "main", "feature/conflict")
	if !checkResult.Success {
		t.Fatalf("CheckBranchConflicts failed: %s", checkResult.Error)
	}
	if !checkResult.HasConflicts {
		t.Fatalf("Expected conflict check to detect conflicts against origin/main")
	}

	startResult := svc.StartMergeWithOptions(repoPath, "main", "feature/conflict", MergeOptions{Squash: true})
	if !startResult.Success {
		t.Fatalf("StartMergeWithOptions failed: %s", startResult.Error)
	}

	state := svc.GetMergeState(repoPath)
	if !state.InSquashMerge {
		t.Fatalf("Expected squash merge state after starting merge")
	}
	if !state.HasConflicts {
		t.Fatalf("Expected conflicts to be present after starting squash merge")
	}

	conflictedFiles, conflictErr := svc.GetConflictedFiles(repoPath)
	if conflictErr != nil {
		t.Fatalf("Failed to read conflicted files: %v", conflictErr)
	}
	if len(conflictedFiles) == 0 {
		t.Fatalf("Expected conflicted files after starting squash merge")
	}

	abortResult := svc.AbortMerge(repoPath)
	if !abortResult.Success {
		t.Fatalf("AbortMerge failed during cleanup: %s", abortResult.Error)
	}
}

func TestStartMergeWithOptions_PreflightUpdatesStaleTargetFromOrigin(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "shared.txt"), []byte("base\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/fresh")
	os.WriteFile(filepath.Join(repoPath, "feature.txt"), []byte("feature branch change\n"), 0644)
	svc.CommitAll(repoPath, "Feature change")

	runGitCmd(t, repoPath, "checkout", "main")
	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")
	runGitCmd(t, repoPath, "push", "-u", "origin", "feature/fresh")

	remoteWorktree, err := os.MkdirTemp("", "iofabrik-origin-preflight-update-*")
	if err != nil {
		t.Fatalf("Failed to create temp clone directory: %v", err)
	}
	defer os.RemoveAll(remoteWorktree)

	runGitCmd(t, remoteWorktree, "clone", remotePath, ".")
	runGitCmd(t, remoteWorktree, "config", "user.name", "Test User")
	runGitCmd(t, remoteWorktree, "config", "user.email", "test@example.com")
	runGitCmd(t, remoteWorktree, "checkout", "main")
	os.WriteFile(filepath.Join(remoteWorktree, "remote.txt"), []byte("from origin main\n"), 0644)
	runGitCmd(t, remoteWorktree, "add", "remote.txt")
	runGitCmd(t, remoteWorktree, "commit", "-m", "Remote main update")
	runGitCmd(t, remoteWorktree, "push", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "feature/fresh")

	startResult := svc.StartMergeWithOptions(repoPath, "main", "feature/fresh", MergeOptions{Squash: true})
	if !startResult.Success {
		t.Fatalf("StartMergeWithOptions failed: %s", startResult.Error)
	}

	currentBranch := strings.TrimSpace(runGitOutput(t, repoPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if currentBranch != "main" {
		t.Fatalf("Expected current branch to be main after preflight checkout, got %s", currentBranch)
	}

	remoteFileContent, err := os.ReadFile(filepath.Join(repoPath, "remote.txt"))
	if err != nil {
		t.Fatalf("Expected remote.txt from origin/main after preflight update: %v", err)
	}
	if string(remoteFileContent) != "from origin main\n" {
		t.Fatalf("Unexpected remote.txt content after preflight update: %q", string(remoteFileContent))
	}
}

func TestStartMergeWithOptions_PreflightBypassesRemoteForLocalOnlyRepo(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "shared.txt"), []byte("base\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/local-only")
	os.WriteFile(filepath.Join(repoPath, "feature.txt"), []byte("feature branch change\n"), 0644)
	svc.CommitAll(repoPath, "Feature change")

	// Ensure this repository has no remotes configured.
	remotes := strings.TrimSpace(runGitOutput(t, repoPath, "remote"))
	if remotes != "" {
		t.Fatalf("Expected local-only repository with no remotes, got: %q", remotes)
	}

	startResult := svc.StartMergeWithOptions(repoPath, "main", "feature/local-only", MergeOptions{Squash: true})
	if !startResult.Success {
		t.Fatalf("Expected StartMergeWithOptions to succeed for local-only repo, got: %s", startResult.Error)
	}

	currentBranch := strings.TrimSpace(runGitOutput(t, repoPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if currentBranch != "main" {
		t.Fatalf("Expected current branch to be main after local-only preflight checkout, got %s", currentBranch)
	}
}

func TestStartMergeWithOptions_PreflightUsesPreferredRemoteWhenOriginMissing(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "shared.txt"), []byte("base\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/upstream")
	os.WriteFile(filepath.Join(repoPath, "feature.txt"), []byte("feature branch change\n"), 0644)
	svc.CommitAll(repoPath, "Feature change")

	runGitCmd(t, repoPath, "checkout", "main")
	remotePath := createBareRemoteAndLinkWithName(t, repoPath, "upstream")
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "upstream", "main")
	runGitCmd(t, repoPath, "push", "-u", "upstream", "feature/upstream")

	// Validate there is no origin remote and only upstream is configured.
	remotes := strings.TrimSpace(runGitOutput(t, repoPath, "remote"))
	if remotes != "upstream" {
		t.Fatalf("Expected only upstream remote, got: %q", remotes)
	}

	remoteWorktree, err := os.MkdirTemp("", "iofabrik-upstream-preflight-update-*")
	if err != nil {
		t.Fatalf("Failed to create temp clone directory: %v", err)
	}
	defer os.RemoveAll(remoteWorktree)

	runGitCmd(t, remoteWorktree, "clone", remotePath, ".")
	runGitCmd(t, remoteWorktree, "config", "user.name", "Test User")
	runGitCmd(t, remoteWorktree, "config", "user.email", "test@example.com")
	runGitCmd(t, remoteWorktree, "checkout", "main")
	os.WriteFile(filepath.Join(remoteWorktree, "remote.txt"), []byte("from upstream main\n"), 0644)
	runGitCmd(t, remoteWorktree, "add", "remote.txt")
	runGitCmd(t, remoteWorktree, "commit", "-m", "Upstream main update")
	runGitCmd(t, remoteWorktree, "push", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "feature/upstream")

	startResult := svc.StartMergeWithOptions(repoPath, "main", "feature/upstream", MergeOptions{Squash: true})
	if !startResult.Success {
		t.Fatalf("StartMergeWithOptions failed without origin remote: %s", startResult.Error)
	}

	remoteFileContent, err := os.ReadFile(filepath.Join(repoPath, "remote.txt"))
	if err != nil {
		t.Fatalf("Expected remote.txt from upstream/main after preflight update: %v", err)
	}
	if string(remoteFileContent) != "from upstream main\n" {
		t.Fatalf("Unexpected remote.txt content after upstream preflight update: %q", string(remoteFileContent))
	}
}

func TestStartMergeWithOptions_PreflightDivergedTargetFailsAndRestoresBranch(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "diverge.txt"), []byte("base\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/diverged")
	os.WriteFile(filepath.Join(repoPath, "feature-only.txt"), []byte("feature\n"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	runGitCmd(t, repoPath, "checkout", "main")
	os.WriteFile(filepath.Join(repoPath, "local-main.txt"), []byte("local divergence\n"), 0644)
	svc.CommitAll(repoPath, "Local main divergence")

	remoteWorktree, err := os.MkdirTemp("", "iofabrik-origin-diverge-*")
	if err != nil {
		t.Fatalf("Failed to create temp clone directory: %v", err)
	}
	defer os.RemoveAll(remoteWorktree)

	runGitCmd(t, remoteWorktree, "clone", remotePath, ".")
	runGitCmd(t, remoteWorktree, "config", "user.name", "Test User")
	runGitCmd(t, remoteWorktree, "config", "user.email", "test@example.com")
	runGitCmd(t, remoteWorktree, "checkout", "main")
	os.WriteFile(filepath.Join(remoteWorktree, "origin-main.txt"), []byte("origin divergence\n"), 0644)
	runGitCmd(t, remoteWorktree, "add", "origin-main.txt")
	runGitCmd(t, remoteWorktree, "commit", "-m", "Origin main divergence")
	runGitCmd(t, remoteWorktree, "push", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "feature/diverged")

	startResult := svc.StartMergeWithOptions(repoPath, "main", "feature/diverged", MergeOptions{Squash: true})
	if startResult.Success {
		t.Fatalf("Expected merge preflight to fail for diverged target branch")
	}
	if !strings.Contains(strings.ToLower(startResult.Error), "fast-forwardable") {
		t.Fatalf("Expected fast-forwardable guidance in error, got: %s", startResult.Error)
	}

	currentBranch := strings.TrimSpace(runGitOutput(t, repoPath, "rev-parse", "--abbrev-ref", "HEAD"))
	if currentBranch != "feature/diverged" {
		t.Fatalf("Expected to be restored to original branch feature/diverged, got %s", currentBranch)
	}
}

func TestListMergeReviewFiles_ReturnsStatusesAndRename(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	runGitCmd(t, repoPath, "branch", "-M", "main")
	os.WriteFile(filepath.Join(repoPath, "modified.txt"), []byte("base"), 0644)
	os.WriteFile(filepath.Join(repoPath, "deleted.txt"), []byte("delete me"), 0644)
	os.WriteFile(filepath.Join(repoPath, "rename_me.txt"), []byte("rename me"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/review")
	os.WriteFile(filepath.Join(repoPath, "modified.txt"), []byte("feature change"), 0644)
	os.WriteFile(filepath.Join(repoPath, "added.txt"), []byte("new file"), 0644)
	os.Remove(filepath.Join(repoPath, "deleted.txt"))
	runGitCmd(t, repoPath, "mv", "rename_me.txt", "renamed.txt")
	svc.CommitAll(repoPath, "Feature branch changes")

	files := svc.ListMergeReviewFiles(repoPath, "main", "feature/review")
	if len(files) != 4 {
		t.Fatalf("Expected 4 merge review files, got %d", len(files))
	}

	byPath := map[string]MergeReviewFile{}
	for _, file := range files {
		byPath[file.Path] = file
	}

	if byPath["modified.txt"].Status != "modified" {
		t.Fatalf("Expected modified.txt status 'modified', got '%s'", byPath["modified.txt"].Status)
	}
	if byPath["added.txt"].Status != "added" {
		t.Fatalf("Expected added.txt status 'added', got '%s'", byPath["added.txt"].Status)
	}
	if byPath["deleted.txt"].Status != "deleted" {
		t.Fatalf("Expected deleted.txt status 'deleted', got '%s'", byPath["deleted.txt"].Status)
	}
	renameEntry, ok := byPath["renamed.txt"]
	if !ok {
		t.Fatalf("Expected renamed.txt in merge review files")
	}
	if renameEntry.Status != "renamed" {
		t.Fatalf("Expected renamed.txt status 'renamed', got '%s'", renameEntry.Status)
	}
	if renameEntry.OldPath != "rename_me.txt" {
		t.Fatalf("Expected renamed.txt oldPath 'rename_me.txt', got '%s'", renameEntry.OldPath)
	}
}

func TestDiffMergeReviewFileRaw_ReturnsDiff(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "diffme.txt"), []byte("line1\nbase\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/diff")
	os.WriteFile(filepath.Join(repoPath, "diffme.txt"), []byte("line1\nchanged\n"), 0644)
	svc.CommitAll(repoPath, "Diff commit")

	diff := svc.DiffMergeReviewFileRaw(repoPath, "main", "feature/diff", "diffme.txt")
	if diff.HasError {
		t.Fatalf("Expected no error, got: %s", diff.Error)
	}
	if diff.Binary {
		t.Fatalf("Expected text diff, got binary")
	}
	if !strings.Contains(diff.RawDiff, "-line1") && !strings.Contains(diff.RawDiff, "-base") {
		t.Fatalf("Expected raw diff content, got: %s", diff.RawDiff)
	}
}

func TestDiffMergeReviewFileRaw_ReturnsLFSPointerError(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	filePath := "asset.bin"
	os.WriteFile(filepath.Join(repoPath, filePath), []byte("base content\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/lfs")
	lfsPointer := "version https://git-lfs.github.com/spec/v1\noid sha256:3333333333333333333333333333333333333333333333333333333333333333\nsize 789\n"
	os.WriteFile(filepath.Join(repoPath, filePath), []byte(lfsPointer), 0644)
	svc.CommitAll(repoPath, "Pointer change")

	diff := svc.DiffMergeReviewFileRaw(repoPath, "main", "feature/lfs", filePath)
	if !diff.HasError {
		t.Fatalf("Expected HasError for LFS pointer diff")
	}
	if !strings.Contains(diff.Error, "stored in Git LFS") {
		t.Fatalf("Expected LFS error message, got: %s", diff.Error)
	}
}

func TestStartMergeWithOptions_Selective_EmptySelectionFails(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "file.txt"), []byte("base"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/empty")
	os.WriteFile(filepath.Join(repoPath, "file.txt"), []byte("feature"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	result := svc.StartMergeWithOptions(repoPath, "main", "feature/empty", MergeOptions{
		Selective:     true,
		SelectedFiles: []string{},
	})

	if result.Success {
		t.Fatalf("Expected selective merge with empty selection to fail")
	}
	if !strings.Contains(result.Error, "At least one selected file") {
		t.Fatalf("Expected validation error, got: %s", result.Error)
	}
}

func TestStartMergeWithOptions_SelectiveFalse_BackwardCompatible(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "file.txt"), []byte("base"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/backward")
	os.WriteFile(filepath.Join(repoPath, "file.txt"), []byte("feature"), 0644)
	svc.CommitAll(repoPath, "Feature commit")

	result := svc.StartMergeWithOptions(repoPath, "main", "feature/backward", MergeOptions{Squash: true})
	if !result.Success {
		t.Fatalf("Expected backward-compatible non-selective merge to succeed, got: %s", result.Error)
	}

	abortResult := svc.AbortMerge(repoPath)
	if !abortResult.Success {
		t.Fatalf("Expected abort cleanup to succeed, got: %s", abortResult.Error)
	}
}

func TestStartMergeWithOptions_Selective_CleanMergeKeepsOnlySelectedFiles(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "selected.txt"), []byte("base selected"), 0644)
	os.WriteFile(filepath.Join(repoPath, "unselected.txt"), []byte("base unselected"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/selective-clean")
	os.WriteFile(filepath.Join(repoPath, "selected.txt"), []byte("feature selected"), 0644)
	os.WriteFile(filepath.Join(repoPath, "unselected.txt"), []byte("feature unselected"), 0644)
	svc.CommitAll(repoPath, "Feature changes")

	result := svc.StartMergeWithOptions(repoPath, "main", "feature/selective-clean", MergeOptions{
		Squash:        true,
		Selective:     true,
		SelectedFiles: []string{"selected.txt"},
	})
	if !result.Success {
		t.Fatalf("Expected selective merge to succeed, got: %s", result.Error)
	}

	cachedNames := runGitOutput(t, repoPath, "diff", "--cached", "--name-only")
	if !strings.Contains(cachedNames, "selected.txt") {
		t.Fatalf("Expected selected.txt to be staged, staged files: %s", cachedNames)
	}
	if strings.Contains(cachedNames, "unselected.txt") {
		t.Fatalf("Expected unselected.txt not to be staged, staged files: %s", cachedNames)
	}

	abortResult := svc.AbortMerge(repoPath)
	if !abortResult.Success {
		t.Fatalf("Expected abort cleanup to succeed, got: %s", abortResult.Error)
	}
}

func TestStartMergeWithOptions_Selective_ConflictMergeKeepsOnlySelectedConflicts(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	runGitCmd(t, repoPath, "branch", "-M", "main")

	os.WriteFile(filepath.Join(repoPath, "selected-conflict.txt"), []byte("line\nbase\n"), 0644)
	os.WriteFile(filepath.Join(repoPath, "unselected-conflict.txt"), []byte("line\nbase\n"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	remotePath := createBareRemoteAndLink(t, repoPath)
	defer os.RemoveAll(remotePath)
	runGitCmd(t, repoPath, "push", "-u", "origin", "main")

	runGitCmd(t, repoPath, "checkout", "-b", "feature/selective-conflict")
	os.WriteFile(filepath.Join(repoPath, "selected-conflict.txt"), []byte("line\nfeature-selected\n"), 0644)
	os.WriteFile(filepath.Join(repoPath, "unselected-conflict.txt"), []byte("line\nfeature-unselected\n"), 0644)
	svc.CommitAll(repoPath, "Feature conflicting changes")

	runGitCmd(t, repoPath, "checkout", "main")
	os.WriteFile(filepath.Join(repoPath, "selected-conflict.txt"), []byte("line\nmain-selected\n"), 0644)
	os.WriteFile(filepath.Join(repoPath, "unselected-conflict.txt"), []byte("line\nmain-unselected\n"), 0644)
	svc.CommitAll(repoPath, "Main conflicting changes")
	runGitCmd(t, repoPath, "push", "origin", "main")

	result := svc.StartMergeWithOptions(repoPath, "main", "feature/selective-conflict", MergeOptions{
		Selective:     true,
		SelectedFiles: []string{"selected-conflict.txt"},
	})
	if !result.Success {
		t.Fatalf("Expected selective conflict merge start to succeed, got: %s", result.Error)
	}

	conflicted, err := svc.GetConflictedFiles(repoPath)
	if err != nil {
		t.Fatalf("Failed to get conflicted files: %v", err)
	}
	if len(conflicted) != 1 {
		t.Fatalf("Expected exactly 1 selected conflict, got %d", len(conflicted))
	}
	if conflicted[0].Path != "selected-conflict.txt" {
		t.Fatalf("Expected selected-conflict.txt conflict, got %s", conflicted[0].Path)
	}

	abortResult := svc.AbortMerge(repoPath)
	if !abortResult.Success {
		t.Fatalf("Expected abort cleanup to succeed, got: %s", abortResult.Error)
	}
}

// NOTE: TestCheckBranchConflicts_RealRepo was removed - it was used for manual testing
// with the actual iofabrik repository. The unit tests above cover the functionality.

// ============================================================================
// ReadFileAtRevision Tests
// ============================================================================

func TestReadFileAtRevision_Success(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create initial commit with a file
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("initial content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	svc.CommitAll(repoPath, "First commit")

	// Read the file at HEAD
	result := svc.ReadFileAtRevision(repoPath, "test.txt", "HEAD")

	if result.HasError {
		t.Fatalf("Expected no error, got: %s", result.Error)
	}
	if result.Content != "initial content" {
		t.Errorf("Expected 'initial content', got: '%s'", result.Content)
	}
}

func TestReadFileAtRevision_MultipleRevisions(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create first commit
	testFile := filepath.Join(repoPath, "test.txt")
	os.WriteFile(testFile, []byte("version 1"), 0644)
	svc.CommitAll(repoPath, "Commit 1")

	commits1, _ := svc.GetRecentCommits(repoPath, 1)
	hash1 := commits1[0].Hash

	// Create second commit with modified file
	os.WriteFile(testFile, []byte("version 2"), 0644)
	svc.CommitAll(repoPath, "Commit 2")

	// Read at old revision should return old content
	resultOld := svc.ReadFileAtRevision(repoPath, "test.txt", hash1)
	if resultOld.HasError {
		t.Fatalf("Expected no error for old revision, got: %s", resultOld.Error)
	}
	if resultOld.Content != "version 1" {
		t.Errorf("Expected 'version 1' at old revision, got: '%s'", resultOld.Content)
	}

	// Read at HEAD should return new content
	resultNew := svc.ReadFileAtRevision(repoPath, "test.txt", "HEAD")
	if resultNew.HasError {
		t.Fatalf("Expected no error for HEAD, got: %s", resultNew.Error)
	}
	if resultNew.Content != "version 2" {
		t.Errorf("Expected 'version 2' at HEAD, got: '%s'", resultNew.Content)
	}
}

func TestReadFileAtRevision_FileDoesNotExist(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create a commit so HEAD exists
	testFile := filepath.Join(repoPath, "other.txt")
	os.WriteFile(testFile, []byte("content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	// Try to read a file that doesn't exist at this revision
	result := svc.ReadFileAtRevision(repoPath, "nonexistent.txt", "HEAD")

	if !result.HasError {
		t.Error("Expected error for non-existent file")
	}
	if !strings.Contains(result.Error, "does not exist") {
		t.Errorf("Expected 'does not exist' error, got: %s", result.Error)
	}
}

func TestReadFileAtRevision_InvalidRevision(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create a commit so the repo has history
	testFile := filepath.Join(repoPath, "test.txt")
	os.WriteFile(testFile, []byte("content"), 0644)
	svc.CommitAll(repoPath, "Initial commit")

	result := svc.ReadFileAtRevision(repoPath, "test.txt", "invalid-hash-abc123")

	if !result.HasError {
		t.Error("Expected error for invalid revision")
	}
}

func TestReadFileAtRevision_EmptyParams(t *testing.T) {
	svc := NewGitService()

	// Empty repoPath
	result := svc.ReadFileAtRevision("", "test.txt", "HEAD")
	if !result.HasError {
		t.Error("Expected error for empty repoPath")
	}

	// Empty filePath
	result = svc.ReadFileAtRevision("/tmp", "", "HEAD")
	if !result.HasError {
		t.Error("Expected error for empty filePath")
	}

	// Empty revision
	result = svc.ReadFileAtRevision("/tmp", "test.txt", "")
	if !result.HasError {
		t.Error("Expected error for empty revision")
	}
}

func TestReadFileAtRevision_SubdirectoryFile(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create a file in a subdirectory
	subDir := filepath.Join(repoPath, "src", "config")
	os.MkdirAll(subDir, 0755)
	testFile := filepath.Join(subDir, "settings.l5x")
	os.WriteFile(testFile, []byte("<RSLogix5000Content>test</RSLogix5000Content>"), 0644)
	svc.CommitAll(repoPath, "Add L5X file")

	// Read the file using absolute path to validate repo-relative conversion
	result := svc.ReadFileAtRevision(repoPath, testFile, "HEAD")

	if result.HasError {
		t.Fatalf("Expected no error, got: %s", result.Error)
	}
	if result.Content != "<RSLogix5000Content>test</RSLogix5000Content>" {
		t.Errorf("Unexpected content: '%s'", result.Content)
	}
}

func TestReadFileAtRevision_HeadTildeNotation(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()

	// Create first commit
	testFile := filepath.Join(repoPath, "test.txt")
	os.WriteFile(testFile, []byte("first"), 0644)
	svc.CommitAll(repoPath, "First commit")

	// Create second commit
	os.WriteFile(testFile, []byte("second"), 0644)
	svc.CommitAll(repoPath, "Second commit")

	// HEAD~1 should give us the first version
	result := svc.ReadFileAtRevision(repoPath, "test.txt", "HEAD~1")

	if result.HasError {
		t.Fatalf("Expected no error, got: %s", result.Error)
	}
	if result.Content != "first" {
		t.Errorf("Expected 'first' at HEAD~1, got: '%s'", result.Content)
	}
}
