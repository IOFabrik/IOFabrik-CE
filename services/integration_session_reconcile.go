package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// After a crash or a restart, persisted sessions and the worktrees and refs
// they describe can disagree. Reconciliation reports that disagreement; it
// never resolves it by moving a ref. The user decides what happens to their
// work, always.

// integrationSessionTerminalStates are finished sessions whose records exist
// only until the next startup.
var integrationSessionTerminalStates = map[string]bool{
	integrationStateCompleted: true,
	integrationStateShared:    true,
	integrationStateCancelled: true,
}

// integrationReconcileOutcome describes what happened to one persisted session.
type integrationReconcileOutcome struct {
	SessionID string `json:"sessionId"`
	State     string `json:"state"`
	Discarded bool   `json:"discarded"`
	Reason    string `json:"reason,omitempty"`
}

// reconcileIntegrationSessions pairs every persisted session with the workspace
// and result ref it claims. A session whose workspace is missing, unowned, or
// whose prepared result has vanished becomes a recoverable failure the user is
// told about, rather than something this function silently repairs.
func reconcileIntegrationSessions(runner gitAdminPathRunner, store *integrationSessionStore) ([]integrationReconcileOutcome, error) {
	if err := cleanSchemaV1Sessions(runner, store); err != nil {
		return nil, err
	}

	sessions, err := store.list()
	if err != nil {
		return nil, err
	}

	outcomes := make([]integrationReconcileOutcome, 0, len(sessions))
	for _, session := range sessions {
		if integrationSessionTerminalStates[session.State] {
			if err := store.delete(session.SessionID); err != nil {
				return nil, err
			}
			outcomes = append(outcomes, integrationReconcileOutcome{
				SessionID: session.SessionID,
				State:     session.State,
				Discarded: true,
			})
			continue
		}
		if session.State == integrationStateSharing {
			session.State = integrationStateUpdated
			session.Error = "Sharing was interrupted. Choose Share updated work to try again."
			session.UpdatedAt = time.Now().Unix()
			if err := store.save(session); err != nil {
				return nil, err
			}
		}
		if sessionIsDefaultSync(session) && session.State == integrationStateStarting {
			reconcileRunner, ok := runner.(defaultSyncReconcileGit)
			if !ok {
				session.State = integrationStateFailed
				session.Error = "The interrupted default-branch Sync could not be verified. Use repository recovery to inspect it."
			} else {
				updated, needsDecisions, reconcileErr := reconcileDefaultSyncPull(reconcileRunner, session)
				session = updated
				if reconcileErr != nil {
					session.State = integrationStateFailed
					session.Error = "The interrupted default-branch Sync could not be verified. Use repository recovery to inspect it."
				} else if !needsDecisions {
					recovered, recoverErr := recoverCompletedDefaultSync(runner, session)
					session = recovered
					if recoverErr != nil {
						session.State = integrationStateFailed
						session.Error = "The interrupted default-branch Sync could not be verified. Use repository recovery to inspect it."
					}
				}
			}
			session.UpdatedAt = time.Now().Unix()
			if err := store.save(session); err != nil {
				return nil, err
			}
		}

		reason := integrationSessionDamage(runner, session)
		if reason == "" {
			outcomes = append(outcomes, integrationReconcileOutcome{
				SessionID: session.SessionID,
				State:     session.State,
			})
			continue
		}

		session.State = integrationStateFailed
		session.Error = reason
		session.UpdatedAt = time.Now().Unix()
		if err := store.save(session); err != nil {
			return nil, err
		}
		outcomes = append(outcomes, integrationReconcileOutcome{
			SessionID: session.SessionID,
			State:     integrationStateFailed,
			Reason:    reason,
		})
	}
	return outcomes, nil
}

// integrationSessionDamage returns a plain-English reason the session can no
// longer be trusted, or an empty string when it is intact.
func integrationSessionDamage(runner gitAdminPathRunner, session integrationSession) string {
	if strings.TrimSpace(session.OpenProjectPath) == "" {
		return "This review lost track of its project."
	}
	if sessionIsUpdate(session) {
		return integrationUpdateSessionDamage(runner, session)
	}
	if err := verifyIntegrationOwnership(runner, session.WorkspacePath, session.SessionID); err != nil {
		return "The files this review was using are gone."
	}
	if session.ResultOID != "" && !revisionExists(runner, session.OpenProjectPath, session.ResultOID) {
		return "The prepared result for this review is no longer available."
	}
	if !revisionExists(runner, session.OpenProjectPath, session.DestinationOID) ||
		!revisionExists(runner, session.OpenProjectPath, session.SourceOID) {
		return "The saved work this review was based on is no longer available."
	}
	return ""
}

// integrationUpdateSessionDamage reconciles a pivot update against the open
// project's real merge state. It reports damage; it never moves a ref.
func integrationUpdateSessionDamage(runner gitAdminPathRunner, session integrationSession) string {
	if !revisionExists(runner, session.OpenProjectPath, session.FeatureOIDBeforeMerge) {
		return "The saved work this update was based on is no longer available."
	}
	switch session.State {
	case integrationStateNeedsDecisions:
		if !mergeInProgress(runner, session.OpenProjectPath) {
			return "This update was interrupted before it finished. Check for shared updates again."
		}
	case integrationStateUpdated, integrationStateSharing, integrationStateShared:
		if !revisionExists(runner, session.OpenProjectPath, session.FeatureOIDAfterMerge) {
			return "The updated work for this review is no longer available."
		}
	}
	return ""
}

// cleanSchemaV1Sessions removes prepared-result records written before the
// pivot schema bump. They are deleted without ever being applied: their
// workspace and private result ref are cleaned first, then the record file.
func cleanSchemaV1Sessions(runner gitAdminPathRunner, store *integrationSessionStore) error {
	entries, err := os.ReadDir(store.root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to read the session directory: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(store.root, entry.Name())
		payload, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var record legacySchemaRecord
		if err := json.Unmarshal(payload, &record); err != nil {
			continue
		}
		if record.SchemaVersion >= integrationSessionSchemaVersion {
			continue
		}

		if strings.TrimSpace(record.OpenProjectPath) != "" {
			if strings.TrimSpace(record.WorkspacePath) != "" {
				forceRemoveIntegrationWorkspace(runner, record.OpenProjectPath, record.WorkspacePath)
			}
			if ref, err := integrationResultRef(record.SessionID); err == nil {
				runner.RunGit(record.OpenProjectPath, "update-ref", "-d", ref)
				runner.RunGit(record.OpenProjectPath, "update-ref", "-d", "refs/controlzebra/integration/"+record.SessionID)
			}
		}
		os.Remove(path)
	}
	return nil
}

func deleteIntegrationResultRefs(runner gitAdminPathRunner, repoPath, sessionID string) error {
	ref, err := integrationResultRef(sessionID)
	if err != nil {
		return err
	}
	runner.RunGit(repoPath, "update-ref", "-d", ref)
	runner.RunGit(repoPath, "update-ref", "-d", "refs/controlzebra/integration/"+sessionID)
	return nil
}

// legacySchemaRecord is the minimal shape needed to clean a pre-pivot record
// whose full schema this build no longer parses.
type legacySchemaRecord struct {
	SchemaVersion   int    `json:"schemaVersion"`
	SessionID       string `json:"sessionId"`
	OpenProjectPath string `json:"openProjectPath"`
	WorkspacePath   string `json:"workspacePath"`
}

func revisionExists(runner gitAdminPathRunner, repoPath string, oid string) bool {
	if strings.TrimSpace(oid) == "" {
		return false
	}
	return runner.RunGit(repoPath, "cat-file", "-e", oid+"^{commit}").Success
}

// integrationResultRef is the private namespace a prepared result lives in,
// deliberately outside refs/heads so it is unreachable from any branch.
func integrationResultRef(sessionID string) (string, error) {
	if !isValidIntegrationSessionID(sessionID) {
		return "", fmt.Errorf("invalid session id")
	}
	return "refs/iofabrik/integration/" + sessionID, nil
}
