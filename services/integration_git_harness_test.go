package services

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Phase 0 of the Isolated Conflict Resolution Plan. These tests prove the Git
// mechanics the isolated integration session will depend on, against real Git,
// before any service code exists. Nothing here imports service types on
// purpose: if the mechanics do not hold, the design does not hold.

// integrationResultRefPrefix mirrors the private namespace the session service
// will use, so the unreachability assertions exercise the real ref location.
const integrationResultRefPrefix = "refs/iofabrik/integration/"

// integrationFixture is a repository shaped like the real scenario: the
// destination branch is checked out in the open project and the source branch
// lives in a linked worktree.
type integrationFixture struct {
	openProject    string
	linkedWorktree string
	destination    string
	source         string
}

// newLinkedWorktreeRepo builds that fixture. The linked worktree matters
// because every Git administrative path assumption in the current codebase
// breaks the moment more than one worktree exists.
func newLinkedWorktreeRepo(t *testing.T) integrationFixture {
	t.Helper()

	openProject := createTestRepo(t)
	t.Cleanup(func() { os.RemoveAll(openProject) })

	runGitCmd(t, openProject, "config", "core.autocrlf", "false")
	commitFileAt(t, openProject, "shared.txt", "base\n", "base")
	runGitCmd(t, openProject, "branch", "-M", "main")
	runGitCmd(t, openProject, "branch", "feature")

	linked := filepath.Join(t.TempDir(), "feature-worktree")
	runGitCmd(t, openProject, "worktree", "add", linked, "feature")

	return integrationFixture{
		openProject:    openProject,
		linkedWorktree: linked,
		destination:    "main",
		source:         "feature",
	}
}

func commitFileAt(t *testing.T, dir string, relPath string, content string, message string) string {
	t.Helper()
	fullPath := filepath.Join(dir, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("create directory for %s: %v", relPath, err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", relPath, err)
	}
	runGitCmd(t, dir, "add", "--", relPath)
	runGitCmd(t, dir, "commit", "-m", message)
	return revParse(t, dir, "HEAD")
}

func revParse(t *testing.T, dir string, rev string) string {
	t.Helper()
	return strings.TrimSpace(runGitOutput(t, dir, "rev-parse", rev))
}

func runGitAllowFail(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	return string(output), err
}

// addIntegrationWorkspace creates the backend-owned worktree, detached at the
// destination revision so neither branch can move as a side effect.
func addIntegrationWorkspace(t *testing.T, repoPath string, destinationOID string) string {
	t.Helper()
	workspace := filepath.Join(t.TempDir(), "integration-workspace")
	runGitCmd(t, repoPath, "worktree", "add", "--detach", workspace, destinationOID)
	t.Cleanup(func() {
		runGitAllowFail(t, repoPath, "worktree", "remove", "--force", workspace)
	})
	return workspace
}

// runIntegrationMerge performs the real merge inside the workspace. A nil error
// means the merge left a clean, fully staged index.
func runIntegrationMerge(t *testing.T, workspace string, sourceOID string, squash bool) error {
	t.Helper()
	args := []string{"merge", "--no-commit", "--no-ff", sourceOID}
	if squash {
		args = []string{"merge", "--squash", sourceOID}
	}
	_, err := runGitAllowFail(t, workspace, args...)
	return err
}

// createIntegrationResult writes the prepared result. commit-tree is the chosen
// primitive because it takes explicit parents and cannot run repository hooks.
func createIntegrationResult(t *testing.T, workspace string, destinationOID string, sourceOID string, squash bool) string {
	t.Helper()
	treeOID := strings.TrimSpace(runGitOutput(t, workspace, "write-tree"))
	args := []string{"commit-tree", treeOID, "-p", destinationOID}
	if !squash {
		args = append(args, "-p", sourceOID)
	}
	args = append(args, "-m", "prepared integration result")
	return strings.TrimSpace(runGitOutput(t, workspace, args...))
}

func parentsOf(t *testing.T, dir string, oid string) []string {
	t.Helper()
	fields := strings.Fields(runGitOutput(t, dir, "rev-list", "--parents", "-n", "1", oid))
	if len(fields) == 0 {
		t.Fatalf("no rev-list output for %s", oid)
	}
	return fields[1:]
}

// plantFailingHooks installs hooks that record they ran and then fail. They
// live in the common directory, so every linked worktree shares them.
func plantFailingHooks(t *testing.T, repoPath string, markerDir string, names ...string) {
	t.Helper()
	hooksDir := filepath.Join(repoPath, ".git", "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatalf("create hooks directory: %v", err)
	}
	for _, name := range names {
		script := "#!/bin/sh\ntouch " + filepath.Join(markerDir, name) + "\nexit 1\n"
		if err := os.WriteFile(filepath.Join(hooksDir, name), []byte(script), 0o755); err != nil {
			t.Fatalf("write %s hook: %v", name, err)
		}
	}
}

func TestIntegrationHarnessConflictingMergeLeavesWorkspaceUnmerged(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)

	sourceOID := commitFileAt(t, fixture.linkedWorktree, "shared.txt", "line\nfeature\n", "feature edit")
	destinationOID := commitFileAt(t, fixture.openProject, "shared.txt", "line\nmain\n", "main edit")

	workspace := addIntegrationWorkspace(t, fixture.openProject, destinationOID)
	if err := runIntegrationMerge(t, workspace, sourceOID, false); err == nil {
		t.Fatal("expected the merge to report conflicts")
	}

	stages := runGitOutput(t, workspace, "ls-files", "-u", "--", "shared.txt")
	for _, stage := range []string{" 1\t", " 2\t", " 3\t"} {
		if !strings.Contains(stages, stage) {
			t.Fatalf("expected stage%s for shared.txt, got:\n%s", strings.TrimSpace(stage), stages)
		}
	}

	// The whole point: the open project never notices.
	if got := revParse(t, fixture.openProject, "HEAD"); got != destinationOID {
		t.Fatalf("open project HEAD moved to %s, expected %s", got, destinationOID)
	}
	if status := runGitOutput(t, fixture.openProject, "status", "--porcelain"); strings.TrimSpace(status) != "" {
		t.Fatalf("open project is dirty after preparation:\n%s", status)
	}
}

func TestIntegrationHarnessRegularResultHasTwoParentsInOrder(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)

	sourceOID := commitFileAt(t, fixture.linkedWorktree, "feature.txt", "feature\n", "feature file")
	destinationOID := commitFileAt(t, fixture.openProject, "main.txt", "main\n", "main file")

	workspace := addIntegrationWorkspace(t, fixture.openProject, destinationOID)
	if err := runIntegrationMerge(t, workspace, sourceOID, false); err != nil {
		t.Fatalf("expected a clean merge: %v", err)
	}
	resultOID := createIntegrationResult(t, workspace, destinationOID, sourceOID, false)

	parents := parentsOf(t, fixture.openProject, resultOID)
	if len(parents) != 2 || parents[0] != destinationOID || parents[1] != sourceOID {
		t.Fatalf("expected parents [%s %s], got %v", destinationOID, sourceOID, parents)
	}
}

func TestIntegrationHarnessSquashResultHasSingleParentAndMatchingTree(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)

	commitFileAt(t, fixture.linkedWorktree, "feature.txt", "feature\n", "feature file")
	sourceOID := commitFileAt(t, fixture.linkedWorktree, "feature.txt", "feature revised\n", "feature follow-up")
	destinationOID := commitFileAt(t, fixture.openProject, "main.txt", "main\n", "main file")

	workspace := addIntegrationWorkspace(t, fixture.openProject, destinationOID)
	if err := runIntegrationMerge(t, workspace, sourceOID, true); err != nil {
		t.Fatalf("expected a clean squash merge: %v", err)
	}
	resultOID := createIntegrationResult(t, workspace, destinationOID, sourceOID, true)

	parents := parentsOf(t, fixture.openProject, resultOID)
	if len(parents) != 1 || parents[0] != destinationOID {
		t.Fatalf("expected single parent %s, got %v", destinationOID, parents)
	}

	// Control: the same squash performed through git's ordinary commit path.
	control := addIntegrationWorkspace(t, fixture.openProject, destinationOID)
	if err := runIntegrationMerge(t, control, sourceOID, true); err != nil {
		t.Fatalf("control squash merge failed: %v", err)
	}
	runGitCmd(t, control, "commit", "--no-verify", "-m", "control squash")

	if got, want := revParse(t, fixture.openProject, resultOID+"^{tree}"), revParse(t, control, "HEAD^{tree}"); got != want {
		t.Fatalf("squash result tree %s does not match git merge --squash tree %s", got, want)
	}
}

func TestIntegrationHarnessResultCreationSkipsRepositoryHooks(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)

	markerDir := t.TempDir()
	sourceOID := commitFileAt(t, fixture.linkedWorktree, "feature.txt", "feature\n", "feature file")
	destinationOID := revParse(t, fixture.openProject, "main")

	// Planted after the fixture commits so only preparation can trip them.
	plantFailingHooks(t, fixture.openProject, markerDir, "pre-commit", "commit-msg", "prepare-commit-msg", "post-merge")

	workspace := addIntegrationWorkspace(t, fixture.openProject, destinationOID)
	if err := runIntegrationMerge(t, workspace, sourceOID, false); err != nil {
		t.Fatalf("expected a clean merge: %v", err)
	}
	resultOID := createIntegrationResult(t, workspace, destinationOID, sourceOID, false)
	if resultOID == "" {
		t.Fatal("expected a prepared result")
	}

	entries, err := os.ReadDir(markerDir)
	if err != nil {
		t.Fatalf("read hook markers: %v", err)
	}
	if len(entries) != 0 {
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("project hooks ran during preparation: %v", names)
	}
}

func TestIntegrationHarnessPreparedResultIsUnreachableFromBranches(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)

	sourceOID := commitFileAt(t, fixture.linkedWorktree, "feature.txt", "feature\n", "feature file")
	destinationOID := commitFileAt(t, fixture.openProject, "main.txt", "main\n", "main file")

	workspace := addIntegrationWorkspace(t, fixture.openProject, destinationOID)
	if err := runIntegrationMerge(t, workspace, sourceOID, false); err != nil {
		t.Fatalf("expected a clean merge: %v", err)
	}
	resultOID := createIntegrationResult(t, workspace, destinationOID, sourceOID, false)
	runGitCmd(t, fixture.openProject, "update-ref", integrationResultRefPrefix+"session-1", resultOID)

	if containing := strings.TrimSpace(runGitOutput(t, fixture.openProject, "branch", "--all", "--contains", resultOID)); containing != "" {
		t.Fatalf("prepared result is reachable from branches:\n%s", containing)
	}

	heads := strings.Fields(runGitOutput(t, fixture.openProject, "for-each-ref", "--format=%(refname)", "refs/heads"))
	if len(heads) == 0 {
		t.Fatal("expected at least one branch to check")
	}
	for _, head := range heads {
		if _, err := runGitAllowFail(t, fixture.openProject, "merge-base", "--is-ancestor", resultOID, head); err == nil {
			t.Fatalf("prepared result is an ancestor of %s", head)
		}
	}
}

// pivotIntegrationFixture models the replacement workflow: the feature branch
// is checked out in the open project while another clone advances shared work.
type pivotIntegrationFixture struct {
	openProject string
	sharedClone string
	remotePath  string
}

func newPivotIntegrationFixture(t *testing.T) pivotIntegrationFixture {
	t.Helper()

	openProject := createTestRepo(t)
	t.Cleanup(func() { cleanupTestRepo(t, openProject) })
	runGitCmd(t, openProject, "config", "core.autocrlf", "false")
	commitFileAt(t, openProject, "shared.txt", "base\n", "base")
	runGitCmd(t, openProject, "branch", "-M", "main")

	remotePath := createBareRemoteAndLink(t, openProject)
	t.Cleanup(func() { os.RemoveAll(remotePath) })
	runGitCmd(t, openProject, "push", "-u", "origin", "main")
	runGitCmd(t, remotePath, "symbolic-ref", "HEAD", "refs/heads/main")

	sharedClone := filepath.Join(t.TempDir(), "shared-clone")
	runGitCmd(t, filepath.Dir(sharedClone), "clone", remotePath, sharedClone)
	runGitCmd(t, sharedClone, "config", "user.name", "Shared User")
	runGitCmd(t, sharedClone, "config", "user.email", "shared@example.com")
	runGitCmd(t, sharedClone, "config", "core.autocrlf", "false")

	runGitCmd(t, openProject, "checkout", "-b", "feature")
	return pivotIntegrationFixture{
		openProject: openProject,
		sharedClone: sharedClone,
		remotePath:  remotePath,
	}
}

func (fixture pivotIntegrationFixture) advanceDestination(t *testing.T, relPath string, content string) string {
	t.Helper()
	destinationOID := commitFileAt(t, fixture.sharedClone, relPath, content, "shared update")
	runGitCmd(t, fixture.sharedClone, "push", "origin", "main")
	return destinationOID
}

func validatePivotStart(t *testing.T, repoPath string, featureBranch string, featureOID string, destinationOID string) error {
	t.Helper()
	if branch := strings.TrimSpace(runGitOutput(t, repoPath, "branch", "--show-current")); branch != featureBranch {
		return fmt.Errorf("open project switched to %s", branch)
	}
	if currentFeatureOID := revParse(t, repoPath, "refs/heads/"+featureBranch); currentFeatureOID != featureOID {
		return fmt.Errorf("feature changed from %s to %s", featureOID, currentFeatureOID)
	}
	if currentDestinationOID := revParse(t, repoPath, "refs/remotes/origin/main"); currentDestinationOID != destinationOID {
		return fmt.Errorf("shared destination changed from %s to %s", destinationOID, currentDestinationOID)
	}
	if status := strings.TrimSpace(runGitOutput(t, repoPath, "status", "--porcelain")); status != "" {
		return fmt.Errorf("open project has unsaved changes: %s", status)
	}
	return nil
}

func completeCleanPivotMerge(t *testing.T, fixture pivotIntegrationFixture) (string, string, string) {
	t.Helper()
	featureOID := commitFileAt(t, fixture.openProject, "feature.txt", "feature\n", "feature update")
	destinationOID := fixture.advanceDestination(t, "shared.txt", "shared\n")
	runGitCmd(t, fixture.openProject, "fetch", "origin")
	if got := revParse(t, fixture.openProject, "refs/remotes/origin/main"); got != destinationOID {
		t.Fatalf("fetch captured destination %s, want %s", got, destinationOID)
	}
	runGitCmd(t, fixture.openProject, "merge", "--no-edit", "origin/main")
	return featureOID, destinationOID, revParse(t, fixture.openProject, "HEAD")
}

func TestPivotIntegrationHarnessFetchThenCleanMerge(t *testing.T) {
	fixture := newPivotIntegrationFixture(t)
	featureOID, destinationOID, resultOID := completeCleanPivotMerge(t, fixture)

	parents := parentsOf(t, fixture.openProject, resultOID)
	if len(parents) != 2 || parents[0] != featureOID || parents[1] != destinationOID {
		t.Fatalf("expected parents [%s %s], got %v", featureOID, destinationOID, parents)
	}
	if status := strings.TrimSpace(runGitOutput(t, fixture.openProject, "status", "--porcelain")); status != "" {
		t.Fatalf("open project is dirty after clean update:\n%s", status)
	}
}

func TestPivotIntegrationHarnessConflictDirectionAndMergeParents(t *testing.T) {
	fixture := newPivotIntegrationFixture(t)
	featureOID := commitFileAt(t, fixture.openProject, "shared.txt", "feature\n", "feature update")
	destinationOID := fixture.advanceDestination(t, "shared.txt", "shared\n")

	runGitCmd(t, fixture.openProject, "fetch", "origin")
	if _, err := runGitAllowFail(t, fixture.openProject, "merge", "--no-edit", "origin/main"); err == nil {
		t.Fatal("expected the destination update to require a decision")
	}

	if got := runGitOutput(t, fixture.openProject, "show", ":2:shared.txt"); got != "feature\n" {
		t.Fatalf("expected stage 2 to contain feature work, got %q", got)
	}
	if got := runGitOutput(t, fixture.openProject, "show", ":3:shared.txt"); got != "shared\n" {
		t.Fatalf("expected stage 3 to contain shared work, got %q", got)
	}

	if err := os.WriteFile(filepath.Join(fixture.openProject, "shared.txt"), []byte("resolved\n"), 0o644); err != nil {
		t.Fatalf("write resolved file: %v", err)
	}
	runGitCmd(t, fixture.openProject, "add", "--", "shared.txt")
	runGitCmd(t, fixture.openProject, "commit", "--no-edit")

	parents := parentsOf(t, fixture.openProject, "HEAD")
	if len(parents) != 2 || parents[0] != featureOID || parents[1] != destinationOID {
		t.Fatalf("expected parents [%s %s], got %v", featureOID, destinationOID, parents)
	}
}

func TestPivotIntegrationHarnessAbortRestoresOpenProject(t *testing.T) {
	fixture := newPivotIntegrationFixture(t)
	featureOID := commitFileAt(t, fixture.openProject, "shared.txt", "feature\n", "feature update")
	fixture.advanceDestination(t, "shared.txt", "shared\n")

	indexTreeBefore := strings.TrimSpace(runGitOutput(t, fixture.openProject, "write-tree"))
	fileBefore, err := os.ReadFile(filepath.Join(fixture.openProject, "shared.txt"))
	if err != nil {
		t.Fatalf("read feature file: %v", err)
	}

	runGitCmd(t, fixture.openProject, "fetch", "origin")
	if _, err := runGitAllowFail(t, fixture.openProject, "merge", "--no-edit", "origin/main"); err == nil {
		t.Fatal("expected the destination update to require a decision")
	}
	runGitCmd(t, fixture.openProject, "merge", "--abort")

	if got := revParse(t, fixture.openProject, "HEAD"); got != featureOID {
		t.Fatalf("feature revision changed after cancellation: got %s, want %s", got, featureOID)
	}
	if got := strings.TrimSpace(runGitOutput(t, fixture.openProject, "write-tree")); got != indexTreeBefore {
		t.Fatalf("index tree changed after cancellation: got %s, want %s", got, indexTreeBefore)
	}
	if status := strings.TrimSpace(runGitOutput(t, fixture.openProject, "status", "--porcelain")); status != "" {
		t.Fatalf("open project is dirty after cancellation:\n%s", status)
	}
	fileAfter, err := os.ReadFile(filepath.Join(fixture.openProject, "shared.txt"))
	if err != nil {
		t.Fatalf("read restored feature file: %v", err)
	}
	if string(fileAfter) != string(fileBefore) {
		t.Fatalf("file changed after cancellation: got %q, want %q", fileAfter, fileBefore)
	}
	if _, err := runGitAllowFail(t, fixture.openProject, "rev-parse", "--verify", "MERGE_HEAD"); err == nil {
		t.Fatal("merge metadata remains after cancellation")
	}
}

func TestPivotIntegrationHarnessDirtyWorkBlocksBeforeMerge(t *testing.T) {
	tests := []struct {
		name  string
		dirty func(t *testing.T, repoPath string)
	}{
		{
			name: "staged",
			dirty: func(t *testing.T, repoPath string) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(repoPath, "shared.txt"), []byte("staged\n"), 0o644); err != nil {
					t.Fatalf("write staged change: %v", err)
				}
				runGitCmd(t, repoPath, "add", "--", "shared.txt")
			},
		},
		{
			name: "unstaged",
			dirty: func(t *testing.T, repoPath string) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(repoPath, "shared.txt"), []byte("unstaged\n"), 0o644); err != nil {
					t.Fatalf("write unstaged change: %v", err)
				}
			},
		},
		{
			name: "untracked",
			dirty: func(t *testing.T, repoPath string) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(repoPath, "untracked.txt"), []byte("untracked\n"), 0o644); err != nil {
					t.Fatalf("write untracked change: %v", err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newPivotIntegrationFixture(t)
			featureOID := commitFileAt(t, fixture.openProject, "feature.txt", "feature\n", "feature update")
			destinationOID := fixture.advanceDestination(t, "destination.txt", "shared\n")
			runGitCmd(t, fixture.openProject, "fetch", "origin")
			test.dirty(t, fixture.openProject)

			if err := validatePivotStart(t, fixture.openProject, "feature", featureOID, destinationOID); err == nil {
				t.Fatal("expected dirty work to block before merge")
			}
			if _, err := runGitAllowFail(t, fixture.openProject, "rev-parse", "--verify", "MERGE_HEAD"); err == nil {
				t.Fatal("merge started despite dirty work")
			}
			if got := revParse(t, fixture.openProject, "HEAD"); got != featureOID {
				t.Fatalf("feature moved while blocked: got %s, want %s", got, featureOID)
			}
		})
	}
}

func TestPivotIntegrationHarnessStaleStartStateIsRejected(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(t *testing.T, fixture pivotIntegrationFixture)
	}{
		{
			name: "feature revision moved",
			mutate: func(t *testing.T, fixture pivotIntegrationFixture) {
				commitFileAt(t, fixture.openProject, "later-feature.txt", "later\n", "later feature update")
			},
		},
		{
			name: "remote destination moved",
			mutate: func(t *testing.T, fixture pivotIntegrationFixture) {
				fixture.advanceDestination(t, "later-shared.txt", "later\n")
				runGitCmd(t, fixture.openProject, "fetch", "origin")
			},
		},
		{
			name: "checked out branch changed",
			mutate: func(t *testing.T, fixture pivotIntegrationFixture) {
				runGitCmd(t, fixture.openProject, "checkout", "main")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newPivotIntegrationFixture(t)
			featureOID := commitFileAt(t, fixture.openProject, "feature.txt", "feature\n", "feature update")
			destinationOID := fixture.advanceDestination(t, "destination.txt", "shared\n")
			runGitCmd(t, fixture.openProject, "fetch", "origin")
			test.mutate(t, fixture)

			if err := validatePivotStart(t, fixture.openProject, "feature", featureOID, destinationOID); err == nil {
				t.Fatal("expected stale start state to be rejected")
			}
			if _, err := runGitAllowFail(t, fixture.openProject, "rev-parse", "--verify", "MERGE_HEAD"); err == nil {
				t.Fatal("merge started despite stale state")
			}
		})
	}
}

func TestPivotIntegrationHarnessFetchFailuresDoNotMoveFeature(t *testing.T) {
	t.Run("remote unavailable", func(t *testing.T) {
		fixture := newPivotIntegrationFixture(t)
		featureOID := commitFileAt(t, fixture.openProject, "feature.txt", "feature\n", "feature update")
		offlinePath := fixture.remotePath + ".offline"
		if err := os.Rename(fixture.remotePath, offlinePath); err != nil {
			t.Fatalf("make remote unavailable: %v", err)
		}
		t.Cleanup(func() { os.RemoveAll(offlinePath) })

		if _, err := runGitAllowFail(t, fixture.openProject, "fetch", "origin"); err == nil {
			t.Fatal("expected fetch to fail while the remote is unavailable")
		}
		if got := revParse(t, fixture.openProject, "HEAD"); got != featureOID {
			t.Fatalf("feature moved after fetch failure: got %s, want %s", got, featureOID)
		}
	})

	t.Run("authentication rejected", func(t *testing.T) {
		fixture := newPivotIntegrationFixture(t)
		featureOID := commitFileAt(t, fixture.openProject, "feature.txt", "feature\n", "feature update")
		uploadPack := filepath.Join(t.TempDir(), "reject-upload-pack")
		if err := os.WriteFile(uploadPack, []byte("#!/bin/sh\necho 'Authentication failed' >&2\nexit 1\n"), 0o755); err != nil {
			t.Fatalf("write rejecting upload-pack: %v", err)
		}

		if _, err := runGitAllowFail(t, fixture.openProject, "fetch", "--upload-pack="+uploadPack, "origin"); err == nil {
			t.Fatal("expected authenticated fetch to be rejected")
		}
		if got := revParse(t, fixture.openProject, "HEAD"); got != featureOID {
			t.Fatalf("feature moved after authentication failure: got %s, want %s", got, featureOID)
		}
	})
}

func TestPivotIntegrationHarnessCommitHookFailureKeepsMergeRecoverable(t *testing.T) {
	fixture := newPivotIntegrationFixture(t)
	featureOID := commitFileAt(t, fixture.openProject, "shared.txt", "feature\n", "feature update")
	destinationOID := fixture.advanceDestination(t, "shared.txt", "shared\n")
	runGitCmd(t, fixture.openProject, "fetch", "origin")
	if _, err := runGitAllowFail(t, fixture.openProject, "merge", "--no-edit", "origin/main"); err == nil {
		t.Fatal("expected the destination update to require a decision")
	}
	if err := os.WriteFile(filepath.Join(fixture.openProject, "shared.txt"), []byte("resolved\n"), 0o644); err != nil {
		t.Fatalf("write resolved file: %v", err)
	}
	runGitCmd(t, fixture.openProject, "add", "--", "shared.txt")

	markerDir := t.TempDir()
	plantFailingHooks(t, fixture.openProject, markerDir, "pre-commit")
	if _, err := runGitAllowFail(t, fixture.openProject, "commit", "--no-edit"); err == nil {
		t.Fatal("expected the project hook to block merge completion")
	}
	if _, err := os.Stat(filepath.Join(markerDir, "pre-commit")); err != nil {
		t.Fatalf("expected pre-commit hook to run: %v", err)
	}
	if got := revParse(t, fixture.openProject, "HEAD"); got != featureOID {
		t.Fatalf("feature moved after hook failure: got %s, want %s", got, featureOID)
	}
	if _, err := runGitAllowFail(t, fixture.openProject, "rev-parse", "--verify", "MERGE_HEAD"); err != nil {
		t.Fatal("merge is not recoverable after hook failure")
	}

	if err := os.Remove(filepath.Join(fixture.openProject, ".git", "hooks", "pre-commit")); err != nil {
		t.Fatalf("remove failing hook: %v", err)
	}
	runGitCmd(t, fixture.openProject, "commit", "--no-edit")
	parents := parentsOf(t, fixture.openProject, "HEAD")
	if len(parents) != 2 || parents[0] != featureOID || parents[1] != destinationOID {
		t.Fatalf("expected parents [%s %s], got %v", featureOID, destinationOID, parents)
	}
}

func TestPivotIntegrationHarnessPushRejectionKeepsLocalUpdate(t *testing.T) {
	fixture := newPivotIntegrationFixture(t)
	_, _, resultOID := completeCleanPivotMerge(t, fixture)

	hooksDir := filepath.Join(fixture.remotePath, "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatalf("create remote hooks directory: %v", err)
	}
	rejectHook := []byte("#!/bin/sh\necho 'sharing rejected' >&2\nexit 1\n")
	if err := os.WriteFile(filepath.Join(hooksDir, "pre-receive"), rejectHook, 0o755); err != nil {
		t.Fatalf("write rejecting pre-receive hook: %v", err)
	}

	if _, err := runGitAllowFail(t, fixture.openProject, "push", "origin", "feature"); err == nil {
		t.Fatal("expected sharing to be rejected")
	}
	if got := revParse(t, fixture.openProject, "HEAD"); got != resultOID {
		t.Fatalf("local update moved after rejected share: got %s, want %s", got, resultOID)
	}
	if status := strings.TrimSpace(runGitOutput(t, fixture.openProject, "status", "--porcelain")); status != "" {
		t.Fatalf("open project is dirty after rejected share:\n%s", status)
	}
	if _, err := runGitAllowFail(t, fixture.remotePath, "rev-parse", "--verify", "refs/heads/feature"); err == nil {
		t.Fatal("remote feature exists despite rejected share")
	}
}
