package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestSessionStore(t *testing.T) *integrationSessionStore {
	t.Helper()
	return newIntegrationSessionStore(t.TempDir())
}

// newTestSession creates a session record and its workspace for a fixture.
func newTestSession(t *testing.T, fixture integrationFixture, integrationDir string) integrationSession {
	t.Helper()

	sessionID, err := newIntegrationSessionID()
	if err != nil {
		t.Fatalf("generate session id: %v", err)
	}

	runner := NewCommandRunner()
	commonDir, err := repositoryIdentity(runner, fixture.openProject)
	if err != nil {
		t.Fatalf("resolve repository identity: %v", err)
	}

	workspacePath := filepath.Join(integrationWorkspaceRoot(integrationDir), sessionID)
	destinationOID := revParse(t, fixture.openProject, fixture.destination)
	if err := createIntegrationWorkspace(runner, fixture.openProject, sessionID, destinationOID, workspacePath); err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	now := time.Now().Unix()
	return integrationSession{
		SessionID:           sessionID,
		RepositoryCommonDir: commonDir,
		OpenProjectPath:     fixture.openProject,
		WorkspacePath:       workspacePath,
		OperationKind:       "merge",
		MergeMode:           integrationModeRegular,
		SourceRef:           fixture.source,
		SourceOID:           revParse(t, fixture.openProject, fixture.source),
		DestinationRef:      fixture.destination,
		DestinationOID:      destinationOID,
		State:               integrationStateReady,
		Generation:          1,
		CreatedAt:           now,
		UpdatedAt:           now,
	}
}

func TestIntegrationSessionStoreRoundTrip(t *testing.T) {
	store := newTestSessionStore(t)
	sessionID, _ := newIntegrationSessionID()
	session := integrationSession{SessionID: sessionID, State: integrationStateReady, CreatedAt: 10}

	if err := store.save(session); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := store.load(sessionID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.SessionID != sessionID || loaded.State != integrationStateReady {
		t.Fatalf("unexpected session: %+v", loaded)
	}
	if loaded.SchemaVersion != integrationSessionSchemaVersion {
		t.Fatalf("expected schema version %d, got %d", integrationSessionSchemaVersion, loaded.SchemaVersion)
	}

	path, _ := store.sessionPath(sessionID)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat session file: %v", err)
	}
	if mode := info.Mode().Perm(); mode != integrationSessionFileMode {
		t.Fatalf("expected mode %v, got %v", integrationSessionFileMode, mode)
	}
}

func TestIntegrationSessionStoreRejectsUnsafeIDs(t *testing.T) {
	store := newTestSessionStore(t)
	for _, sessionID := range []string{"", "..", "../escape", strings.Repeat("z", 32)} {
		if err := store.save(integrationSession{SessionID: sessionID}); err == nil {
			t.Fatalf("expected %q to be rejected", sessionID)
		}
	}
}

func TestIntegrationSessionStoreSkipsUnreadableRecords(t *testing.T) {
	store := newTestSessionStore(t)
	good, _ := newIntegrationSessionID()
	if err := store.save(integrationSession{SessionID: good, CreatedAt: 1}); err != nil {
		t.Fatalf("save: %v", err)
	}

	future, _ := newIntegrationSessionID()
	payload, _ := json.Marshal(map[string]any{"schemaVersion": integrationSessionSchemaVersion + 1, "sessionId": future})
	if err := os.WriteFile(filepath.Join(store.root, future+".json"), payload, 0o600); err != nil {
		t.Fatalf("write future session: %v", err)
	}
	if err := os.WriteFile(filepath.Join(store.root, "garbage.json"), []byte("{"), 0o600); err != nil {
		t.Fatalf("write garbage: %v", err)
	}

	sessions, err := store.list()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 1 || sessions[0].SessionID != good {
		t.Fatalf("expected only the readable session, got %+v", sessions)
	}
}

func TestIntegrationSessionStoreQuarantinesSchemaV1Records(t *testing.T) {
	sessionID, err := newIntegrationSessionID()
	if err != nil {
		t.Fatalf("create session id: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"schemaVersion": 1, "sessionId": sessionID})
	if err != nil {
		t.Fatalf("encode schema-v1 record: %v", err)
	}
	if _, err := decodeIntegrationSession(payload); err == nil {
		t.Fatal("expected schema-v1 record to be quarantined")
	}
}

func TestIntegrationSessionStoreDeleteIsIdempotent(t *testing.T) {
	store := newTestSessionStore(t)
	sessionID, _ := newIntegrationSessionID()
	if err := store.save(integrationSession{SessionID: sessionID}); err != nil {
		t.Fatalf("save: %v", err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := store.delete(sessionID); err != nil {
			t.Fatalf("delete attempt %d: %v", attempt, err)
		}
	}
}

func TestIntegrationWorkspaceIsDetachedLockedAndMarkedOutsideTheWorkingTree(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)
	session := newTestSession(t, fixture, t.TempDir())
	runner := NewCommandRunner()

	if head := revParse(t, session.WorkspacePath, "HEAD"); head != session.DestinationOID {
		t.Fatalf("expected workspace at %s, got %s", session.DestinationOID, head)
	}
	if _, err := runGitAllowFail(t, session.WorkspacePath, "symbolic-ref", "-q", "HEAD"); err == nil {
		t.Fatal("expected a detached workspace")
	}

	worktrees := runGitOutput(t, fixture.openProject, "worktree", "list", "--porcelain")
	if !strings.Contains(worktrees, session.WorkspacePath) || !strings.Contains(worktrees, "locked") {
		t.Fatalf("expected a locked workspace entry:\n%s", worktrees)
	}

	// The marker must not be visible as project content.
	if status := strings.TrimSpace(runGitOutput(t, session.WorkspacePath, "status", "--porcelain")); status != "" {
		t.Fatalf("expected a clean workspace, got:\n%s", status)
	}
	markerPath, err := integrationOwnershipMarkerPath(runner, session.WorkspacePath)
	if err != nil {
		t.Fatalf("resolve marker: %v", err)
	}
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("expected an ownership marker: %v", err)
	}
	if strings.HasPrefix(markerPath, session.WorkspacePath+string(os.PathSeparator)) {
		t.Fatalf("marker must live outside the working tree, found at %s", markerPath)
	}
}

func TestIntegrationWorkspaceRemovalRefusesAForeignSession(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)
	session := newTestSession(t, fixture, t.TempDir())
	runner := NewCommandRunner()

	stranger, _ := newIntegrationSessionID()
	if err := removeIntegrationWorkspace(runner, fixture.openProject, stranger, session.WorkspacePath); err == nil {
		t.Fatal("expected removal to be refused for a different session")
	}
	if _, err := os.Stat(session.WorkspacePath); err != nil {
		t.Fatalf("workspace must survive a refused removal: %v", err)
	}
}

func TestIOFabrikCancelsLegacyReviewWithoutLeavingResultRefs(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)
	integrationDir := t.TempDir()
	store := newIntegrationSessionStore(integrationDir)
	session := newTestSession(t, fixture, integrationDir)
	runner := NewCommandRunner()
	marker, err := integrationOwnershipMarkerPath(runner, session.WorkspacePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(marker, filepath.Join(filepath.Dir(marker), "controlzebra-session.json")); err != nil {
		t.Fatal(err)
	}
	legacyRef := "refs/controlzebra/integration/" + session.SessionID
	runGitCmd(t, fixture.openProject, "update-ref", legacyRef, session.DestinationOID)
	if err := store.save(session); err != nil {
		t.Fatal(err)
	}
	if err := verifyIntegrationOwnership(runner, session.WorkspacePath, session.SessionID); err != nil {
		t.Fatalf("legacy review was not recovered: %v", err)
	}
	if err := cancelIntegrationSession(runner, store, session); err != nil {
		t.Fatal(err)
	}
	if _, err := runGitAllowFail(t, fixture.openProject, "rev-parse", "--verify", legacyRef); err == nil {
		t.Fatal("legacy result ref survived cancellation")
	}
	if _, err := os.Stat(session.WorkspacePath); !os.IsNotExist(err) {
		t.Fatalf("legacy workspace survived cancellation: %v", err)
	}
}

// Phase 1 exit criterion: creating and cancelling leaves no worktree, no lock,
// no metadata file, and no ref behind, and cancelling twice is a no-op.
func TestIntegrationSessionCancelLeavesNothingBehind(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)
	integrationDir := t.TempDir()
	store := newIntegrationSessionStore(integrationDir)
	runner := NewCommandRunner()

	session := newTestSession(t, fixture, integrationDir)
	session.ResultOID = revParse(t, fixture.openProject, fixture.destination)
	if err := store.save(session); err != nil {
		t.Fatalf("save session: %v", err)
	}
	ref, err := integrationResultRef(session.SessionID)
	if err != nil {
		t.Fatalf("result ref: %v", err)
	}
	runGitCmd(t, fixture.openProject, "update-ref", ref, session.ResultOID)

	for attempt := 0; attempt < 2; attempt++ {
		if err := cancelIntegrationSession(runner, store, session); err != nil {
			t.Fatalf("cancel attempt %d: %v", attempt, err)
		}
	}

	if _, err := os.Stat(session.WorkspacePath); !os.IsNotExist(err) {
		t.Fatal("expected the workspace directory to be gone")
	}
	if worktrees := runGitOutput(t, fixture.openProject, "worktree", "list", "--porcelain"); strings.Contains(worktrees, session.WorkspacePath) {
		t.Fatalf("expected no registered workspace:\n%s", worktrees)
	}
	if _, err := store.load(session.SessionID); !os.IsNotExist(err) {
		t.Fatalf("expected the session record to be gone, got %v", err)
	}
	if _, err := runGitAllowFail(t, fixture.openProject, "rev-parse", "--verify", ref); err == nil {
		t.Fatal("expected the prepared result ref to be gone")
	}

	// The user's project is untouched.
	if status := strings.TrimSpace(runGitOutput(t, fixture.openProject, "status", "--porcelain")); status != "" {
		t.Fatalf("expected a clean project, got:\n%s", status)
	}
}

func TestInspectDestinationTreeMeasuresContent(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)
	commitFileAt(t, fixture.openProject, "deeply/nested/directory/report.txt", "0123456789", "add nested file")

	stats, err := inspectDestinationTree(NewCommandRunner(), fixture.openProject, revParse(t, fixture.openProject, "HEAD"))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if stats.trackedFileCount != 2 {
		t.Fatalf("expected 2 tracked files, got %d", stats.trackedFileCount)
	}
	if stats.longestPathLen != len("deeply/nested/directory/report.txt") {
		t.Fatalf("unexpected longest path length %d", stats.longestPathLen)
	}
	if stats.totalBytes != uint64(len("base\n")+10) {
		t.Fatalf("unexpected total bytes %d", stats.totalBytes)
	}
	if stats.hasSubmodules {
		t.Fatal("did not expect submodules")
	}
}

func TestAvailableDiskBytesForPathWalksToAnExistingAncestor(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does", "not", "exist", "yet")
	available, err := availableDiskBytesForPath(missing)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if available == 0 {
		t.Fatal("expected a non-zero amount of free space")
	}
}

func TestReconcileKeepsIntactSessionsAndFlagsDamagedOnes(t *testing.T) {
	fixture := newLinkedWorktreeRepo(t)
	integrationDir := t.TempDir()
	store := newIntegrationSessionStore(integrationDir)
	runner := NewCommandRunner()

	intact := newTestSession(t, fixture, integrationDir)
	if err := store.save(intact); err != nil {
		t.Fatalf("save intact: %v", err)
	}

	damaged := newTestSession(t, fixture, integrationDir)
	if err := store.save(damaged); err != nil {
		t.Fatalf("save damaged: %v", err)
	}
	// Simulate the OS reclaiming the workspace under an active review.
	if err := forceRemoveIntegrationWorkspace(runner, fixture.openProject, damaged.WorkspacePath); err != nil {
		t.Fatalf("remove damaged workspace: %v", err)
	}

	finished := newTestSession(t, fixture, integrationDir)
	finished.State = integrationStateCompleted
	if err := store.save(finished); err != nil {
		t.Fatalf("save finished: %v", err)
	}

	outcomes, err := reconcileIntegrationSessions(runner, store)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	byID := map[string]integrationReconcileOutcome{}
	for _, outcome := range outcomes {
		byID[outcome.SessionID] = outcome
	}
	if byID[intact.SessionID].State != integrationStateReady {
		t.Fatalf("expected the intact session to survive, got %+v", byID[intact.SessionID])
	}
	if byID[damaged.SessionID].State != integrationStateFailed || byID[damaged.SessionID].Reason == "" {
		t.Fatalf("expected the damaged session to be flagged, got %+v", byID[damaged.SessionID])
	}
	if !byID[finished.SessionID].Discarded {
		t.Fatalf("expected the finished session to be discarded, got %+v", byID[finished.SessionID])
	}

	if _, err := store.load(finished.SessionID); !os.IsNotExist(err) {
		t.Fatalf("expected the finished record to be removed, got %v", err)
	}
	reloaded, err := store.load(damaged.SessionID)
	if err != nil {
		t.Fatalf("expected the damaged record to be kept for recovery: %v", err)
	}
	if reloaded.State != integrationStateFailed {
		t.Fatalf("expected a persisted failed state, got %s", reloaded.State)
	}

	// Reconciliation must never move a ref.
	if head := revParse(t, fixture.openProject, fixture.destination); head != intact.DestinationOID {
		t.Fatalf("reconciliation moved the destination to %s", head)
	}
}
