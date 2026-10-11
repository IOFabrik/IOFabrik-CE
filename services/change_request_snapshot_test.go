package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================================
// Fixtures
// ============================================================================

type changeRequestFixture struct {
	OriginPath      string
	AuthorPath      string
	ConsumerPath    string
	HeadOID         string
	MergeBaseOID    string
	AdvancedMainOID string
}

func configureChangeRequestIdentity(t *testing.T, dir string) {
	t.Helper()
	runGitCmd(t, dir, "config", "user.name", "Test User")
	runGitCmd(t, dir, "config", "user.email", "test@example.com")
}

func writeChangeRequestFile(t *testing.T, dir string, name string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		t.Fatalf("Failed to write %s: %v", name, err)
	}
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %s failed: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output))
}

func commitChangeRequestFile(t *testing.T, dir string, name string, content string, message string) string {
	t.Helper()
	writeChangeRequestFile(t, dir, name, content)
	runGitCmd(t, dir, "add", ".")
	runGitCmd(t, dir, "commit", "-m", message)
	return gitOutput(t, dir, "rev-parse", "HEAD")
}

// newChangeRequestFixture builds an origin repository holding a
// refs/pull/12/head ref, then advances the base branch past the point where the
// work branch was cut. The advanced base branch is the case that distinguishes a
// merge-base comparison from a base-tip comparison.
func newChangeRequestFixture(t *testing.T) changeRequestFixture {
	t.Helper()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("Git not available: %v", err)
	}

	root := t.TempDir()
	originPath := filepath.Join(root, "origin.git")
	runGitCmd(t, root, "init", "--bare", "-b", "main", "origin.git")

	authorPath := filepath.Join(root, "author")
	runGitCmd(t, root, "clone", originPath, "author")
	configureChangeRequestIdentity(t, authorPath)

	mergeBaseOID := commitChangeRequestFile(t, authorPath, "shared.txt", "base\n", "base commit")
	runGitCmd(t, authorPath, "push", "origin", "main")

	runGitCmd(t, authorPath, "checkout", "-b", "work")
	headOID := commitChangeRequestFile(t, authorPath, "logic.txt", "work change\n", "work commit")
	runGitCmd(t, authorPath, "push", "origin", "HEAD:refs/pull/12/head")

	// Someone else merges into the base branch after the work branch was cut.
	runGitCmd(t, authorPath, "checkout", "main")
	advancedOID := commitChangeRequestFile(t, authorPath, "unrelated.txt", "someone else\n", "unrelated main commit")
	runGitCmd(t, authorPath, "push", "origin", "main")

	consumerPath := filepath.Join(root, "consumer")
	runGitCmd(t, root, "clone", originPath, "consumer")
	configureChangeRequestIdentity(t, consumerPath)

	return changeRequestFixture{
		OriginPath:      originPath,
		AuthorPath:      authorPath,
		ConsumerPath:    consumerPath,
		HeadOID:         headOID,
		MergeBaseOID:    mergeBaseOID,
		AdvancedMainOID: advancedOID,
	}
}

// ============================================================================
// Phase 3a-1: Snapshot refs
// ============================================================================

func TestEnsureChangeRequestSnapshotsLocal_UsesMergeBaseNotBranchTip(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", fixture.HeadOID, false)
	if !result.Success {
		t.Fatalf("Expected snapshot success, got %s: %s", result.ErrorCode, result.Error)
	}

	if result.Snapshot.HeadOID != fixture.HeadOID {
		t.Errorf("Expected head OID %s, got %s", fixture.HeadOID, result.Snapshot.HeadOID)
	}
	if result.Snapshot.BaseOID != fixture.MergeBaseOID {
		t.Errorf("Expected base to be the merge base %s, got %s", fixture.MergeBaseOID, result.Snapshot.BaseOID)
	}
	if result.Snapshot.BaseOID == fixture.AdvancedMainOID {
		t.Error("Base resolved to the advanced branch tip; diffs would show unrelated changes as reversals")
	}
	if result.Snapshot.BaseTipOID != fixture.AdvancedMainOID {
		t.Errorf("Expected base tip %s, got %s", fixture.AdvancedMainOID, result.Snapshot.BaseTipOID)
	}

	// The whole point of the merge base: a two-dot diff must match the file
	// list GitHub would report for this request.
	changed := gitOutput(t, fixture.ConsumerPath, "diff", "--name-only",
		result.Snapshot.BaseRef+".."+result.Snapshot.HeadRef)
	if changed != "logic.txt" {
		t.Errorf("Expected only logic.txt to differ, got %q", changed)
	}
}

func TestEnsureChangeRequestSnapshotsLocal_DetectsStaleHead(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestSnapshotsLocal(
		fixture.ConsumerPath, 12, "main", "0000000000000000000000000000000000000000", false)

	if result.Success {
		t.Fatal("Expected stale head to fail")
	}
	if result.ErrorCode != GitHubChangeRequestErrorSnapshotStale {
		t.Errorf("Expected snapshot_stale, got %s", result.ErrorCode)
	}
	if result.ObservedHeadOID != fixture.HeadOID {
		t.Errorf("Expected observed head %s, got %s", fixture.HeadOID, result.ObservedHeadOID)
	}
}

func TestEnsureChangeRequestSnapshotsLocal_AcceptsEmptyExpectedHead(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", "", false)
	if !result.Success {
		t.Fatalf("Expected success without an expected head OID, got %s: %s", result.ErrorCode, result.Error)
	}
}

func TestEnsureChangeRequestSnapshotsLocal_RejectsCrossRepository(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", fixture.HeadOID, true)
	if result.Success {
		t.Fatal("Expected cross-repository request to be rejected")
	}
	if result.ErrorCode != GitHubChangeRequestErrorSnapshotUnsupported {
		t.Errorf("Expected snapshot_unsupported, got %s", result.ErrorCode)
	}

	// The rejection must happen before any ref is written.
	refs := gitOutput(t, fixture.ConsumerPath, "for-each-ref", "--format=%(refname)", changeRequestRefNamespace)
	if refs != "" {
		t.Errorf("Expected no snapshot refs, got %q", refs)
	}
}

func TestEnsureChangeRequestSnapshotsLocal_ForceUpdatesOnRefresh(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	if result := svc.EnsureChangeRequestSnapshotsLocal(
		fixture.ConsumerPath, 12, "main", fixture.HeadOID, false); !result.Success {
		t.Fatalf("Expected first snapshot to succeed: %s", result.Error)
	}

	// The author force-pushes the work branch, as happens after a rebase.
	runGitCmd(t, fixture.AuthorPath, "checkout", "work")
	updatedHead := commitChangeRequestFile(t, fixture.AuthorPath, "logic.txt", "revised work change\n", "revised work commit")
	runGitCmd(t, fixture.AuthorPath, "push", "--force", "origin", "HEAD:refs/pull/12/head")

	result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", updatedHead, false)
	if !result.Success {
		t.Fatalf("Expected refresh to succeed, got %s: %s", result.ErrorCode, result.Error)
	}
	if result.Snapshot.HeadOID != updatedHead {
		t.Errorf("Expected refreshed head %s, got %s", updatedHead, result.Snapshot.HeadOID)
	}
}

func TestEnsureChangeRequestSnapshotsLocal_RejectsUnrelatedHistory(t *testing.T) {
	fixture := newChangeRequestFixture(t)

	runGitCmd(t, fixture.AuthorPath, "checkout", "--orphan", "detached-work")
	runGitCmd(t, fixture.AuthorPath, "rm", "-rf", "--cached", ".")
	commitChangeRequestFile(t, fixture.AuthorPath, "detached.txt", "unrelated\n", "unrelated root commit")
	runGitCmd(t, fixture.AuthorPath, "push", "origin", "HEAD:refs/pull/13/head")

	svc := NewGitService()
	result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 13, "main", "", false)

	if result.Success {
		t.Fatal("Expected unrelated history to be rejected")
	}
	if result.ErrorCode != GitHubChangeRequestErrorSnapshotUnavailable {
		t.Errorf("Expected snapshot_unavailable, got %s", result.ErrorCode)
	}
}

func TestEnsureChangeRequestSnapshotsLocal_RequiresOrigin(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	svc := NewGitService()
	result := svc.EnsureChangeRequestSnapshotsLocal(repoPath, 12, "main", "", false)

	if result.ErrorCode != GitHubChangeRequestErrorOriginMissing {
		t.Errorf("Expected origin_missing, got %s", result.ErrorCode)
	}
}

func TestClearChangeRequestSnapshot_RemovesOnlyThatRequest(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	runGitCmd(t, fixture.AuthorPath, "push", "origin", "refs/heads/work:refs/pull/14/head")

	if result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", "", false); !result.Success {
		t.Fatalf("Expected snapshot 12 to succeed: %s", result.Error)
	}
	if result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 14, "main", "", false); !result.Success {
		t.Fatalf("Expected snapshot 14 to succeed: %s", result.Error)
	}

	if result := svc.ClearChangeRequestSnapshot(fixture.ConsumerPath, 12); !result.Success {
		t.Fatalf("Expected cleanup to succeed: %s", result.Error)
	}

	refs := gitOutput(t, fixture.ConsumerPath, "for-each-ref", "--format=%(refname)", changeRequestRefNamespace)
	if strings.Contains(refs, changeRequestRefPrefix(12)+"/") {
		t.Errorf("Expected request 12 refs to be removed, got %q", refs)
	}
	if !strings.Contains(refs, changeRequestRefPrefix(14)+"/") {
		t.Errorf("Expected request 14 refs to remain, got %q", refs)
	}
}

func TestClearChangeRequestSnapshots_RemovesNamespace(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	if result := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", "", false); !result.Success {
		t.Fatalf("Expected snapshot to succeed: %s", result.Error)
	}

	if result := svc.ClearChangeRequestSnapshots(fixture.ConsumerPath); !result.Success {
		t.Fatalf("Expected cleanup to succeed: %s", result.Error)
	}

	refs := gitOutput(t, fixture.ConsumerPath, "for-each-ref", "--format=%(refname)", changeRequestRefNamespace)
	if refs != "" {
		t.Errorf("Expected all snapshot refs to be removed, got %q", refs)
	}

	// Cleanup must stay idempotent so repository open can always call it.
	if result := svc.ClearChangeRequestSnapshots(fixture.ConsumerPath); !result.Success {
		t.Errorf("Expected repeat cleanup to succeed: %s", result.Error)
	}
}

// ============================================================================
// Phase 3a-2: Content availability
// ============================================================================

type contentFixture struct {
	RepoPath string
	BaseOID  string
	HeadOID  string
}

// newContentFixture builds a repository with a modification, an addition, and a
// deletion between two commits.
func newContentFixture(t *testing.T) contentFixture {
	t.Helper()

	repoPath := createTestRepo(t)
	t.Cleanup(func() { cleanupTestRepo(t, repoPath) })

	writeChangeRequestFile(t, repoPath, "modified.txt", "original\n")
	writeChangeRequestFile(t, repoPath, "removed.txt", "goes away\n")
	runGitCmd(t, repoPath, "add", ".")
	runGitCmd(t, repoPath, "commit", "-m", "base")
	baseOID := gitOutput(t, repoPath, "rev-parse", "HEAD")

	writeChangeRequestFile(t, repoPath, "modified.txt", "updated content\n")
	writeChangeRequestFile(t, repoPath, "added.txt", "brand new\n")
	runGitCmd(t, repoPath, "rm", "removed.txt")
	runGitCmd(t, repoPath, "add", ".")
	runGitCmd(t, repoPath, "commit", "-m", "head")
	headOID := gitOutput(t, repoPath, "rev-parse", "HEAD")

	return contentFixture{RepoPath: repoPath, BaseOID: baseOID, HeadOID: headOID}
}

func TestEnsureChangeRequestFileContent_ModifiedFile(t *testing.T) {
	fixture := newContentFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestFileContent(
		fixture.RepoPath, fixture.BaseOID, "modified.txt", fixture.HeadOID, "modified.txt")

	if !result.Success || !result.Comparable {
		t.Fatalf("Expected a comparable modified file, got %s: %s", result.ErrorCode, result.Error)
	}
	if !result.OldSide.Exists || !result.NewSide.Exists {
		t.Error("Expected both sides to exist for a modification")
	}
	if result.OldSide.Size != int64(len("original\n")) {
		t.Errorf("Expected old size %d, got %d", len("original\n"), result.OldSide.Size)
	}
	if result.NewSide.Size != int64(len("updated content\n")) {
		t.Errorf("Expected new size %d, got %d", len("updated content\n"), result.NewSide.Size)
	}
}

func TestEnsureChangeRequestFileContent_AddedFileHasAbsentOldSide(t *testing.T) {
	fixture := newContentFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestFileContent(
		fixture.RepoPath, fixture.BaseOID, "added.txt", fixture.HeadOID, "added.txt")

	if !result.Comparable {
		t.Fatalf("Expected an addition to be comparable, got %s: %s", result.ErrorCode, result.Error)
	}
	if result.OldSide.Exists {
		t.Error("Expected the old side of an addition to be absent")
	}
	if !result.NewSide.Exists {
		t.Error("Expected the new side of an addition to exist")
	}
}

func TestEnsureChangeRequestFileContent_DeletedFileHasAbsentNewSide(t *testing.T) {
	fixture := newContentFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestFileContent(
		fixture.RepoPath, fixture.BaseOID, "removed.txt", fixture.HeadOID, "removed.txt")

	if !result.Comparable {
		t.Fatalf("Expected a deletion to be comparable, got %s: %s", result.ErrorCode, result.Error)
	}
	if !result.OldSide.Exists {
		t.Error("Expected the old side of a deletion to exist")
	}
	if result.NewSide.Exists {
		t.Error("Expected the new side of a deletion to be absent")
	}
}

func TestEnsureChangeRequestFileContent_RejectsMissingOnBothSides(t *testing.T) {
	fixture := newContentFixture(t)
	svc := NewGitService()

	result := svc.EnsureChangeRequestFileContent(
		fixture.RepoPath, fixture.BaseOID, "never-existed.txt", fixture.HeadOID, "never-existed.txt")

	if result.Comparable {
		t.Fatal("Expected a file absent from both sides to be uncomparable")
	}
	if result.ErrorCode != GitHubChangeRequestErrorSnapshotUnavailable {
		t.Errorf("Expected snapshot_unavailable, got %s", result.ErrorCode)
	}
}

// TestEnsureChangeRequestFileContent_RejectsOversizedSide drives the size guard
// through an LFS pointer's declared size, so the boundary is exercised without
// committing a multi-gigabyte fixture.
func TestEnsureChangeRequestFileContent_RejectsOversizedSide(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	pointer := "version https://git-lfs.github.com/spec/v1\n" +
		"oid sha256:3333333333333333333333333333333333333333333333333333333333333333\n" +
		"size 10737418240\n"
	writeChangeRequestFile(t, repoPath, "huge.step", pointer)
	runGitCmd(t, repoPath, "add", ".")
	runGitCmd(t, repoPath, "commit", "-m", "oversized asset")
	headOID := gitOutput(t, repoPath, "rev-parse", "HEAD")

	svc := NewGitService()
	result := svc.EnsureChangeRequestFileContent(repoPath, "", "", headOID, "huge.step")

	if result.Comparable {
		t.Fatal("Expected an oversized file to be uncomparable")
	}
	if result.ErrorCode != GitHubChangeRequestErrorContentTooLarge {
		t.Errorf("Expected content_too_large, got %s", result.ErrorCode)
	}
	if !result.NewSide.TooLarge {
		t.Error("Expected the new side to be flagged too large")
	}
	if result.NewSide.Size != 10737418240 {
		t.Errorf("Expected the pointer's declared size, got %d", result.NewSide.Size)
	}
}

func TestEnsureChangeRequestFileContent_ReportsUnhydratableLFS(t *testing.T) {
	repoPath := createTestRepo(t)
	defer cleanupTestRepo(t, repoPath)

	pointer := "version https://git-lfs.github.com/spec/v1\n" +
		"oid sha256:4444444444444444444444444444444444444444444444444444444444444444\n" +
		"size 2048\n"
	writeChangeRequestFile(t, repoPath, "drawing.pdf", pointer)
	runGitCmd(t, repoPath, "add", ".")
	runGitCmd(t, repoPath, "commit", "-m", "lfs asset")
	headOID := gitOutput(t, repoPath, "rev-parse", "HEAD")

	svc := NewGitService()
	result := svc.EnsureChangeRequestFileContent(repoPath, "", "", headOID, "drawing.pdf")

	if result.Comparable {
		t.Fatal("Expected an unhydratable LFS file to be uncomparable")
	}
	if result.ErrorCode != GitHubChangeRequestErrorContentLFSUnavailable {
		t.Errorf("Expected content_lfs_unavailable, got %s", result.ErrorCode)
	}
	if !result.NewSide.IsLFS {
		t.Error("Expected the new side to be detected as LFS")
	}
	if result.NewSide.Size != 2048 {
		t.Errorf("Expected the pointer's declared size 2048, got %d", result.NewSide.Size)
	}
}

func TestParseLFSPointerSize(t *testing.T) {
	tests := []struct {
		name     string
		pointer  string
		expected int64
		ok       bool
	}{
		{
			name:     "reads declared size",
			pointer:  "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 4096\n",
			expected: 4096,
			ok:       true,
		},
		{
			name:    "missing size line",
			pointer: "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
			ok:      false,
		},
		{
			name:    "malformed size line",
			pointer: "version https://git-lfs.github.com/spec/v1\nsize not-a-number\n",
			ok:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			size, ok := parseLFSPointerSize([]byte(tc.pointer))
			if ok != tc.ok {
				t.Fatalf("Expected ok=%v, got %v", tc.ok, ok)
			}
			if ok && size != tc.expected {
				t.Errorf("Expected size %d, got %d", tc.expected, size)
			}
		})
	}
}

// ============================================================================
// Phase 3b: Snapshot refs flow through the shared diff path
// ============================================================================

// The Change Request viewer reuses DiffMergeReviewFileRaw with fully-qualified
// snapshot refs. resolveBranchRef is otherwise branch-name oriented, so this
// guards the contract the viewer depends on.
func TestDiffMergeReviewFileRaw_AcceptsQualifiedSnapshotRefs(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	snapshot := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", fixture.HeadOID, false)
	if !snapshot.Success {
		t.Fatalf("Expected snapshot success, got %s: %s", snapshot.ErrorCode, snapshot.Error)
	}

	result := svc.DiffMergeReviewFileRaw(
		fixture.ConsumerPath,
		snapshot.Snapshot.BaseRef,
		snapshot.Snapshot.HeadRef,
		"logic.txt",
	)

	if result.HasError {
		t.Fatalf("Expected diff against qualified refs to succeed, got %s", result.Error)
	}
	if result.Status != "added" {
		t.Errorf("Expected logic.txt to be added relative to the merge base, got %q", result.Status)
	}
	if !strings.Contains(result.RawDiff, "logic.txt") {
		t.Errorf("Expected diff text to reference logic.txt, got %q", result.RawDiff)
	}
	if result.TargetRef != snapshot.Snapshot.BaseRef {
		t.Errorf("Expected target ref %s to survive resolution, got %s", snapshot.Snapshot.BaseRef, result.TargetRef)
	}
	if result.SourceRef != snapshot.Snapshot.HeadRef {
		t.Errorf("Expected source ref %s to survive resolution, got %s", snapshot.Snapshot.HeadRef, result.SourceRef)
	}
}

// A remote-prefixed lookup must not silently rewrite a qualified ref.
func TestResolveBranchRef_QualifiedRefIsNotRemotePrefixed(t *testing.T) {
	fixture := newChangeRequestFixture(t)
	svc := NewGitService()

	snapshot := svc.EnsureChangeRequestSnapshotsLocal(fixture.ConsumerPath, 12, "main", fixture.HeadOID, false)
	if !snapshot.Success {
		t.Fatalf("Expected snapshot success, got %s: %s", snapshot.ErrorCode, snapshot.Error)
	}

	resolved, err := svc.resolveBranchRef(fixture.ConsumerPath, snapshot.Snapshot.BaseRef, true)
	if err != nil {
		t.Fatalf("Expected qualified ref to resolve, got %v", err)
	}
	if resolved != snapshot.Snapshot.BaseRef {
		t.Errorf("Expected %s to resolve unchanged, got %s", snapshot.Snapshot.BaseRef, resolved)
	}

	if _, err := svc.resolveBranchRef(fixture.ConsumerPath, "refs/iofabrik/change-requests/999/base", true); err == nil {
		t.Error("Expected a missing qualified ref to fail rather than fall back to a branch lookup")
	}
}
