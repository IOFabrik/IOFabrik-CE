/**
 * ExplorerView - Sidebar view showing action panels based on repo state.
 * 
 * Displays contextual panels based on repo state:
 * - No folder: Sidebar renders WelcomeView instead (handled by Sidebar.tsx)
 * - Not a git repo: Initialize option via ExplorerStatusPanel
 * - Has changes: Commit form with changed files
 * - Needs push: Sync/publish prompt with GitHub integration
 * - Feature branch synced: Merge request option
 * - Main branch synced: All caught up
 */
import { memo, useState, useCallback, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { useLayout } from '../../../context';
import { VIEWS } from '../../../shared/constants';
import { useRepo, type FileStatus } from '../../../context';
import { getFolderNameFromPath } from '../../../shared/utils/path';
import SidebarCommitPanel from './SidebarCommitPanel';
import ExplorerStatusPanel from './ExplorerStatusPanel';
import GitHubDeviceFlowModal from '../../auth/components/GitHubDeviceFlowModal';
import CreateChangeRequestDialog from '../../reviews/components/CreateChangeRequestDialog';
import ExplorerTimelineSection from './ExplorerTimelineSection';
import { ConflictQueueSection } from '../../conflict';
import { useIntegrationSession } from '../../integration';

// ============================================================================
// Types
// ============================================================================

type PanelState = 
  | { type: 'noFolder' }
  | { type: 'noRepo'; folderName: string }
  | { type: 'hasChanges'; changedFiles: FileStatus[]; branchName: string }
  | { type: 'push'; ahead: number; hasUpstream: boolean; totalLocalCommits: number }
  | { type: 'featureBranch'; branchName: string }
  | { type: 'synced' };

interface DeviceFlowState {
  isOpen: boolean;
  userCode: string;
  verificationUrl: string;
}

// ============================================================================
// Component
// ============================================================================

function ExplorerView(): JSX.Element {
  const {
    openExplorerTab,
    explorerTabs,
    activeExplorerTab,
    setActiveExplorerTab,
    openExplorerMergeModal,
    setActiveView,
  } = useLayout();
  const { 
    repoPath, 
    repoInfo,
    projectDefaultBranch,
    repoStatus, 
    graphCommits,
    startTracking,
    installRequiredPackages,
    commitChanges,
    branchAndCommit,
    discardFileChanges,
    syncRepo,
    rewindToLastSnapshot,
    isLoading,
    isCommitting,
    isSyncing,
    // Global operation lock
    operationInProgress,
    // Remote state
    hasRemote,
    refreshRemotes,
    // GitHub state
    gitInstalled,
    lfsInstalled,
    isInstallingPackages,
    ghInstalled,
    ghAuthStatus,
    startGitHubLogin,
    publishToGitHub,
    loadUserOrganizations,
    // Change Request creation
    changeRequestCreateEligibility,
    checkChangeRequestCreateEligibility,
    findOpenChangeRequestForBranch,
    selectChangeRequest,
  } = useRepo();
  const {
    enabled: updateWorkflowEnabled,
    session: reviewSession,
    entries: reviewEntries,
    isBusy: isUpdateBusy,
    startUpdate,
  } = useIntegrationSession();
  
  const [isRewinding, setIsRewinding] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isResolvingChangeRequest, setIsResolvingChangeRequest] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({
    isOpen: false,
    userCode: '',
    verificationUrl: '',
  });

  // Derive panel state from repo status
  const panelState = useMemo((): PanelState => {
    if (!repoPath) return { type: 'noFolder' };
    if (!repoInfo?.isRepo) return { type: 'noRepo', folderName: getFolderNameFromPath(repoPath) || '' };
    
    const changedFiles = repoStatus?.changedFiles || [];
    const ahead = repoStatus?.ahead || 0;
    const hasUpstream = repoStatus?.hasUpstream ?? true;
    const totalLocalCommits = repoStatus?.totalLocalCommits || 0;
    const branchName = repoStatus?.branch || '';
    const isDefaultBranch = projectDefaultBranch?.availability === 'ready'
      && branchName === projectDefaultBranch.effectiveBranch;
    const needsPush = ahead > 0 || (!hasUpstream && totalLocalCommits > 0);

    if (reviewSession) {
      return { type: 'featureBranch', branchName };
    }
    if (changedFiles.length > 0) {
      return { type: 'hasChanges', changedFiles, branchName };
    }
    if (needsPush) {
      return { type: 'push', ahead, hasUpstream, totalLocalCommits };
    }
    if (branchName && projectDefaultBranch?.availability === 'ready' && !isDefaultBranch) {
      return { type: 'featureBranch', branchName };
    }
    return { type: 'synced' };
  }, [repoPath, repoInfo?.isRepo, repoStatus, reviewSession, projectDefaultBranch]);

  const handleRewind = useCallback(async (): Promise<boolean> => {
    setIsRewinding(true);
    try {
      return await rewindToLastSnapshot();
    } finally {
      setIsRewinding(false);
    }
  }, [rewindToLastSnapshot]);

  // Handle GitHub connect button - start device flow authentication
  const handleConnectGitHub = useCallback(async (): Promise<void> => {
    const result = await startGitHubLogin();
    
    if (result.success && result.userCode) {
      setDeviceFlow({
        isOpen: true,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl || 'https://github.com/login/device',
      });
    }
  }, [startGitHubLogin]);

  // Handle device flow completion
  const handleDeviceFlowComplete = useCallback(() => {
    setDeviceFlow({ isOpen: false, userCode: '', verificationUrl: '' });
    // Remotes will be refreshed when user publishes
  }, []);

  // Handle device flow cancel
  const handleDeviceFlowCancel = useCallback(() => {
    setDeviceFlow({ isOpen: false, userCode: '', verificationUrl: '' });
  }, []);

  const handleDeviceFlowOpenChange = useCallback((open: boolean): void => {
    if (!open) {
      handleDeviceFlowCancel();
    }
  }, [handleDeviceFlowCancel]);

  // Handle publish to GitHub with form data
  const handlePublishToGitHub = useCallback(async (
    name: string,
    isPrivate: boolean,
    owner: string
  ): Promise<void> => {
    if (!repoPath) return;
    
    setIsPublishing(true);
    try {
      const result = await publishToGitHub(name, '', isPrivate, owner);
      if (result.success) {
        // Refresh remotes after successful publish
        await refreshRemotes();
      }
    } finally {
      setIsPublishing(false);
    }
  }, [repoPath, publishToGitHub, refreshRemotes]);

  const handleOpenCombineChanges = useCallback((): void => {
    openExplorerMergeModal();
  }, [openExplorerMergeModal]);

  // Conflicts are resolved in the combine-changes modal today; this is the one
  // place to change when the standalone resolver replaces it.
  const handleOpenConflict = useCallback((): void => {
    openExplorerMergeModal();
  }, [openExplorerMergeModal]);

  const handleRetryUpdate = useCallback(async (): Promise<void> => {
    const snapshot = await startUpdate();
    if (snapshot?.state === 'needs-decisions') {
      openExplorerMergeModal();
    }
  }, [openExplorerMergeModal, startUpdate]);

  // The synced feature branch is the only state that can open a Change Request.
  const featureBranchName = panelState.type === 'featureBranch' ? panelState.branchName : null;

  const reviewStatus = useMemo(() => (
    reviewSession
      ? {
        state: reviewSession.state,
        message: reviewSession.message,
        error: reviewSession.error,
        conflictCount: reviewEntries.length,
      }
      : undefined
  ), [reviewSession, reviewEntries.length]);

  // Check whether GitHub can accept a Change Request for the current branch so
  // the button can be shown eligible, or disabled with a clear reason.
  useEffect(() => {
    if (!featureBranchName) return;
    void checkChangeRequestCreateEligibility(featureBranchName);
  }, [featureBranchName, checkChangeRequestCreateEligibility]);

  // If an open request already exists for this branch, route to it instead of
  // opening the create dialog. Otherwise, open the dialog.
  const handleCreateChangeRequest = useCallback(async (): Promise<void> => {
    if (!featureBranchName) return;

    setIsResolvingChangeRequest(true);
    try {
      const existing = await findOpenChangeRequestForBranch(featureBranchName);
      if (existing.success && existing.found && existing.changeRequest?.number) {
        toast.info('A Change Request already exists for this branch — opening it.');
        setActiveView(VIEWS.REVIEWS);
        await selectChangeRequest(existing.changeRequest.number);
        return;
      }
      setIsCreateDialogOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to open Change Request.');
    } finally {
      setIsResolvingChangeRequest(false);
    }
  }, [featureBranchName, findOpenChangeRequestForBranch, selectChangeRequest, setActiveView]);

  const selectedTimelineCommitHash = useMemo(() => {
    const activeTab = explorerTabs.find((tab) => tab.id === activeExplorerTab);
    return activeTab?.type === 'commit' ? activeTab.commitContext?.commitHash ?? null : null;
  }, [explorerTabs, activeExplorerTab]);

  const handleTimelineSelectCommit = useCallback((hash: string | null): void => {
    if (!hash) {
      setActiveExplorerTab('file-browser');
      return;
    }

    const graphCommit = graphCommits.find((commit) => commit.hash === hash);
    const firstLineMessage = graphCommit?.message.split('\n')[0].trim();
    const shortHash = graphCommit?.shortHash || hash.slice(0, 7);

    openExplorerTab({
      id: `commit-${hash}`,
      title: firstLineMessage || `Snapshot ${shortHash}`,
      type: 'commit',
      commitContext: {
        commitHash: hash,
      },
    });
  }, [graphCommits, openExplorerTab, setActiveExplorerTab]);

  const sharedModals = (
    <>
      <GitHubDeviceFlowModal
        open={deviceFlow.isOpen}
        userCode={deviceFlow.userCode}
        verificationUrl={deviceFlow.verificationUrl}
        onComplete={handleDeviceFlowComplete}
        onOpenChange={handleDeviceFlowOpenChange}
      />
      {featureBranchName && (
        <CreateChangeRequestDialog
          open={isCreateDialogOpen}
          onOpenChange={setIsCreateDialogOpen}
          sourceBranch={featureBranchName}
          defaultTargetBranch={changeRequestCreateEligibility?.defaultBranch}
        />
      )}
    </>
  );

  let primaryPanel: JSX.Element;

  // No folder open - sidebar shows WelcomeView in this case (handled by Sidebar.tsx)
  // So we just return null as a safety fallback
  if (panelState.type === 'noFolder') {
    return (
      <>
        <div className="p-4 text-center text-theme-muted text-xs">No folder open</div>
        {sharedModals}
      </>
    );
  }

  // Has uncommitted changes - show commit panel
  if (panelState.type === 'hasChanges') {
    primaryPanel = (
      <SidebarCommitPanel
        key={repoPath}
        changedFiles={panelState.changedFiles}
        onCommit={commitChanges}
        onBranchAndCommit={branchAndCommit}
        onRewind={handleRewind}
        onDiscardFile={discardFileChanges}
        currentBranch={panelState.branchName}
        repoPath={repoPath || undefined}
        isCommitting={isCommitting}
        isFirstSave={repoStatus?.hasUpstream === false && repoStatus.totalLocalCommits === 0}
        isRewinding={isRewinding}
        operationInProgress={operationInProgress}
      />
    );
  } else {
    primaryPanel = (
      <ExplorerStatusPanel
        status={panelState.type}
        folderName={panelState.type === 'noRepo' ? panelState.folderName : undefined}
        branchName={repoStatus?.branch}
        effectiveDefaultBranch={projectDefaultBranch?.availability === 'ready' ? projectDefaultBranch.effectiveBranch : undefined}
        repoPath={repoPath || undefined}
        ahead={panelState.type === 'push' ? panelState.ahead : undefined}
        hasUpstream={panelState.type === 'push' ? panelState.hasUpstream : undefined}
        hasRemote={hasRemote}
        totalLocalCommits={panelState.type === 'push' ? panelState.totalLocalCommits : undefined}
        review={reviewStatus}
        updateWorkflowEnabled={updateWorkflowEnabled}
        isUpdateBusy={isUpdateBusy}
        onInitialize={startTracking}
        onInstallRequiredPackages={installRequiredPackages}
        onSync={syncRepo}
        onConnectGitHub={handleConnectGitHub}
        onPublishToGitHub={handlePublishToGitHub}
        onOpenCombineChanges={handleOpenCombineChanges}
        onRetryUpdate={() => void handleRetryUpdate()}
        onCreateChangeRequest={panelState.type === 'featureBranch' ? () => void handleCreateChangeRequest() : undefined}
        canCreateChangeRequest={changeRequestCreateEligibility?.status === 'eligible'}
        changeRequestDisabledReason={changeRequestCreateEligibility?.status === 'ineligible' ? changeRequestCreateEligibility.message : undefined}
        isCheckingChangeRequestEligibility={changeRequestCreateEligibility?.status === 'unknown'}
        isResolvingChangeRequest={isResolvingChangeRequest}
        onLoadOrganizations={loadUserOrganizations}
        isLoading={isLoading}
        isSyncing={isSyncing}
        isPublishing={isPublishing}
        operationInProgress={operationInProgress}
        gitInstalled={gitInstalled}
        lfsInstalled={lfsInstalled}
        isInstallingPackages={isInstallingPackages}
        ghInstalled={ghInstalled}
        ghAuthStatus={ghAuthStatus}
      />
    );
  }

  return (
    <>
      <div className="h-full flex flex-col overflow-hidden">
        <div className={`flex-1 min-h-0 ${panelState.type === 'hasChanges' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {primaryPanel}
        </div>

        <ConflictQueueSection onSelectFile={handleOpenConflict} />

        <ExplorerTimelineSection key={repoPath} selectedHash={selectedTimelineCommitHash} onSelectCommit={handleTimelineSelectCommit} />
      </div>

      {sharedModals}
    </>
  );
}

export default memo(ExplorerView);
