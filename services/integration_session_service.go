package services

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// IntegrationSessionService prepares and applies isolated integration results.
//
// Everything it does happens in a backend-owned worktree, so the user's open
// project is never left in an unmerged state. Preparation answers one question
// -- can this exact saved revision be combined with this exact destination
// revision -- and Finish applies an already prepared answer rather than
// redoing the work.

// IntegrationSessionChangedEvent carries a full session snapshot to the
// frontend. Every emission is self-contained; the frontend never merges deltas.
const IntegrationSessionChangedEvent = "integrationSession:changed"

// integrationSessionOutcomeMessages is the user-facing wording for every state
// the workflow can report. Two parts each: what happened, then a next step.
// Locked down in Phase 0 and enforced by tests in
// integration_session_messages_test.go.
var integrationSessionOutcomeMessages = map[string]string{
	integrationStateScheduled:      "Your saved work is waiting for a shared update check. Keep working until the check starts.",
	integrationStateFetching:       "IOFabrik is checking for shared updates. Keep this project open until the check finishes.",
	integrationStateStarting:       "Shared updates are ready to be added to your work. Keep this project open while the update starts.",
	integrationStateNeedsDecisions: "Some files were changed in both your work and the shared project. Open Conflict Review to choose what to keep in each file.",
	integrationStateCommitting:     "Your file decisions are complete, and IOFabrik is updating your work. Keep this project open until it finishes.",
	integrationStateUpdated:        "Your work is up to date with the shared project. Review it, then choose Share updated work when you are ready.",
	integrationStateSharing:        "IOFabrik is sharing your updated work. Keep this project open until sharing finishes.",
	integrationStateShared:         "Your updated work was shared successfully. You can keep working on this project as usual.",
	integrationStateBlocked:        "Shared updates could not be added because this project changed. Save or discard those changes, then check again.",
	integrationStateCancelling:     "IOFabrik is cancelling the update and restoring your work. Keep this project open until restoration finishes.",
	integrationStateCancelled:      "The update was cancelled, and your work was restored. Check your files before continuing.",
	integrationStateFailed:         "The update could not finish safely. Check your files, then try again or contact support.",
}

// integrationGit is the slice of GitService the session service needs: the
// rules that pick the destination branch, and the conflict resolution core.
// Keeping it narrow lets tests drive the service without the rest of GitService.
type integrationGit interface {
	mergeTargetRef(repoPath string) (branch string, ref string, ok bool)
	conflictResolutionData(repoPath string, filePath string, inOperation bool) ConflictResolutionData
	resolveConflictWithContent(repoPath string, filePath string, resolutionToken string, content string, inOperation bool) OperationResult
	resolveConflictWithDecisions(repoPath string, filePath string, resolutionToken string, decisions []ConflictDecision, inOperation bool) OperationResult
	resolveConflictWithStage(repoPath string, filePath string, stage int, sideName string, inOperation bool) OperationResult
}

// IntegrationSessionSnapshot is the complete state the frontend sees. It
// deliberately carries no filesystem path: temporary workspace locations never
// cross the Wails boundary.
type IntegrationSessionSnapshot struct {
	SessionID      string `json:"sessionId"`
	State          string `json:"state"`
	Message        string `json:"message"`
	SourceBranch   string `json:"sourceBranch"`
	SourceOID      string `json:"sourceOid"`
	TargetBranch   string `json:"targetBranch"`
	DestinationOID string `json:"destinationOid"`
	UpdateKind     string `json:"updateKind,omitempty"`
	Generation     uint64 `json:"generation"`
	HasResult      bool   `json:"hasResult"`
	Active         bool   `json:"active"`
	Error          string `json:"error,omitempty"`
	UpdatedAt      int64  `json:"updatedAt"`
}

// integrationGitTimeout bounds every git call this service makes. Preparation
// materializes a whole tree and merges it, and Finish writes that tree into the
// user's project, so the 30-second default is wrong for a large LFS project.
const integrationGitTimeout = 5 * time.Minute

type IntegrationSessionService struct {
	app      *application.App
	git      *CommandRunner
	target   integrationGit
	settings integrationSettings
	store    *integrationSessionStore
	bus      *RepoEventBus

	workspaceRoot string

	// preparing enforces one in-flight preparation per common repository, and
	// scheduled holds the debounce timer per repository path.
	mu        sync.Mutex
	preparing map[string]bool
	scheduled map[string]*time.Timer

	unsubscribe func()

	// Injection points for tests.
	debounce  time.Duration
	afterFunc func(time.Duration, func()) *time.Timer
}

func NewIntegrationSessionService(target integrationGit) *IntegrationSessionService {
	locations := resolveDataLocations()
	runner := NewCommandRunner()
	runner.Timeout = integrationGitTimeout

	return &IntegrationSessionService{
		git:           runner,
		target:        target,
		store:         newIntegrationSessionStore(locations.IntegrationDir),
		workspaceRoot: integrationWorkspaceRoot(locations.IntegrationDir),
		preparing:     map[string]bool{},
		scheduled:     map[string]*time.Timer{},
		debounce:      integrationReadinessDebounce,
		afterFunc:     time.AfterFunc,
	}
}

// SetApp sets the Wails application reference for event emission.
func (s *IntegrationSessionService) SetApp(app *application.App) {
	s.app = app
}

// SetRepoEventBus lets a successful Finish announce that the repository moved,
// so the conflict queue and the file watcher refresh.
func (s *IntegrationSessionService) SetRepoEventBus(bus *RepoEventBus) {
	s.bus = bus
}

// prepareReadinessLegacy runs an authoritative integration check for the work
// currently checked out in repoPath.
//
// It returns an empty snapshot, silently, when there is no destination worth
// checking against: a detached HEAD, an integration branch nobody merges from,
// or a destination that exists only on the remote. Nothing has gone wrong in
// those cases, so there is nothing to report.
func (s *IntegrationSessionService) prepareReadinessLegacy(repoPath string, squashMerge bool) IntegrationSessionSnapshot {
	done := LogMethod("IntegrationSessionService.PrepareReadiness", map[string]interface{}{"repoPath": repoPath, "squashMerge": squashMerge})

	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		done(IntegrationSessionSnapshot{}, nil)
		return IntegrationSessionSnapshot{}
	}

	target, ok := s.resolveTarget(repoPath)
	if !ok {
		done(IntegrationSessionSnapshot{}, nil)
		return IntegrationSessionSnapshot{}
	}

	mode := integrationModeRegular
	if squashMerge {
		mode = integrationModeSquash
	}

	identity := repositoryLockKey(s.git, repoPath)
	if !s.claimPreparation(identity) {
		snapshot := IntegrationSessionSnapshot{State: integrationStatePreparing, Message: integrationSessionOutcomeMessages[integrationStatePreparing]}
		done(snapshot, nil)
		return snapshot
	}
	defer s.releasePreparation(identity)

	if existing, found := s.currentSession(identity); found {
		if s.sessionMatchesTarget(existing, target, mode) && integrationSessionIsUsable(existing) {
			snapshot := s.snapshot(existing)
			done(snapshot, nil)
			return snapshot
		}
		s.replaceSession(existing)
	}

	session, err := s.newSession(repoPath, identity, target, mode)
	if err != nil {
		snapshot := s.failedSnapshot(err)
		done(snapshot, err)
		return snapshot
	}

	entries, err := s.prepare(&session)
	if err != nil {
		session.State = integrationStateFailed
		session.Error = err.Error()
	}
	session.UpdatedAt = time.Now().Unix()
	if saveErr := s.store.save(session); saveErr != nil {
		snapshot := s.failedSnapshot(saveErr)
		done(snapshot, saveErr)
		return snapshot
	}

	snapshot := s.emit(session)
	if session.State == integrationStateNeedsDecisions {
		s.emitConflicts(s.conflictSnapshot(session, entries, nil))
	}
	done(snapshot, nil)
	return snapshot
}

// GetSessionState returns the current state of one session. An unknown session
// id yields an empty snapshot rather than an error, because a session can
// legitimately disappear between the frontend reading it and asking about it.
func (s *IntegrationSessionService) GetSessionState(sessionID string) IntegrationSessionSnapshot {
	session, err := s.store.load(sessionID)
	if err != nil {
		return IntegrationSessionSnapshot{}
	}
	return s.snapshot(session)
}

// ListSessions returns every session belonging to the repository containing
// repoPath, including its linked worktrees.
func (s *IntegrationSessionService) ListSessions(repoPath string) []IntegrationSessionSnapshot {
	snapshots := []IntegrationSessionSnapshot{}
	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		return snapshots
	}

	identity := repositoryLockKey(s.git, repoPath)
	sessions, err := s.store.list()
	if err != nil {
		return snapshots
	}
	for _, session := range sessions {
		if session.RepositoryCommonDir == identity {
			snapshots = append(snapshots, s.snapshot(session))
		}
	}
	return snapshots
}

// FinishSession applies an already prepared result. It never rebuilds the
// merge: if a valid result exists, that result is what gets applied.
func (s *IntegrationSessionService) FinishSession(sessionID string) OperationResult {
	done := LogMethod("IntegrationSessionService.FinishSession", map[string]interface{}{"sessionId": sessionID})

	session, err := s.store.load(sessionID)
	if err != nil {
		result := failedOp("This review is no longer available. Save your work again to start a new check.")
		done(result, err)
		return result
	}

	result := s.finish(&session)
	done(result, nil)
	return result
}

// ShareSession pushes the unchanged feature revision produced by an update.
// The local merge commit remains intact when sharing fails so the user can
// retry without repeating conflict decisions.
func (s *IntegrationSessionService) ShareSession(sessionID string) OperationResult {
	runner := s.git.forGitOperation()
	done := LogMethod("IntegrationSessionService.ShareSession", map[string]interface{}{"sessionId": sessionID})

	session, err := s.store.load(sessionID)
	if err != nil {
		result := failedOp("This update is no longer available. Check for conflicts again before sharing your work.")
		done(result, err)
		return result
	}
	if !sessionIsUpdate(session) || (session.State != integrationStateUpdated && session.State != integrationStateSharing) {
		result := failedOp(s.messageFor(session.State))
		done(result, nil)
		return result
	}

	release := sharedRepositoryCoordinator.lockRepo(session.OpenProjectPath)
	defer release()

	featureOID, ok := s.revision(session.OpenProjectPath, session.SourceRef)
	if !ok || featureOID != session.FeatureOIDAfterMerge {
		result := failedOp("Your work changed after the conflict check. Select Check for conflicts the next time you save, then share the new result.")
		done(result, nil)
		return result
	}
	if err := s.transition(&session, integrationStateSharing, ""); err != nil {
		result := failedOp("IOFabrik couldn't start sharing your work. Keep this project open, then try again.")
		done(result, err)
		return result
	}
	s.emit(session)

	shareRef := strings.TrimSpace(session.ShareRef)
	if shareRef == "" {
		shareRef = session.SourceRef
	}
	refspec := session.FeatureOIDAfterMerge + ":" + shareRef
	push := runner.RunGit(session.OpenProjectPath, "push", session.RemoteName, refspec)
	if !push.Success {
		message := "Your updated work is still saved on this computer. Check your connection and access, then choose Share updated work again."
		if err := s.transition(&session, integrationStateUpdated, message); err != nil {
			result := failedOp("IOFabrik couldn't save the sharing status. Keep this project open, then close and reopen IOFabrik.")
			done(result, err)
			return result
		}
		s.emit(session)
		result := failedOp(message)
		done(result, fmt.Errorf("push updated feature: %s", getErrorMessage(push)))
		return result
	}

	if err := s.transition(&session, integrationStateShared, ""); err != nil {
		result := failedOp("Your work was shared, but IOFabrik couldn't save that status. Refresh the project before sharing again.")
		done(result, err)
		return result
	}
	s.emit(session)
	result := successOp(integrationSessionOutcomeMessages[integrationStateShared])
	done(result, nil)
	return result
}

// CancelSession discards a review. It moves neither branch, and cancelling a
// session that is already gone succeeds.
func (s *IntegrationSessionService) CancelSession(sessionID string) OperationResult {
	done := LogMethod("IntegrationSessionService.CancelSession", map[string]interface{}{"sessionId": sessionID})

	session, err := s.store.load(sessionID)
	if err != nil {
		if os.IsNotExist(err) {
			result := successOp(integrationSessionOutcomeMessages[integrationStateCancelled])
			done(result, nil)
			return result
		}
		result := failedOp("Couldn't cancel this review. Try again in a moment.")
		done(result, err)
		return result
	}

	release := sharedRepositoryCoordinator.lockRepo(session.OpenProjectPath)
	defer release()

	if sessionIsUpdate(session) {
		if err := cancelUpdateSession(s.git, s.store, session); err != nil {
			result := failedOp(err.Error())
			done(result, err)
			return result
		}
		result := successOp(integrationSessionOutcomeMessages[integrationStateCancelled])
		done(result, nil)
		return result
	}

	if err := cancelIntegrationSession(s.git, s.store, session); err != nil {
		result := failedOp("Couldn't fully clean up this review. Close and reopen the project, then try again.")
		done(result, err)
		return result
	}

	result := successOp(integrationSessionOutcomeMessages[integrationStateCancelled])
	done(result, nil)
	return result
}

// RecoverSessions reconciles persisted sessions with the worktrees and refs
// they claim. Called once at startup. It never moves a ref.
func (s *IntegrationSessionService) RecoverSessions() OperationResult {
	done := LogMethod("IntegrationSessionService.RecoverSessions", nil)

	outcomes, err := reconcileIntegrationSessions(s.git, s.store)
	if err != nil {
		result := failedOp("Couldn't check for unfinished reviews. Everything in your projects is unchanged.")
		done(result, err)
		return result
	}

	recovered := 0
	for _, outcome := range outcomes {
		if !outcome.Discarded {
			recovered++
		}
	}
	if recovered == 0 {
		result := successOp("No unfinished reviews were found.")
		done(result, nil)
		return result
	}

	result := successOp(integrationSessionOutcomeMessages["recovered"])
	done(result, nil)
	return result
}

// --- preparation -----------------------------------------------------------

// integrationTarget is the immutable tuple readiness is scoped to.
type integrationTarget struct {
	sourceBranch   string
	sourceRef      string
	sourceOID      string
	targetBranch   string
	destinationRef string
	destinationOID string
	remoteName     string
}

// UpdateFeatureFromDestination starts the update mutation. Session snapshots
// are published through events and the session query methods.
func (s *IntegrationSessionService) UpdateFeatureFromDestination(repoPath string) OperationResult {
	snapshot := s.updateFeatureFromDestination(repoPath)
	if snapshot.State == integrationStateFailed || snapshot.State == integrationStateBlocked {
		return failedOp(snapshot.Error)
	}
	return successOp(snapshot.Message)
}

// updateFeatureFromDestination fetches the selected shared destination and
// merges that exact revision into the feature branch checked out in repoPath.
// It never pushes. A conflicting merge remains active in the open project so
// the existing session-keyed resolution APIs can resolve its real index.
func (s *IntegrationSessionService) updateFeatureFromDestination(repoPath string) IntegrationSessionSnapshot {
	runner := s.git.forGitOperation()
	done := LogMethod("IntegrationSessionService.UpdateFeatureFromDestination", map[string]interface{}{"repoPath": repoPath})
	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		err := fmt.Errorf("No project is open. Open your project, then try again.")
		snapshot := s.failedSnapshot(err)
		done(snapshot, err)
		return snapshot
	}

	target, ok := s.resolveRemoteTarget(repoPath)
	if !ok {
		message := "No shared project could be found. Connect this project to its shared destination, then try again."
		snapshot := s.persistFailedUpdate(repoPath, message)
		done(snapshot, nil)
		return snapshot
	}

	identity := repositoryLockKey(runner, repoPath)
	if !s.claimPreparation(identity) {
		snapshot := IntegrationSessionSnapshot{State: integrationStateFetching, Message: integrationSessionOutcomeMessages[integrationStateFetching]}
		done(snapshot, nil)
		return snapshot
	}
	defer s.releasePreparation(identity)

	release := sharedRepositoryCoordinator.lockRepo(repoPath)
	defer release()
	if existing, found := s.currentSession(identity); found {
		if !integrationSessionIsUsable(existing) {
			if existing.State == integrationStateFailed {
				if err := s.store.delete(existing.SessionID); err != nil {
					snapshot := s.failedUpdateSnapshot()
					done(snapshot, err)
					return snapshot
				}
			}
		} else {
			switch existing.State {
			case integrationStateBlocked:
				if err := s.store.delete(existing.SessionID); err != nil {
					snapshot := s.failedUpdateSnapshot()
					done(snapshot, err)
					return snapshot
				}
			case integrationStateUpdated:
				featureOID, current := s.revision(repoPath, existing.SourceRef)
				if current && featureOID == existing.FeatureOIDAfterMerge {
					snapshot := s.snapshot(existing)
					done(snapshot, nil)
					return snapshot
				}
				if err := s.store.delete(existing.SessionID); err != nil {
					snapshot := s.failedUpdateSnapshot()
					done(snapshot, err)
					return snapshot
				}
			default:
				snapshot := s.snapshot(existing)
				done(snapshot, nil)
				return snapshot
			}
		}
	}

	session, err := s.newUpdateSession(repoPath, identity, target)
	if err != nil {
		snapshot := s.failedSnapshot(err)
		done(snapshot, err)
		return snapshot
	}
	if err := s.store.save(session); err != nil {
		snapshot := s.failedUpdateSnapshot()
		done(snapshot, err)
		return snapshot
	}
	s.emit(session)

	fetchResult := runner.RunGit(repoPath, "fetch", target.remoteName)
	if !fetchResult.Success {
		return s.failUpdate(
			&session,
			"IOFabrik couldn't check for shared updates. Check your connection and sign-in, then try again.",
			fmt.Errorf("fetch shared updates: %s", getErrorMessage(fetchResult)),
			done,
		)
	}

	destinationOID, revisionOK := s.revision(repoPath, target.destinationRef)
	if !revisionOK {
		return s.failUpdate(
			&session,
			"IOFabrik couldn't read the latest shared work. Check that the shared destination still exists, then try again.",
			fmt.Errorf("resolve fetched destination %q", target.destinationRef),
			done,
		)
	}
	session.RemoteDestinationOID = destinationOID
	session.DestinationOID = destinationOID
	session.State = integrationStateStarting
	session.UpdatedAt = time.Now().Unix()
	if err := s.store.save(session); err != nil {
		return s.failUpdate(
			&session,
			"IOFabrik couldn't save the update status. Keep the project open, then close and reopen IOFabrik.",
			err,
			done,
		)
	}
	s.emit(session)

	if err := s.validateUpdateStart(session); err != nil {
		session.State = integrationStateBlocked
		session.Error = err.Error()
		session.UpdatedAt = time.Now().Unix()
		if saveErr := s.store.save(session); saveErr != nil {
			return s.failUpdate(
				&session,
				"IOFabrik couldn't save the update status. Keep the project open, then close and reopen IOFabrik.",
				saveErr,
				done,
			)
		}
		snapshot := s.emit(session)
		done(snapshot, err)
		return snapshot
	}

	mergeResult := runner.RunGit(repoPath, "merge", "--no-edit", destinationOID)
	entries, classifyErr := classifyConflictQueue(runner, repoPath)
	if classifyErr != nil {
		return s.failUpdate(
			&session,
			"IOFabrik couldn't inspect the files needing a decision. Close and reopen the project, then try again.",
			classifyErr,
			done,
		)
	}
	if len(entries) > 0 {
		session.State = integrationStateNeedsDecisions
		session.UpdatedAt = time.Now().Unix()
		if saveErr := s.store.save(session); saveErr != nil {
			return s.failUpdate(
				&session,
				"IOFabrik couldn't save the conflict review. Keep the project open, then close and reopen IOFabrik.",
				saveErr,
				done,
			)
		}
		snapshot := s.emit(session)
		s.emitConflicts(s.conflictSnapshot(session, entries, nil))
		done(snapshot, nil)
		return snapshot
	}
	if !mergeResult.Success {
		return s.failUpdate(
			&session,
			"The update could not finish in this project. Check your project requirements, then try again.",
			fmt.Errorf("merge shared updates: %s", getErrorMessage(mergeResult)),
			done,
		)
	}

	if err := s.finalizeUpdated(&session); err != nil {
		return s.failUpdate(&session, err.Error(), err, done)
	}
	if err := s.store.save(session); err != nil {
		return s.failUpdate(
			&session,
			"IOFabrik couldn't save the completed update status. Keep the project open, then close and reopen IOFabrik.",
			err,
			done,
		)
	}
	s.publishMutation(repoPath)
	snapshot := s.emit(session)
	done(snapshot, nil)
	return snapshot
}

func (s *IntegrationSessionService) resolveRemoteTarget(repoPath string) (integrationTarget, bool) {
	targetBranch, selectedRef, ok := s.target.mergeTargetRef(repoPath)
	if !ok {
		return integrationTarget{}, false
	}

	sourceRefResult := s.git.RunGit(repoPath, "symbolic-ref", "--quiet", "HEAD")
	sourceRef := strings.TrimSpace(sourceRefResult.Stdout)
	if !sourceRefResult.Success || !strings.HasPrefix(sourceRef, "refs/heads/") {
		return integrationTarget{}, false
	}
	sourceOID, ok := s.revision(repoPath, sourceRef)
	if !ok {
		return integrationTarget{}, false
	}

	remoteName, remoteRef, ok := integrationRemoteRef(selectedRef, targetBranch)
	if !ok {
		return integrationTarget{}, false
	}
	return integrationTarget{
		sourceBranch:   strings.TrimPrefix(sourceRef, "refs/heads/"),
		sourceRef:      sourceRef,
		sourceOID:      sourceOID,
		targetBranch:   targetBranch,
		destinationRef: remoteRef,
		remoteName:     remoteName,
	}, true
}

func integrationRemoteRef(selectedRef string, targetBranch string) (string, string, bool) {
	ref := strings.TrimSpace(selectedRef)
	ref = strings.TrimPrefix(ref, "refs/remotes/")
	remoteName, branch, found := strings.Cut(ref, "/")
	if !found || remoteName == "" || branch != targetBranch {
		return "", "", false
	}
	return remoteName, "refs/remotes/" + remoteName + "/" + branch, true
}

func (s *IntegrationSessionService) newUpdateSession(repoPath string, identity string, target integrationTarget) (integrationSession, error) {
	sessionID, err := newIntegrationSessionID()
	if err != nil {
		return integrationSession{}, err
	}
	now := time.Now().Unix()
	return integrationSession{
		SessionID:             sessionID,
		RepositoryCommonDir:   identity,
		OpenProjectPath:       repoPath,
		OperationKind:         "merge",
		UpdateKind:            integrationUpdateKindFeature,
		SourceRef:             target.sourceRef,
		SourceOID:             target.sourceOID,
		DestinationRef:        target.destinationRef,
		RemoteName:            target.remoteName,
		RemoteDestinationRef:  target.destinationRef,
		FeatureOIDBeforeMerge: target.sourceOID,
		ShareRef:              target.sourceRef,
		State:                 integrationStateFetching,
		Generation:            uint64(now),
		CreatedAt:             now,
		UpdatedAt:             now,
	}, nil
}

func (s *IntegrationSessionService) validateUpdateStart(session integrationSession) error {
	currentRef := strings.TrimSpace(s.git.RunGit(session.OpenProjectPath, "symbolic-ref", "--quiet", "HEAD").Stdout)
	if currentRef != session.SourceRef {
		return fmt.Errorf("this project switched after saving. Switch back to your saved work, then try again")
	}
	currentOID, ok := s.revision(session.OpenProjectPath, session.SourceRef)
	if !ok || currentOID != session.FeatureOIDBeforeMerge {
		return fmt.Errorf("your saved work changed before the update started. Save again, then retry")
	}
	remoteOID, ok := s.revision(session.OpenProjectPath, session.RemoteDestinationRef)
	if !ok || remoteOID != session.RemoteDestinationOID {
		return fmt.Errorf("the shared project changed before the update started. Check for shared updates again")
	}
	status := s.git.RunGit(session.OpenProjectPath, "status", "--porcelain")
	if !status.Success || strings.TrimSpace(status.Stdout) != "" {
		return fmt.Errorf("this project has unsaved files. Save or discard them, then try again")
	}
	return nil
}

func (s *IntegrationSessionService) failUpdate(
	session *integrationSession,
	userError string,
	cause error,
	done func(interface{}, error),
) IntegrationSessionSnapshot {
	session.State = integrationStateFailed
	session.Error = userError
	session.UpdatedAt = time.Now().Unix()
	if saveErr := s.store.save(*session); saveErr != nil {
		cause = fmt.Errorf("%w; save failed update state: %v", cause, saveErr)
	}
	snapshot := s.emit(*session)
	done(snapshot, cause)
	return snapshot
}

func (s *IntegrationSessionService) failedUpdateSnapshot() IntegrationSessionSnapshot {
	return IntegrationSessionSnapshot{
		State:     integrationStateFailed,
		Message:   integrationSessionOutcomeMessages[integrationStateFailed],
		Error:     "IOFabrik couldn't save the update status. Close and reopen IOFabrik, then try again.",
		UpdatedAt: time.Now().Unix(),
	}
}

func (s *IntegrationSessionService) persistFailedUpdate(repoPath string, userError string) IntegrationSessionSnapshot {
	identity := repositoryLockKey(s.git, repoPath)
	if existing, found := s.currentSession(identity); found {
		if integrationSessionIsUsable(existing) {
			return s.snapshot(existing)
		}
		if err := s.store.delete(existing.SessionID); err != nil {
			return s.failedUpdateSnapshot()
		}
	}

	sessionID, err := newIntegrationSessionID()
	if err != nil {
		return s.failedSnapshot(err)
	}
	sourceRef := strings.TrimSpace(s.git.RunGit(repoPath, "symbolic-ref", "--quiet", "HEAD").Stdout)
	sourceOID, _ := s.revision(repoPath, sourceRef)
	now := time.Now().Unix()
	session := integrationSession{
		SessionID:             sessionID,
		RepositoryCommonDir:   identity,
		OpenProjectPath:       repoPath,
		OperationKind:         "merge",
		SourceRef:             sourceRef,
		SourceOID:             sourceOID,
		FeatureOIDBeforeMerge: sourceOID,
		State:                 integrationStateFailed,
		Generation:            uint64(now),
		Error:                 userError,
		CreatedAt:             now,
		UpdatedAt:             now,
	}
	if err := s.store.save(session); err != nil {
		return s.failedUpdateSnapshot()
	}
	return s.emit(session)
}

// completeUpdate creates the merge commit once every conflicted file has a
// decision. It re-scans authoritatively rather than trusting the caller, then
// runs git commit --no-edit in the open project so the real merge finishes.
func (s *IntegrationSessionService) completeUpdate(session *integrationSession) error {
	repo := session.OpenProjectPath

	entries, err := classifyConflictQueue(s.git, repo)
	if err != nil {
		return fmt.Errorf("IOFabrik couldn't inspect the files needing a decision. Close and reopen the project, then try again.")
	}
	if len(entries) > 0 {
		return fmt.Errorf("some files still need a decision")
	}

	session.State = integrationStateCommitting
	session.UpdatedAt = time.Now().Unix()
	if saveErr := s.store.save(*session); saveErr != nil {
		return fmt.Errorf("IOFabrik couldn't save the update status. Keep the project open, then close and reopen IOFabrik.")
	}
	s.emit(*session)

	commit := s.git.RunGit(repo, "commit", "--no-edit")
	if !commit.Success {
		return fmt.Errorf("The update could not finish in this project. Check your project requirements, then try again.")
	}

	return s.finalizeUpdated(session)
}

// finalizeUpdated verifies the merge topology and feature ref, then records the
// completed update. It is shared by the conflict-free path and the resolved
// path so both reach state updated only after the same checks pass.
func (s *IntegrationSessionService) finalizeUpdated(session *integrationSession) error {
	afterOID, ok := s.revision(session.OpenProjectPath, session.SourceRef)
	if !ok {
		return fmt.Errorf("IOFabrik couldn't verify the updated work. Close and reopen the project before continuing.")
	}
	if afterOID == session.FeatureOIDBeforeMerge {
		containsShared := s.git.RunGit(
			session.OpenProjectPath,
			"merge-base",
			"--is-ancestor",
			session.RemoteDestinationOID,
			afterOID,
		).Success
		if !containsShared {
			return fmt.Errorf("The updated work doesn't include the shared updates as expected. Close and reopen the project, then check your files.")
		}
	} else {
		if session.UpdateKind == integrationUpdateKindDefaultSync {
			if err := s.verifyDefaultSyncTopology(session.OpenProjectPath, *session, afterOID); err != nil {
				return err
			}
		} else if err := s.verifyUpdateTopology(session.OpenProjectPath, *session, afterOID); err != nil {
			return err
		}
	}
	session.FeatureOIDAfterMerge = afterOID
	session.ResultOID = afterOID
	session.State = integrationStateUpdated
	session.UpdatedAt = time.Now().Unix()
	return nil
}

// verifyDefaultSyncTopology requires a conflicted pull to finish as the exact
// two-parent merge Git started: the captured local revision first and the
// fetched upstream default revision second.
func (s *IntegrationSessionService) verifyDefaultSyncTopology(repo string, session integrationSession, afterOID string) error {
	if err := s.verifyUpdateTopology(repo, session, afterOID); err != nil {
		return err
	}
	containsUpstream := s.git.RunGit(repo, "merge-base", "--is-ancestor", session.RemoteDestinationOID, afterOID).Success
	if !containsUpstream {
		return fmt.Errorf("The updated default branch doesn't include the fetched shared work. Close and reopen the project, then check your files.")
	}
	return nil
}

// verifyUpdateTopology confirms the merge commit combines exactly the work this
// session captured: first parent the feature before the merge, second parent
// the fetched shared destination. A mismatch means something else moved the
// feature branch, so the update is not trusted.
func (s *IntegrationSessionService) verifyUpdateTopology(repo string, session integrationSession, afterOID string) error {
	first, ok := s.revision(repo, afterOID+"^1")
	if !ok || first != session.FeatureOIDBeforeMerge {
		return fmt.Errorf("The updated work doesn't include your saved work as expected. Close and reopen the project, then check your files.")
	}
	second, ok := s.revision(repo, afterOID+"^2")
	if !ok || second != session.RemoteDestinationOID {
		return fmt.Errorf("The updated work doesn't include the shared updates as expected. Close and reopen the project, then check your files.")
	}
	return nil
}

// resolveTarget captures local revisions only. Phase 2 does not fetch, so a
// readiness result describes the destination as this computer currently knows
// it. A destination that moved is detected at Finish and refreshes the review.
func (s *IntegrationSessionService) resolveTarget(repoPath string) (integrationTarget, bool) {
	targetBranch, _, ok := s.target.mergeTargetRef(repoPath)
	if !ok {
		return integrationTarget{}, false
	}

	sourceRefResult := s.git.RunGit(repoPath, "symbolic-ref", "--quiet", "HEAD")
	sourceRef := strings.TrimSpace(sourceRefResult.Stdout)
	if !sourceRefResult.Success || sourceRef == "" {
		return integrationTarget{}, false
	}

	// The local branch is the only thing Finish can update, so a destination
	// that exists only on the remote is not a destination yet.
	destinationRef := "refs/heads/" + targetBranch
	destinationOID, ok := s.revision(repoPath, destinationRef)
	if !ok {
		return integrationTarget{}, false
	}
	sourceOID, ok := s.revision(repoPath, sourceRef)
	if !ok {
		return integrationTarget{}, false
	}

	return integrationTarget{
		sourceBranch:   strings.TrimPrefix(sourceRef, "refs/heads/"),
		sourceRef:      sourceRef,
		sourceOID:      sourceOID,
		targetBranch:   targetBranch,
		destinationRef: destinationRef,
		destinationOID: destinationOID,
	}, true
}

func (s *IntegrationSessionService) revision(repoPath string, rev string) (string, bool) {
	result := s.git.RunGit(repoPath, "rev-parse", "--verify", "--quiet", rev+"^{commit}")
	oid := strings.TrimSpace(result.Stdout)
	return oid, result.Success && oid != ""
}

func (s *IntegrationSessionService) newSession(repoPath string, identity string, target integrationTarget, mode string) (integrationSession, error) {
	sessionID, err := newIntegrationSessionID()
	if err != nil {
		return integrationSession{}, err
	}

	now := time.Now().Unix()
	return integrationSession{
		SessionID:           sessionID,
		RepositoryCommonDir: identity,
		OpenProjectPath:     repoPath,
		WorkspacePath:       filepath.Join(s.workspaceRoot, sessionID),
		OperationKind:       "merge",
		MergeMode:           mode,
		SourceRef:           target.sourceRef,
		SourceOID:           target.sourceOID,
		DestinationRef:      target.destinationRef,
		DestinationOID:      target.destinationOID,
		State:               integrationStatePreparing,
		Generation:          uint64(now),
		CreatedAt:           now,
		UpdatedAt:           now,
	}, nil
}

// prepare materializes the workspace, runs the real merge, and classifies the
// outcome. On any failure the workspace is unwound so nothing is left behind.
// The classified entries come back so the caller can publish them without
// rescanning.
func (s *IntegrationSessionService) prepare(session *integrationSession) ([]ConflictQueueEntry, error) {
	runner := s.git.forGitOperation()
	empty := []ConflictQueueEntry{}

	// Work already contained in the destination has nothing to integrate. The
	// destination revision is its own result, so Finish becomes a no-op rather
	// than an empty merge commit nobody asked for.
	if runner.RunGit(session.OpenProjectPath, "merge-base", "--is-ancestor", session.SourceOID, session.DestinationOID).Success {
		session.State = integrationStateReady
		session.ResultOID = session.DestinationOID
		return empty, nil
	}

	if err := createIntegrationWorkspace(runner, session.OpenProjectPath, session.SessionID, session.DestinationOID, session.WorkspacePath); err != nil {
		return empty, err
	}

	args := []string{"merge", "--no-commit", "--no-ff", session.SourceOID}
	if session.MergeMode == integrationModeSquash {
		args = []string{"merge", "--squash", session.SourceOID}
	}
	mergeResult := runner.RunGit(session.WorkspacePath, args...)

	entries, err := classifyConflictQueue(runner, session.WorkspacePath)
	if err != nil {
		forceRemoveIntegrationWorkspace(runner, session.OpenProjectPath, session.WorkspacePath)
		return empty, fmt.Errorf("failed to inspect the checked files: %w", err)
	}
	if len(entries) > 0 {
		session.State = integrationStateNeedsDecisions
		return entries, nil
	}
	if !mergeResult.Success {
		// No unmerged files, so this was a real failure rather than a conflict.
		forceRemoveIntegrationWorkspace(runner, session.OpenProjectPath, session.WorkspacePath)
		return empty, fmt.Errorf("failed to check this work against the shared project: %s", getErrorMessage(mergeResult))
	}

	return empty, s.createResult(session)
}

// createResult writes the prepared result into the private integration
// namespace. commit-tree is the primitive because it takes explicit parents and
// cannot run repository hooks, so a project's pre-commit hook never sees a
// commit the user did not make.
func (s *IntegrationSessionService) createResult(session *integrationSession) error {
	// A result may only be built from a fully resolved workspace, so every
	// caller pays for one authoritative check rather than trusting its own.
	entries, err := classifyConflictQueue(s.git, session.WorkspacePath)
	if err != nil {
		return fmt.Errorf("failed to inspect the checked files: %w", err)
	}
	if len(entries) > 0 {
		return fmt.Errorf("some files still need a decision")
	}

	treeResult := s.git.RunGit(session.WorkspacePath, "write-tree")
	treeOID := strings.TrimSpace(treeResult.Stdout)
	if !treeResult.Success || treeOID == "" {
		return fmt.Errorf("failed to prepare the combined files: %s", getErrorMessage(treeResult))
	}

	args := []string{"commit-tree", treeOID, "-p", session.DestinationOID}
	if session.MergeMode == integrationModeRegular {
		args = append(args, "-p", session.SourceOID)
	}
	args = append(args, "-m", integrationResultMessage(*session))

	commitResult := s.git.RunGit(session.WorkspacePath, args...)
	resultOID := strings.TrimSpace(commitResult.Stdout)
	if !commitResult.Success || resultOID == "" {
		return fmt.Errorf("failed to prepare the combined result: %s", getErrorMessage(commitResult))
	}

	ref, err := integrationResultRef(session.SessionID)
	if err != nil {
		return err
	}
	if updateResult := s.git.RunGit(session.OpenProjectPath, "update-ref", ref, resultOID); !updateResult.Success {
		return fmt.Errorf("failed to store the prepared result: %s", getErrorMessage(updateResult))
	}

	session.ResultOID = resultOID
	session.State = integrationStateReady
	return nil
}

func integrationResultMessage(session integrationSession) string {
	source := strings.TrimPrefix(session.SourceRef, "refs/heads/")
	destination := strings.TrimPrefix(session.DestinationRef, "refs/heads/")
	if session.MergeMode == integrationModeSquash {
		return fmt.Sprintf("Squashed changes from %s into %s", source, destination)
	}
	return fmt.Sprintf("Merge %s into %s", source, destination)
}

// --- finish ----------------------------------------------------------------

// finish is the ten-step protocol. Numbered comments map to the plan.
func (s *IntegrationSessionService) finish(session *integrationSession) OperationResult {
	// 1. The session must hold a prepared result.
	if session.State != integrationStateReady && session.State != integrationStateBlocked {
		return failedOp(s.messageFor(session.State))
	}
	if strings.TrimSpace(session.ResultOID) == "" {
		return failedOp("This work hasn't finished being checked yet. Wait for the check to finish, then choose Finish again.")
	}

	// 2. The captured revisions must still be current.
	if !s.revisionsStillMatch(*session) {
		s.replaceSession(*session)
		return failedOp(integrationSessionOutcomeMessages[integrationStateObsolete])
	}

	// 3. Record the attempt before mutating anything, so a crash here is
	// recoverable rather than invisible.
	if err := s.transition(session, integrationStateApplying, ""); err != nil {
		return failedOp("Couldn't start combining your work. Try again in a moment.")
	}

	// 4. Serialize against every other service that can move refs.
	release := sharedRepositoryCoordinator.lockRepo(session.OpenProjectPath)
	defer release()

	owner, err := destinationWorktreePath(s.git, session.OpenProjectPath, session.DestinationRef)
	if err != nil {
		s.transition(session, integrationStateReady, "")
		return failedOp("Couldn't check which project is using the shared work. Try again in a moment.")
	}

	// 5. Revalidate while the lock is held. Steps 2 and 5 are both required:
	// step 2 avoids taking the lock pointlessly, step 5 closes the race.
	if !s.revisionsStillMatch(*session) {
		s.replaceSession(*session)
		return failedOp(integrationSessionOutcomeMessages[integrationStateObsolete])
	}

	// 6, 7, 8. Apply through whichever primitive is safe for this destination.
	if err := s.applyResult(*session, owner); err != nil {
		s.transition(session, integrationStateBlocked, err.Error())
		s.emit(*session)
		return failedOp(err.Error())
	}

	// 9. Verify before declaring success.
	if err := s.verifyApplied(*session, owner); err != nil {
		s.transition(session, integrationStateFailed, err.Error())
		s.emit(*session)
		return failedOp(err.Error())
	}

	// 10. Publish, clean up, and report.
	s.transition(session, integrationStateCompleted, "")
	s.publishMutation(session.OpenProjectPath)
	if owner != "" {
		s.publishMutation(owner)
	}
	s.cleanUpAfterFinish(*session)
	s.emit(*session)

	return successOp(integrationSessionOutcomeMessages[integrationStateCompleted])
}

// applyResult picks the primitive that matches how the destination is being
// used, because no single Git command is correct for all three cases.
func (s *IntegrationSessionService) applyResult(session integrationSession, owner string) error {
	switch {
	case owner == "":
		// Nothing has the destination checked out, so there are no working
		// files to disturb. update-ref with an expected old value is a true
		// compare-and-swap: if anything moved the destination since step 5,
		// this fails instead of overwriting it.
		result := s.git.RunGit(session.OpenProjectPath, "update-ref", session.DestinationRef, session.ResultOID, session.DestinationOID)
		if !result.Success {
			return fmt.Errorf("the shared project changed while we were combining your work. Check your files again, then choose Finish")
		}
		return nil

	case sameWorkingCopy(owner, session.OpenProjectPath):
		// The result was built on the captured destination revision, so a
		// fast-forward updates the ref, files, and staged state together. Git
		// refuses on its own when local work would be replaced, which is
		// stricter and race-free compared with checking first and then merging.
		result := s.git.forGitOperation().RunGit(session.OpenProjectPath, "merge", "--ff-only", session.ResultOID)
		if !result.Success {
			return fmt.Errorf("%s", integrationSessionOutcomeMessages[integrationStateBlocked])
		}
		return nil

	default:
		return fmt.Errorf("another open copy of this project is using the shared work. Close it, then choose Finish again")
	}
}

// verifyApplied confirms the destination really landed where it should, rather
// than trusting the exit code of the command that moved it.
func (s *IntegrationSessionService) verifyApplied(session integrationSession, owner string) error {
	applied, ok := s.revision(session.OpenProjectPath, session.DestinationRef)
	if !ok || applied != session.ResultOID {
		return fmt.Errorf("your work couldn't be combined with the shared project. Nothing was changed, so you can safely try again")
	}
	if owner != "" && !s.git.RunGit(owner, "diff", "--quiet", "HEAD").Success {
		return fmt.Errorf("your files don't match the combined result yet. Close and reopen the project, then check your files")
	}
	return nil
}

// cleanUpAfterFinish removes the workspace and the private result ref. The
// session record itself survives until the next startup, where reconciliation
// discards it, so a crash during cleanup still leaves a trail.
func (s *IntegrationSessionService) cleanUpAfterFinish(session integrationSession) {
	removeIntegrationWorkspace(s.git, session.OpenProjectPath, session.SessionID, session.WorkspacePath)
	deleteIntegrationResultRefs(s.git, session.OpenProjectPath, session.SessionID)
}

// destinationWorktreePath reports which working directory has destinationRef
// checked out, or an empty string when none does.
func destinationWorktreePath(runner gitAdminPathRunner, repoPath string, destinationRef string) (string, error) {
	result := runner.RunGit(repoPath, "worktree", "list", "--porcelain")
	if !result.Success {
		return "", fmt.Errorf("failed to list working copies: %s", getErrorMessage(result))
	}

	current := ""
	for _, line := range strings.Split(result.Stdout, "\n") {
		line = strings.TrimRight(line, "\r")
		if path, found := strings.CutPrefix(line, "worktree "); found {
			current = path
			continue
		}
		if branch, found := strings.CutPrefix(line, "branch "); found && branch == destinationRef {
			return current, nil
		}
	}
	return "", nil
}

// sameWorkingCopy compares two working directory paths. git reports the
// resolved path, so a project opened through a symlink would otherwise look
// like a different project entirely.
func sameWorkingCopy(left string, right string) bool {
	return sameRepositoryPath(normalizeRepositoryKey(left), normalizeRepositoryKey(right))
}

// --- session bookkeeping ---------------------------------------------------

func (s *IntegrationSessionService) revisionsStillMatch(session integrationSession) bool {
	source, sourceOK := s.revision(session.OpenProjectPath, session.SourceRef)
	destination, destinationOK := s.revision(session.OpenProjectPath, session.DestinationRef)
	return sourceOK && destinationOK && source == session.SourceOID && destination == session.DestinationOID
}

func (s *IntegrationSessionService) sessionMatchesTarget(session integrationSession, target integrationTarget, mode string) bool {
	return session.MergeMode == mode &&
		session.SourceRef == target.sourceRef &&
		session.SourceOID == target.sourceOID &&
		session.DestinationRef == target.destinationRef &&
		session.DestinationOID == target.destinationOID
}

// integrationSessionIsUsable reports whether a session still has an answer the
// user can act on, as opposed to one that needs redoing.
func integrationSessionIsUsable(session integrationSession) bool {
	switch session.State {
	case integrationStateFetching,
		integrationStateStarting,
		integrationStateNeedsDecisions,
		integrationStateUpdated,
		integrationStateSharing,
		integrationStateBlocked,
		integrationStateReady:
		return true
	default:
		return false
	}
}

// currentSession returns the newest non-terminal session for a repository.
func (s *IntegrationSessionService) currentSession(identity string) (integrationSession, bool) {
	sessions, err := s.store.list()
	if err != nil {
		return integrationSession{}, false
	}

	found := false
	newest := integrationSession{}
	for _, session := range sessions {
		if session.RepositoryCommonDir != identity || integrationSessionTerminalStates[session.State] {
			continue
		}
		// list is sorted oldest first, so the last match is the newest.
		newest = session
		found = true
	}
	return newest, found
}

// replaceSession retires a session whose answer no longer applies. It is marked
// obsolete before cleanup begins, so a late result can be recognized and
// dropped by session id rather than being mistaken for the current one.
func (s *IntegrationSessionService) replaceSession(session integrationSession) {
	session.State = integrationStateObsolete
	session.UpdatedAt = time.Now().Unix()
	if err := s.store.save(session); err != nil {
		return
	}
	s.emit(session)
	cancelIntegrationSession(s.git, s.store, session)
}

func (s *IntegrationSessionService) transition(session *integrationSession, state string, failure string) error {
	session.State = state
	session.Error = failure
	session.UpdatedAt = time.Now().Unix()
	return s.store.save(*session)
}

func (s *IntegrationSessionService) claimPreparation(identity string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.preparing[identity] {
		return false
	}
	s.preparing[identity] = true
	return true
}

func (s *IntegrationSessionService) releasePreparation(identity string) {
	s.mu.Lock()
	delete(s.preparing, identity)
	s.mu.Unlock()
}

func (s *IntegrationSessionService) publishMutation(repoPath string) {
	if s.bus != nil {
		s.bus.Publish(RepoMutated{RepoPath: repoPath, Reason: RepoMutationMerge})
	}
}

// --- snapshots -------------------------------------------------------------

func (s *IntegrationSessionService) snapshot(session integrationSession) IntegrationSessionSnapshot {
	active := integrationSessionIsUsable(session)
	if sessionIsUpdate(session) && session.State == integrationStateUpdated {
		featureOID, ok := s.revision(session.OpenProjectPath, session.SourceRef)
		active = ok && featureOID == session.FeatureOIDAfterMerge
	}
	return IntegrationSessionSnapshot{
		SessionID:      session.SessionID,
		State:          session.State,
		Message:        s.messageFor(session.State),
		SourceBranch:   strings.TrimPrefix(session.SourceRef, "refs/heads/"),
		SourceOID:      session.SourceOID,
		TargetBranch:   integrationDestinationBranch(session),
		DestinationOID: session.DestinationOID,
		UpdateKind:     session.UpdateKind,
		Generation:     session.Generation,
		HasResult:      strings.TrimSpace(session.ResultOID) != "",
		Active:         active,
		Error:          session.Error,
		UpdatedAt:      session.UpdatedAt,
	}
}

func integrationDestinationBranch(session integrationSession) string {
	if sessionIsDefaultSync(session) {
		remoteTracking := strings.TrimPrefix(session.RemoteDestinationRef, "refs/remotes/")
		if _, branch, found := strings.Cut(remoteTracking, "/"); found {
			return branch
		}
	}
	if session.RemoteName != "" {
		return strings.TrimPrefix(session.RemoteDestinationRef, "refs/remotes/"+session.RemoteName+"/")
	}
	return strings.TrimPrefix(session.DestinationRef, "refs/heads/")
}

func (s *IntegrationSessionService) failedSnapshot(err error) IntegrationSessionSnapshot {
	return IntegrationSessionSnapshot{
		State:     integrationStateFailed,
		Message:   integrationSessionOutcomeMessages[integrationStateFailed],
		Error:     err.Error(),
		UpdatedAt: time.Now().Unix(),
	}
}

func (s *IntegrationSessionService) messageFor(state string) string {
	if message, found := integrationSessionOutcomeMessages[state]; found {
		return message
	}
	return integrationSessionOutcomeMessages[integrationStateFailed]
}

func (s *IntegrationSessionService) emit(session integrationSession) IntegrationSessionSnapshot {
	snapshot := s.snapshot(session)
	if s.app != nil {
		s.app.Event.Emit(IntegrationSessionChangedEvent, snapshot)
	}
	return snapshot
}
