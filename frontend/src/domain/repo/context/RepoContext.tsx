/**
 * RepoContext - Repository state management for Git operations.
 * 
 * Manages:
 * - Repository path, info, and status
 * - Commit history and selected commit details
 * - File diffs for working tree and commits
 * - Branch list and operations
 * - Loading states for async operations
 * - User feedback messages
 * - File selection state
 * - Automatic status polling
 */
import { 
  createContext, 
  useContext, 
  useState, 
  useCallback, 
  useMemo, 
  useEffect, 
  useRef 
} from 'react';
import { toast } from 'sonner';
import { 
  DetectRepo,
  Status,
  GetCommitGraph,
  ShowCommit,
  DiffWorkingRaw,
  DiffCommitFileRaw,
  Branches,
  CheckBranchConflicts,
  ListMergeReviewFiles,
  DiffMergeReviewFileRaw,
  GetParentBranch,
  GetMergeState,
  GetConflictedFiles,
  GetConflictResolutionData,
  GetConflictSidesInfo,
  GetBisectState,
  GetGitVersion,
  IsGHInstalled,
  GetAuthenticatedUser,
  GetChangeRequest,
  GetChangeRequestRepository,
  ListChangeRequests,
  ListChangeRequestFiles,
  ListChangeRequestTargets,
  FindOpenChangeRequestForBranch,
  RepoList,
  ListUserOrganizations,
  IsLFSInstalled,
  GetPresetPatterns,
  GetRemotes,
  GetSettings,
} from '../services/repo-queries';
import {
  CommitAll,
  CheckoutBranch,
  CreateBranchAndCheckout,
  RenameBranch,
  DeleteBranch,
  StashAndSwitchBranch,
  ResetSoftHead,
  ResetHardHead,
  DiscardAll,
  DiscardFile,
  InitRepo,
  StartMergeWithOptions,
  EnsureChangeRequestSnapshotsLocal,
  ClearChangeRequestSnapshot,
  ClearChangeRequestSnapshots,
  ResolveConflictKeepOurs,
  ResolveConflictKeepTheirs,
  ResolveConflictKeepBoth,
  ResolveConflictWithDecisions,
  AbortMerge,
  CompleteMerge,
  AbortCurrentOperation,
  AbortCherryPick,
  ContinueCherryPick,
  SkipCherryPickCommit,
  AbortRevert,
  ContinueRevert,
  SkipRevertCommit,
  RevertCommit,
  AbortBisect,
  AbortAM,
  SkipAMPatch,
  CreateBranchFromDetached,
  RemoveAllStaleLocks,
  Pull,
  AuthLogin,
  AuthLoginStart,
  AuthLoginComplete,
  AuthLoginCancel,
  AuthLogout,
  RepoClone,
  RepoCreateFromLocal,
  CreateChangeRequest,
  InitializeLFS,
  TrackPattern,
  EnsurePortableToolchainIfNeeded,
  SyncWithProgress,
  GetAppSettings,
  SaveAppSettings,
  EnsureIdentity,
  GetUserProfile,
  SetUserProfile,
  WriteRepoLocalConfig,
  EnsureIOFabrikDir,
  StartBackgroundTasks,
  StopBackgroundTasks,
  ApplyGitignoreTemplate,
  RevealInFinder,
  OpenInTerminal,
} from '../services/repo-commands';
import { isActivePreviewStagingPath } from '../utils/preview-staging';
import { usePreviewGeneration } from '../hooks/usePreviewGeneration';
import { useProjectDefaultBranch } from '../hooks/useProjectDefaultBranch';
import { useStatusPolling } from '../polling/useStatusPolling';
import { useGitHubAuthStatus } from '../polling/useGitHubAuthStatus';
import { useAuth } from '../../auth/context/AuthContext';
import { WatchDirectory, StopWatching } from '../../../../bindings/iofabrik/services/filewatcherservice';
import { IsDefaultBranchSyncEligible } from '../../../../bindings/iofabrik/services/integrationsessionservice';
import { onEvent } from '../../../shared/runtime/events';
import { addRecentFolder } from '../../../shared/utils/recentFolders';
import { clearViewerCache } from '../../../viewers/registry/viewer-cache';
import { clearAllTabStates } from '../../../viewers/components/file/l5x';
import {
  trackRepoOpened,
  trackRepoClosed,
  trackRepoInitialized,
  trackCommitCreated,
  trackCommitBranchAndSave,
  trackCommitUndone,
  trackChangesDiscarded,
  trackSyncStarted,
  trackSyncCompleted,
  trackSyncFailed,
  trackBranchSwitched,
  trackBranchCreated,
  trackConflictDetected,
  trackConflictResolved,
  trackMergeCompleted,
  trackMergeAborted,
  trackErrorShown,
  trackProjectSetupStarted,
  trackProjectSetupCompleted,
  trackProjectPublishAttempted,
  trackProjectPublishFailed,
  trackProjectPublishCompleted,
} from '../../analytics/analytics';

import type {
  RepoContextValue,
  RepoProviderProps,
  RepoInfo,
  RepoStatus,
  GraphCommit,
  CommitDetail,
  BranchList,
  FileDiff,
  MergeReviewFile,
  MergeReviewDiffResult,
  ConflictedFile,
  BranchConflictCheckResult,
  MergeState,
  DetectedParentBranch,
  ConflictSidesInfo,
  ProgressModalState,
  FileResolutionsMap,
  ResolutionStrategy,
  LiveMergePhase,
  MessageType,
  MergeOptions,
  StartMergeResult,
  ParentBranchResult,
  BisectState,
  GitIdentityPromptReason,
  GitIdentityPromptState,
  DefaultBranchSyncPromptState,
  GitHubAuthResult,
  GitHubDeviceFlowResult,
  GitHubRepo,
  GitHubRepoListResult,
  GitHubCloneResult,
  GitHubRepoCreateResult,
  GitHubOrganizationsResult,
  GitHubChangeRequest,
  GitHubChangeRequestFile,
  GitHubChangeRequestError,
  GitHubChangeRequestErrorCode,
  GitHubChangeRequestRepository,
  ChangeRequestSnapshot,
  ChangeRequestCreateEligibility,
  GitHubChangeRequestTargetsResult,
  GitHubFindChangeRequestResult,
  GitHubCreateChangeRequestOptions,
  GitHubCreateChangeRequestResult,
  CreateProjectOptions,
  CreateProjectResult,
} from './RepoContext.types';
import { mapConflictResolutionData, toConflictDecisionPayload } from '../../../features/conflict/types';
import type { ConflictRegionDecision } from '../../../features/conflict/types';
import type { ConflictResolutionData } from '../../../features/conflict/types';

function normalizeMergeReviewDiffResult(
  filePath: string,
  targetRef: string,
  sourceRef: string,
  result: Partial<MergeReviewDiffResult> | null | undefined,
): MergeReviewDiffResult | null {
  if (!result) {
    return null;
  }

  return {
    path: result.path ?? filePath,
    oldPath: result.oldPath,
    status: (result.status ?? 'modified') as MergeReviewDiffResult['status'],
    binary: result.binary,
    rawDiff: result.rawDiff,
    hasError: result.hasError,
    error: result.error,
    targetRef: result.targetRef ?? targetRef,
    sourceRef: result.sourceRef ?? sourceRef,
  };
}

// Polling interval for status updates (in ms)
const STATUS_POLL_INTERVAL = 30000;
const STARTUP_AUTO_PULL_DELAY_MS = 10000;
const LIVE_CONFLICT_RETRY_DELAY_MS = 150;

// Global UI events consumed by LayoutContext for explorer tab cleanup
const CLOSE_ALL_PREVIEW_TABS_EVENT = 'iofabrik:explorer-close-all-previews';
const CLOSE_FILE_PREVIEW_TABS_EVENT = 'iofabrik:explorer-close-file-previews';
const REPO_OPEN_SUCCESS_EVENT = 'iofabrik:repo-open-success';

interface CachedGitIdentity {
  repoPath: string;
  name: string;
  email: string;
}

const EMPTY_GIT_IDENTITY: CachedGitIdentity = {
  repoPath: '',
  name: '',
  email: '',
};

function getGitIdentityPromptMessage(reason: GitIdentityPromptReason): {
  successLocal: string;
  successGlobal: string;
  cancel: string;
} {
  switch (reason) {
    case 'initial-commit':
      return {
        successLocal: 'Name and email saved for this project. IOFabrik can make the first saved revision now.',
        successGlobal: 'Name and email saved for all projects on this device. IOFabrik can make the first saved revision now.',
        cancel: 'The first saved revision was skipped until a name and email are added.',
      };
    case 'merge-complete':
      return {
        successLocal: 'Name and email saved for this project. You can finish the merge now.',
        successGlobal: 'Name and email saved for all projects on this device. You can finish the merge now.',
        cancel: 'Merge completion was cancelled until a name and email are added.',
      };
    case 'branch-save':
      return {
        successLocal: 'Name and email saved for this project. IOFabrik can save to the new branch now.',
        successGlobal: 'Name and email saved for all projects on this device. IOFabrik can save to the new branch now.',
        cancel: 'Branch save was cancelled until a name and email are added.',
      };
    case 'save':
    default:
      return {
        successLocal: 'Name and email saved for this project. IOFabrik can save changes now.',
        successGlobal: 'Name and email saved for all projects on this device. IOFabrik can save changes now.',
        cancel: 'Save was cancelled until a name and email are added.',
      };
  }
}

// Create context with null default
const RepoContext = createContext<RepoContextValue | null>(null);

export function RepoProvider({ children }: RepoProviderProps) {
  const { userName, userEmail } = useAuth();

  // ===== Repository State =====
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [graphCommits, setGraphCommits] = useState<GraphCommit[]>([]);
  const [branches, setBranches] = useState<BranchList | null>(null);
  
  // ===== Selection State (v2) =====
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitDetail | null>(null);
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [currentDiff, setCurrentDiff] = useState<FileDiff | null>(null);
  
  // ===== Conflict State (v2 Merge Changes) =====
  const [conflictedFiles, setConflictedFiles] = useState<ConflictedFile[]>([]);
  const [selectedConflictFile, setSelectedConflictFile] = useState<string | null>(null);
  const [conflictCheckResult, setConflictCheckResult] = useState<BranchConflictCheckResult | null>(null);
  const [mergeReviewFiles, setMergeReviewFiles] = useState<MergeReviewFile[]>([]);
  const [isLoadingMergeReviewFiles, setIsLoadingMergeReviewFiles] = useState(false);
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);
  const [detectedParentBranch, setDetectedParentBranch] = useState<DetectedParentBranch | null>(null);
  const [fileResolutions, setFileResolutions] = useState<FileResolutionsMap>({});
  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);
  const [conflictSidesInfo, setConflictSidesInfo] = useState<ConflictSidesInfo | null>(null);
  const [isSquashMerge, setIsSquashMerge] = useState(true);
  
  // ===== Loading States =====
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [nonGitFolderPromptPath, setNonGitFolderPromptPath] = useState<string | null>(null);
  const [gitIdentityPrompt, setGitIdentityPrompt] = useState<GitIdentityPromptState | null>(null);
  const [defaultBranchSyncPrompt, setDefaultBranchSyncPrompt] = useState<DefaultBranchSyncPromptState | null>(null);

  // ===== Global Operation Lock =====
  // Prevents concurrent mutating git operations and provides UI feedback.
  const [operationInProgress, setOperationInProgress] = useState(false);
  const [operationLabel, setOperationLabel] = useState<string | null>(null);
  
  // ===== Repository Settings State =====
  const [repoSettings, setRepoSettings] = useState<{
    fetchPrune: boolean;
    fetchTags: boolean;
  } | null>(null);

  // ===== Remote State =====
  const [hasRemote, setHasRemote] = useState(false);
  
  // ===== GitHub State (Phase 2) =====
  const [gitInstalled, setGitInstalled] = useState(true);
  const [lfsInstalled, setLfsInstalled] = useState(true);
  const [isInstallingPackages, setIsInstallingPackages] = useState(false);
  const [packagesInstallMessage, setPackagesInstallMessage] = useState('');
  const [packagesInstallPercent, setPackagesInstallPercent] = useState<number | null>(null);

  const {
    ghInstalled, setGhInstalled, ghVersion, ghAuthStatus, isCheckingGhAuth,
    isOffline, checkGitHubAuth, resetGitHubAuth,
  } = useGitHubAuthStatus();
  const [isStartingGitHubLogin, setIsStartingGitHubLogin] = useState(false);
  const gitHubLoginStartRef = useRef(false);
  const [ghRepos, setGhRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingGhRepos, setIsLoadingGhRepos] = useState(false);
  const [changeRequestRepository, setChangeRequestRepository] = useState<GitHubChangeRequestRepository | null>(null);
  const [changeRequestViewerLogin, setChangeRequestViewerLogin] = useState('');
  const [changeRequests, setChangeRequests] = useState<GitHubChangeRequest[]>([]);
  const [omittedExternalChangeRequestCount, setOmittedExternalChangeRequestCount] = useState(0);
  const [changeRequestsMayHaveMore, setChangeRequestsMayHaveMore] = useState(false);
  const [isLoadingChangeRequests, setIsLoadingChangeRequests] = useState(false);
  const [changeRequestError, setChangeRequestError] = useState<GitHubChangeRequestError | null>(null);
  const [selectedChangeRequest, setSelectedChangeRequest] = useState<GitHubChangeRequest | null>(null);
  const [changeRequestFiles, setChangeRequestFiles] = useState<GitHubChangeRequestFile[]>([]);
  const [changeRequestTotalFiles, setChangeRequestTotalFiles] = useState(0);
  const [isChangeRequestFilesTruncated, setIsChangeRequestFilesTruncated] = useState(false);
  const [selectedChangeRequestFilePath, setSelectedChangeRequestFilePath] = useState<string | null>(null);
  const [isLoadingChangeRequestDetail, setIsLoadingChangeRequestDetail] = useState(false);
  const [changeRequestDetailError, setChangeRequestDetailError] = useState<GitHubChangeRequestError | null>(null);
  const [changeRequestSnapshot, setChangeRequestSnapshot] = useState<ChangeRequestSnapshot | null>(null);
  const [isPreparingChangeRequestSnapshot, setIsPreparingChangeRequestSnapshot] = useState(false);
  const [changeRequestSnapshotError, setChangeRequestSnapshotError] = useState<GitHubChangeRequestError | null>(null);
  const [changeRequestCreateEligibility, setChangeRequestCreateEligibility] = useState<ChangeRequestCreateEligibility>({ status: 'unknown' });
  const [isCreatingChangeRequest, setIsCreatingChangeRequest] = useState(false);
  
  // ===== Progress Modal State =====
  const [progressModal, setProgressModal] = useState<ProgressModalState>({
    isOpen: false,
    operationId: null,
    title: '',
  });
  
  // ===== Refs =====
  const operationIdCounter = useRef(0);
  const repoOpenTimeRef = useRef<number>(0);
  const repoRefreshSession = useRef<{ path: string | null }>({ path: null });
  const projectDefaultState = useProjectDefaultBranch(repoPath, repoRefreshSession);
  const { clearProjectDefaultBranch, refreshProjectDefaultBranch, ensureProjectDefaultBranch } = projectDefaultState;
  const savePendingRef = useRef(false);
  const syncStartTimeRef = useRef<number | null>(null);
  const startupAutoPullDueRef = useRef(false);
  const startupAutoPullDoneRef = useRef(false);
  const startupAutoPullDeadlineRef = useRef<number>(Date.now() + STARTUP_AUTO_PULL_DELAY_MS);
  const gitIdentityPromptResolverRef = useRef<((value: boolean) => void) | null>(null);
  const defaultBranchSyncPromptResolverRef = useRef<((value: boolean) => void) | null>(null);
  const gitIdentityRef = useRef<CachedGitIdentity>(EMPTY_GIT_IDENTITY);
  const changeRequestLoadIdRef = useRef(0);
  const changeRequestDetailLoadIdRef = useRef(0);
  const changeRequestAuthStateRef = useRef<boolean | null>(null);
  const selectedChangeRequestRef = useRef<GitHubChangeRequest | null>(null);
  selectedChangeRequestRef.current = selectedChangeRequest;

  const clearChangeRequestState = useCallback((): void => {
    changeRequestLoadIdRef.current += 1;
    changeRequestDetailLoadIdRef.current += 1;
    setChangeRequestRepository(null);
    setChangeRequestViewerLogin('');
    setChangeRequests([]);
    setOmittedExternalChangeRequestCount(0);
    setChangeRequestsMayHaveMore(false);
    setIsLoadingChangeRequests(false);
    setChangeRequestError(null);
    setSelectedChangeRequest(null);
    setChangeRequestFiles([]);
    setChangeRequestTotalFiles(0);
    setIsChangeRequestFilesTruncated(false);
    setSelectedChangeRequestFilePath(null);
    setIsLoadingChangeRequestDetail(false);
    setChangeRequestDetailError(null);
    setChangeRequestSnapshot(null);
    setIsPreparingChangeRequestSnapshot(false);
    setChangeRequestSnapshotError(null);
    setChangeRequestCreateEligibility({ status: 'unknown' });
    setIsCreatingChangeRequest(false);
  }, []);

  const isWindowsPlatform = useCallback((): boolean => {
    return navigator.userAgent.toLowerCase().includes('win');
  }, []);

  // ===== Core Handlers =====

  // Show a toast notification using sonner
  const showMessage = useCallback((type: MessageType, text: string, duration = 5000) => {
    const options = { duration };
    
    switch (type) {
      case 'success':
        toast.success(text, options);
        break;
      case 'error':
        toast.error(text, options);
        break;
      case 'info':
      default:
        toast.info(text, options);
        break;
    }
  }, []);

  const closeAllExplorerPreviews = useCallback(() => {
    window.dispatchEvent(new CustomEvent(CLOSE_ALL_PREVIEW_TABS_EVENT));
  }, []);

  /**
   * withOperationLock — wraps a mutating git operation so that:
   *  1. If another operation is already running, shows a toast and returns early.
   *  2. Sets operationInProgress + operationLabel for the duration.
   *  3. Resets them in a finally-block regardless of success/failure.
   *
   * Usage: const result = await withOperationLock('Pushing...', async () => { ... });
   */
  const operationInProgressRef = useRef(false);
  const withOperationLock = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      if (operationInProgressRef.current) {
        toast.info(`Please wait — ${operationLabel || 'an operation'} is in progress`);
        return null;
      }
      operationInProgressRef.current = true;
      setOperationInProgress(true);
      setOperationLabel(label);
      try {
        return await fn();
      } finally {
        operationInProgressRef.current = false;
        setOperationInProgress(false);
        setOperationLabel(null);
      }
    },
    [operationLabel],
  );

  const closeExplorerPreviewsForFile = useCallback((relativePath: string) => {
    if (!relativePath) return;
    window.dispatchEvent(new CustomEvent(CLOSE_FILE_PREVIEW_TABS_EVENT, {
      detail: { relativePath },
    }));
  }, []);

  const pruneResolvedConflictCache = useCallback((activeConflicts: ConflictedFile[]) => {
    const activeConflictPaths = new Set(activeConflicts.map((file) => file.path));
    setFileResolutions((previous) => {
      const nextEntries = Object.entries(previous).filter(([filePath]) => !activeConflictPaths.has(filePath));
      if (nextEntries.length === Object.keys(previous).length) {
        return previous;
      }

      return Object.fromEntries(nextEntries) as FileResolutionsMap;
    });
  }, []);

  const reconcileLiveMergeState = useCallback(async (
    targetBranch: string,
    sourceBranch: string,
    options: {
      squash?: boolean;
      preserveConflictPreview?: boolean;
    } = {},
  ): Promise<{
    liveMergePhase: LiveMergePhase;
    mergeState: MergeState;
    conflictedFiles: ConflictedFile[];
  }> => {
    if (!repoPath) {
      throw new Error('No repository open');
    }

    const readLiveState = async (): Promise<{ mergeState: MergeState; conflictedFiles: ConflictedFile[] }> => {
      const [nextMergeState, nextConflictedFiles] = await Promise.all([
        GetMergeState(repoPath),
        GetConflictedFiles(repoPath),
      ]);

      return {
        mergeState: nextMergeState as MergeState,
        conflictedFiles: (nextConflictedFiles || []) as ConflictedFile[],
      };
    };

    let liveState = await readLiveState();
    const expectedConflicts = options.preserveConflictPreview && (
      Boolean(conflictCheckResult?.hasConflicts)
      || Boolean(conflictCheckResult?.conflictedFiles?.length)
      || conflictedFiles.length > 0
    );

    if (liveState.conflictedFiles.length === 0 && (liveState.mergeState.hasConflicts || expectedConflicts)) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, LIVE_CONFLICT_RETRY_DELAY_MS);
      });
      liveState = await readLiveState();
    }

    const confirmedConflictFree = !liveState.mergeState.hasConflicts && liveState.conflictedFiles.length === 0;
    const fallbackConflicts = options.preserveConflictPreview
      ? (((conflictCheckResult?.conflictedFiles?.length ? conflictCheckResult.conflictedFiles : conflictedFiles) || []) as ConflictedFile[])
      : conflictedFiles;
    const authoritativeConflicts = liveState.conflictedFiles.length > 0
      ? liveState.conflictedFiles
      : confirmedConflictFree
        ? []
        : fallbackConflicts;
    const liveMergePhase: LiveMergePhase = liveState.conflictedFiles.length > 0
      ? 'resolving'
      : confirmedConflictFree
        ? 'ready-to-complete'
        : 'starting';

    setMergeState(liveState.mergeState);
    setConflictedFiles(authoritativeConflicts);
    pruneResolvedConflictCache(authoritativeConflicts);
    setSelectedConflictFile((previous) => {
      if (authoritativeConflicts.length === 0) {
        return null;
      }

      return authoritativeConflicts.some((file) => file.path === previous)
        ? previous
        : authoritativeConflicts[0].path;
    });
    setConflictCheckResult((previous) => {
      const baseResult: BranchConflictCheckResult = previous ?? {
        hasConflicts: authoritativeConflicts.length > 0,
        conflictedFiles: authoritativeConflicts,
        parentBranch: targetBranch,
        targetBranch,
        sourceBranch,
        success: true,
      };

      return {
        ...baseResult,
        success: true,
        error: undefined,
        targetBranch: baseResult.targetBranch || targetBranch,
        parentBranch: baseResult.parentBranch || targetBranch,
        sourceBranch: baseResult.sourceBranch || sourceBranch,
        isSquashMerge: options.squash ?? baseResult.isSquashMerge,
        mergeStarted: true,
        hasConflicts: !confirmedConflictFree,
        conflictedFiles: authoritativeConflicts,
        alreadyUpToDate: false,
        autoCompleted: false,
        liveMergePhase,
      };
    });

    return {
      liveMergePhase,
      mergeState: liveState.mergeState,
      conflictedFiles: authoritativeConflicts,
    };
  }, [repoPath, conflictCheckResult, conflictedFiles, pruneResolvedConflictCache]);

  const refreshToolchainStatus = useCallback(async (): Promise<{ hasGit: boolean; hasGh: boolean; hasLfs: boolean }> => {
    let hasGit = false;
    let hasGh = false;
    let hasLfs = false;

    try {
      const gitVersion = await GetGitVersion();
      hasGit = !!gitVersion;
    } catch {
      hasGit = false;
    }

    try {
      hasGh = await IsGHInstalled();
    } catch {
      hasGh = false;
    }

    try {
      hasLfs = await IsLFSInstalled();
    } catch {
      hasLfs = false;
    }

    setGitInstalled(hasGit);
    setGhInstalled(hasGh);
    setLfsInstalled(hasLfs);

    return { hasGit, hasGh, hasLfs };
  }, []);

  const installRequiredPackages = useCallback(async (): Promise<boolean> => {
    if (!isWindowsPlatform()) {
      showMessage('error', 'Required packages are missing. Please install Git, Git LFS, and GitHub CLI manually.');
      return false;
    }

    setIsInstallingPackages(true);
    setPackagesInstallMessage('Checking supporting tools...');
    setPackagesInstallPercent(null);

    try {
      const result = await EnsurePortableToolchainIfNeeded();
      if (!result.success) {
        showMessage('error', result.error || result.message || 'Supporting tools could not be prepared. Reinstall IOFabrik using the full installer.');
        return false;
      }

      await refreshToolchainStatus();
      return true;
    } catch {
      showMessage('error', 'Supporting tools could not be checked. Restart IOFabrik and try again.');
      return false;
    } finally {
      setIsInstallingPackages(false);
    }
  }, [isWindowsPlatform, refreshToolchainStatus, showMessage]);

  // Fetch repo status from Git
  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!repoPath) return;
    const session = repoRefreshSession.current;
    if (session.path !== repoPath) return;
    
    try {
      const status = await Status(repoPath);
      if (session !== repoRefreshSession.current) return;
      if (status.hasError) {
        console.error('Status error:', status.error);
        return;
      }
      setRepoStatus(status as RepoStatus);
      
      // Update repoInfo.branch if it changed
      if (status.branch && status.branch !== repoInfo?.branch) {
        setRepoInfo(prev => prev ? { ...prev, branch: status.branch } : prev);
      }
    } catch (err) {
      console.error('Failed to refresh status:', err);
    }
  }, [repoPath, repoInfo?.branch]);

  // Fetch commits with graph data
  const refreshCommits = useCallback(async (): Promise<void> => {
    if (!repoPath) return;
    const session = repoRefreshSession.current;
    if (session.path !== repoPath) return;
    
    try {
      const result = await GetCommitGraph(repoPath, 50);
      if (session !== repoRefreshSession.current) return;
      if (result.hasError) {
        console.error('Failed to fetch graph commits:', result.error);
        return;
      }
      setGraphCommits((result.commits || []) as GraphCommit[]);
    } catch (err) {
      console.error('Failed to fetch graph commits:', err);
    }
  }, [repoPath]);

  // Refresh all repository data
  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([refreshStatus(), refreshCommits(), refreshProjectDefaultBranch()]);
  }, [refreshStatus, refreshCommits, refreshProjectDefaultBranch]);

  const { previewNotification, dismissPreviewNotification, generatePreview, previewRunningRef } = usePreviewGeneration(repoPath, withOperationLock, refreshAll);

  // Check if repository has remotes configured
  const refreshRemotes = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      setHasRemote(false);
      return false;
    }
    
    try {
      const remotes = await GetRemotes(repoPath);
      await refreshProjectDefaultBranch();
      const hasRemoteConfigured = remotes && remotes.length > 0;
      setHasRemote(hasRemoteConfigured);
      return hasRemoteConfigured;
    } catch (err) {
      console.error('Failed to check remotes:', err);
      setHasRemote(false);
      return false;
    }
  }, [repoPath, refreshProjectDefaultBranch]);

  // Refresh repository-level settings (protected branches, fetch options)
  const refreshRepoSettings = useCallback(async (pathOverride?: string): Promise<void> => {
    const targetPath = pathOverride || repoPath;
    if (!targetPath) return;

    try {
      const settings = await GetSettings(targetPath);
      setRepoSettings({
        fetchPrune: settings.fetchSettings?.pruneStaleBranches ?? true,
        fetchTags: settings.fetchSettings?.fetchTags ?? true,
      });
    } catch (err) {
      console.warn('Failed to load repo settings, using defaults:', err);
      setRepoSettings({
        fetchPrune: true,
        fetchTags: true,
      });
    }
  }, [repoPath]);

  const cacheGitIdentity = useCallback((path: string, name: string, email: string): void => {
    gitIdentityRef.current = {
      repoPath: path,
      name: name.trim(),
      email: email.trim(),
    };
  }, []);

  const clearCachedGitIdentity = useCallback((): void => {
    gitIdentityRef.current = EMPTY_GIT_IDENTITY;
  }, []);

  // ===== Repo Operations =====

  // Clear repository-specific conflict state.
  const clearConflicts = useCallback(() => {
    setConflictedFiles([]);
    setSelectedConflictFile(null);
    setConflictCheckResult(null);
    setMergeReviewFiles([]);
    setIsLoadingMergeReviewFiles(false);
    setDetectedParentBranch(null);
    setFileResolutions({});
    setMergeState(null);
    setConflictSidesInfo(null);
  }, []);

  // Close the current repository
  const closeRepo = useCallback(async (): Promise<void> => {
    if (previewRunningRef.current) {
      toast.info('Wait for preview generation to finish before switching projects.');
      return;
    }
    // Previous-project responses must not repopulate state after closing.
    repoRefreshSession.current = { path: null };
    clearProjectDefaultBranch();
    // Track repo closed event
    if (repoOpenTimeRef.current > 0) {
      const sessionDuration = Math.round((Date.now() - repoOpenTimeRef.current) / 1000);
      trackRepoClosed({ sessionDurationSeconds: sessionDuration });
      repoOpenTimeRef.current = 0;
    }

    // Stop background tasks for the current repo before clearing state
    if (repoPath) {
      try {
        await StopBackgroundTasks(repoPath);
      } catch (err) {
        console.warn('Failed to stop background tasks:', err);
      }
    }

    setRepoPath(null);
    setRepoInfo(null);
    setRepoStatus(null);
    setGraphCommits([]);
    setBranches(null);
    setSelectedFileIndex(null);
    setSelectedCommit(null);
    setSelectedCommitFile(null);
    setCurrentDiff(null);
    setRepoSettings(null);
    setHasRemote(false);
    clearConflicts();
    closeAllExplorerPreviews();
    clearChangeRequestState();
    clearCachedGitIdentity();

    // Clear viewer cache and L5X tab states when closing repo to free memory
    clearViewerCache();
    clearAllTabStates();

    try {
      await StopWatching();
    } catch (err) {
      console.error('Failed to stop file watcher:', err);
    }

    try {
      const currentSettings = await GetAppSettings();
      await SaveAppSettings({ ...currentSettings, lastRepoPath: '' });
    } catch (err) {
      console.error('Failed to clear settings:', err);
    }
  }, [clearCachedGitIdentity, clearChangeRequestState, clearConflicts, closeAllExplorerPreviews, repoPath, clearProjectDefaultBranch]);

  // Open a folder by path
  const openRepo = useCallback(async (path: string): Promise<boolean> => {
    if (isLoading || previewRunningRef.current) return false;
    if (path === repoPath) return true;
    
    setIsLoading(true);
    clearChangeRequestState();
    setSelectedFileIndex(null);
    
    try {
      const info = await DetectRepo(path);
      if (info.hasError) {
        showMessage('error', 'This project could not be opened. Check its folder and try again.');
        setIsLoading(false);
        return false;
      }
      if (repoPath) await closeRepo();
      repoRefreshSession.current = { path };
      let hasRemoteConfigured: boolean | null = info.isRepo ? null : false;
      
      setRepoPath(path);
      setRepoInfo(info as RepoInfo);
      addRecentFolder(path);
      repoOpenTimeRef.current = Date.now();
      
      try {
        const currentSettings = await GetAppSettings();
        await SaveAppSettings({ ...currentSettings, lastRepoPath: path });
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
      
      if (info.isRepo) {
        // Check if repo has remotes configured
        try {
          const remotes = await GetRemotes(path);
          hasRemoteConfigured = !!(remotes && remotes.length > 0);
          setHasRemote(hasRemoteConfigured);
        } catch (err) {
          console.error('Failed to check remotes:', err);
          hasRemoteConfigured = null;
          setHasRemote(false);
        }
        
        try {
          const state = await GetMergeState(path);
          if (state.inMerge || state.inRebase) {
            setMergeState(state as MergeState);
            
            if (state.hasConflicts) {
              const conflicts = await GetConflictedFiles(path);
              setConflictedFiles((conflicts || []) as ConflictedFile[]);
            }
            
            const opType = state.inRebase ? 'rebase' : 'merge';
            showMessage('warning', `Repository has an interrupted ${opType}. Use "Combine Versions" to resolve or abort.`);
          }
        } catch (err) {
          console.error('Failed to check merge state:', err);
        }
      } else {
        setHasRemote(false);
      }

      // Track repo opened event after remote detection to ensure payload correctness.
      trackRepoOpened({
        isGitRepo: info.isRepo,
        hasRemote: hasRemoteConfigured,
        branchName: info.branch || 'unknown',
      });
      
      // Ensure git identity is configured (auto-set from Supabase login if missing)
      if (info.isRepo) {
        try {
          const identity = await EnsureIdentity(path, userName || '', userEmail || '');
          cacheGitIdentity(path, identity.name || '', identity.email || '');
          if (identity.wasAutoSet) {
            console.info('Git identity auto-configured from IOFabrik account:', identity.name, identity.email);
          }
        } catch (err) {
          console.warn('Failed to ensure git identity:', err);
          clearCachedGitIdentity();
        }
      } else {
        clearCachedGitIdentity();
      }
      
      try {
        await WatchDirectory(path);
      } catch (err) {
        console.error('Failed to start file watcher:', err);
      }
      
      // Load repository settings (protected branches, fetch options, etc.)
      if (info.isRepo) {
        await refreshRepoSettings(path);
        await refreshProjectDefaultBranch(true, path);

        // Start background tasks (auto-sync, LFS auto-download, auto-optimization)
        try {
          await StartBackgroundTasks(path);
        } catch (err) {
          console.warn('Failed to start background tasks:', err);
        }
      }

      window.dispatchEvent(new CustomEvent(REPO_OPEN_SUCCESS_EVENT, {
        detail: { path },
      }));
      
      setIsLoading(false);
      return true;
    } catch (err) {
      const error = err as Error;
      trackErrorShown({
        errorContext: 'repo_open',
        actionAttempted: 'open_repo',
      });
      showMessage('error', `Failed to open folder: ${error.message || err}`);
      setIsLoading(false);
      return false;
    }
  }, [cacheGitIdentity, clearCachedGitIdentity, closeRepo, isLoading, repoPath, userName, userEmail, showMessage, refreshRepoSettings, refreshProjectDefaultBranch]);

  /**
   * Open folder entrypoint for user-driven folder selection.
   * If the selected folder is not initialized as a git repository, show
   * a modal prompt instead of opening it directly.
   */
  const openFolder = useCallback(async (path: string): Promise<boolean> => {
    const result = await withOperationLock('Opening project', async () => {
      try {
        const info = await DetectRepo(path);

        if (!info.hasError && !info.isRepo) {
          setNonGitFolderPromptPath(path);
          return false;
        }
      } catch (err) {
        console.warn('Failed preflight repo detection, falling back to openRepo:', err);
      }

      setNonGitFolderPromptPath(null);
      return openRepo(path);
    });
    return result ?? false;
  }, [openRepo, withOperationLock]);

  const dismissNonGitFolderPrompt = useCallback((): void => {
    setNonGitFolderPromptPath(null);
  }, []);

  const resolveGitIdentityPrompt = useCallback((value: boolean): void => {
    const resolver = gitIdentityPromptResolverRef.current;
    gitIdentityPromptResolverRef.current = null;
    setGitIdentityPrompt(null);
    resolver?.(value);
  }, []);

  const promptForGitIdentityIfMissing = useCallback(async (
    path: string,
    reason: GitIdentityPromptReason,
  ): Promise<boolean> => {
    const cachedIdentity = gitIdentityRef.current;
    let suggestedName = cachedIdentity.repoPath === path ? cachedIdentity.name : (userName || '').trim();
    let suggestedEmail = cachedIdentity.repoPath === path ? cachedIdentity.email : (userEmail || '').trim();

    if (!suggestedName || !suggestedEmail) {
      try {
        const profile = await GetUserProfile(path);
        suggestedName = (profile.name || suggestedName).trim();
        suggestedEmail = (profile.email || suggestedEmail).trim();
      } catch (err) {
        console.warn('Failed to load git identity before save:', err);
      }
    }

    if (suggestedName && suggestedEmail) {
      cacheGitIdentity(path, suggestedName, suggestedEmail);
      return true;
    }

    gitIdentityPromptResolverRef.current?.(false);

    return new Promise<boolean>((resolve) => {
      gitIdentityPromptResolverRef.current = resolve;
      setGitIdentityPrompt({
        isOpen: true,
        repoPath: path,
        name: suggestedName,
        email: suggestedEmail,
        reason,
      });
    });
  }, [cacheGitIdentity, userName, userEmail]);

  const submitGitIdentityPrompt = useCallback(async (
    name: string,
    email: string,
    saveGlobally: boolean,
  ): Promise<boolean> => {
    if (!gitIdentityPrompt) {
      return false;
    }

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName || !trimmedEmail) {
      showMessage('error', 'Name and email are required before IOFabrik can save changes.');
      return false;
    }

    const targetPath = saveGlobally ? '' : gitIdentityPrompt.repoPath;
    const result = await SetUserProfile(targetPath, { name: trimmedName, email: trimmedEmail }, saveGlobally);

    if (!result.success) {
      showMessage('error', result.error || 'Failed to save name and email');
      return false;
    }

    cacheGitIdentity(gitIdentityPrompt.repoPath, trimmedName, trimmedEmail);
    const messages = getGitIdentityPromptMessage(gitIdentityPrompt.reason);
    showMessage('success', saveGlobally ? messages.successGlobal : messages.successLocal);
    resolveGitIdentityPrompt(true);
    return true;
  }, [cacheGitIdentity, gitIdentityPrompt, resolveGitIdentityPrompt, showMessage]);

  const cancelGitIdentityPrompt = useCallback((): void => {
    if (!gitIdentityPrompt) {
      return;
    }

    const messages = getGitIdentityPromptMessage(gitIdentityPrompt.reason);
    showMessage('info', messages.cancel);
    resolveGitIdentityPrompt(false);
  }, [gitIdentityPrompt, resolveGitIdentityPrompt, showMessage]);

  const resolveDefaultBranchSyncPrompt = useCallback((value: boolean): void => {
    const resolver = defaultBranchSyncPromptResolverRef.current;
    defaultBranchSyncPromptResolverRef.current = null;
    setDefaultBranchSyncPrompt(null);
    resolver?.(value);
  }, []);

  const promptForDefaultBranchSync = useCallback((branch: string): Promise<boolean> => {
    defaultBranchSyncPromptResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      defaultBranchSyncPromptResolverRef.current = resolve;
      setDefaultBranchSyncPrompt({ isOpen: true, branch });
    });
  }, []);

  const confirmDefaultBranchSync = useCallback((): void => {
    resolveDefaultBranchSyncPrompt(true);
  }, [resolveDefaultBranchSyncPrompt]);

  const cancelDefaultBranchSync = useCallback((): void => {
    resolveDefaultBranchSyncPrompt(false);
  }, [resolveDefaultBranchSyncPrompt]);

  /**
   * Start tracking a folder with version control.
   * This is the main entry point for the "Start Tracking" button.
   *
   * Process:
   * 1. Initialize git in the directory
   * 2. Initialize LFS & add all known LFS attributes by default
   * 3. Add .gitignore for .env by default
   * 4. Ensure git identity is set (auto-set from Supabase login if missing)
   */
  const startTracking = useCallback(async (source: 'status_bar_nudge' | 'setup_banner' = 'setup_banner'): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No folder open');
      return false;
    }

    if (!gitInstalled || !lfsInstalled) {
      const installed = await installRequiredPackages();
      if (!installed) {
        return false;
      }
    }
    
    if (repoInfo?.isRepo) {
      showMessage('info', 'Folder is already being tracked');
      return true;
    }
    
    setIsLoading(true);
    const setupStartTime = Date.now();

    // Determine initial project state for analytics
    const fileCount = repoStatus?.changedFiles?.length || 0;
    const projectState = fileCount > 0 ? 'has-files-untracked' : 'empty-untracked';

    // Track setup started
    trackProjectSetupStarted({
      projectState,
      source,
      hasFiles: fileCount > 0,
    });
    
    try {
      // Step 1: Initialize git
      const initResult = await InitRepo(repoPath);
      if (!initResult.success) {
        showMessage('error', initResult.error || 'Failed to initialize version control');
        setIsLoading(false);
        return false;
      }
      
      // Step 2: Initialize LFS and add all preset patterns
      try {
        await InitializeLFS(repoPath);
        
        // Get and apply all preset LFS patterns
        const presetPatterns = await GetPresetPatterns();
        for (const preset of presetPatterns) {
          try {
            await TrackPattern(repoPath, preset.pattern);
          } catch (err) {
            console.warn(`Failed to track LFS pattern ${preset.pattern}:`, err);
          }
        }
      } catch (err) {
        console.warn('Failed to initialize LFS:', err);
        // Continue even if LFS setup fails
      }
      
      // Step 3: Create .iofabrik/ directory & ensure local.json is gitignored
      try {
        const directoryResult = await EnsureIOFabrikDir(repoPath);
        if (!directoryResult.success) {
          showMessage('error', directoryResult.error || 'Could not prepare the project settings folder. Check the folder\'s permissions and try again.');
          setIsLoading(false);
          return false;
        }
      } catch (err) {
        console.warn('Failed to ensure .iofabrik directory:', err);
        showMessage('error', 'Could not prepare the project settings folder. Check the folder\'s permissions and try again.');
        setIsLoading(false);
        return false;
      }
      
      // Step 4: Ensure git identity from IOFabrik account
      try {
        const identity = await EnsureIdentity(repoPath, userName || '', userEmail || '');
        cacheGitIdentity(repoPath, identity.name || '', identity.email || '');
      } catch (err) {
        console.warn('Failed to ensure git identity:', err);
        clearCachedGitIdentity();
      }
      
      // Step 5: Make initial commit with all files
      let initialCommitMade = false;
      if (!await ensureProjectDefaultBranch(repoPath)) {
        setIsLoading(false);
        return false;
      }
      const canCreateInitialCommit = await promptForGitIdentityIfMissing(repoPath, 'initial-commit');
      if (canCreateInitialCommit) {
        try {
          const commitResult = await CommitAll(repoPath, 'Initial commit');
          if (commitResult.success) {
            initialCommitMade = true;
          } else {
            console.warn('Failed to make initial commit:', commitResult.error);
            // Continue even if initial commit fails (might have no files to commit)
          }
        } catch (err) {
          console.warn('Failed to make initial commit:', err);
          // Continue even if commit fails
        }
      }
      
      // Refresh repo info
      const info = await DetectRepo(repoPath);
      setRepoInfo(info as RepoInfo);
      
      // Refresh status to show current state
      const status = await Status(repoPath);
      setRepoStatus(status as RepoStatus);
      
      // Track repo initialized
      trackRepoInitialized({
        lfsEnabled: true,
        initialCommitMade,
      });

      // Track project setup completed (Phase 13.2)
      trackProjectSetupCompleted({
        projectState,
        lfsEnabled: true,
        initialCommitMade,
        durationMs: Date.now() - setupStartTime,
      });
      
      showMessage('success', 'Version control enabled');
      setIsLoading(false);
      return true;
    } catch (err) {
      const error = err as Error;
      trackErrorShown({
        errorContext: 'start_tracking',
        actionAttempted: 'start_tracking',
      });
      showMessage('error', `Failed to start tracking: ${error.message || err}`);
      setIsLoading(false);
      return false;
    }
  }, [cacheGitIdentity, clearCachedGitIdentity, clearChangeRequestState, repoPath, repoInfo?.isRepo, repoStatus?.changedFiles?.length, userName, userEmail, showMessage, gitInstalled, lfsInstalled, installRequiredPackages, promptForGitIdentityIfMissing, ensureProjectDefaultBranch]);

  // ===== Commit & Sync Operations =====

  // Save on the active branch after locally validating the project default.
  const commitChanges = useCallback(async (message: string, _force = false): Promise<boolean> => {
    if (previewRunningRef.current) return false;
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }

    if (!message || !message.trim()) {
      showMessage('error', 'Commit message is required');
      return false;
    }

    if (savePendingRef.current) return false;
    savePendingRef.current = true;
    try {
      const session = repoRefreshSession.current;
      const effectiveDefault = await ensureProjectDefaultBranch();
      if (!effectiveDefault || session !== repoRefreshSession.current) return false;
      const hasIdentity = await promptForGitIdentityIfMissing(repoPath, 'save');
      if (!hasIdentity || session !== repoRefreshSession.current) {
        return false;
      }

      const result = await withOperationLock('Saving changes', async () => {
        if (session !== repoRefreshSession.current) return false;
        const info = await DetectRepo(repoPath);
        if (session !== repoRefreshSession.current) return false;
        const currentBranch = info.branch || 'unknown';

        setIsCommitting(true);
        const startTime = Date.now();
        const filesChanged = repoStatus?.changedFiles?.length ?? 0;

        try {
          const result = await CommitAll(repoPath, message);
          if (session !== repoRefreshSession.current) return false;

          if (!result.success) {
            trackCommitCreated({
              success: false,
              filesChanged,
              branchName: currentBranch,
              messageLength: message.length,
              isProtectedBranch: currentBranch === effectiveDefault,
              durationMs: Date.now() - startTime,
              errorType: 'git_error',
            });
            showMessage('error', result.error || 'Failed to save changes');
            return false;
          }

          trackCommitCreated({
            success: true,
            filesChanged,
            branchName: currentBranch,
            messageLength: message.length,
            isProtectedBranch: currentBranch === effectiveDefault,
            durationMs: Date.now() - startTime,
          });

          closeAllExplorerPreviews();

          showMessage('success', 'Changes saved successfully');
          await refreshAll();
          return session === repoRefreshSession.current;
        } catch (err) {
          const error = err as Error;
          trackCommitCreated({
            success: false,
            filesChanged,
            branchName: currentBranch,
            messageLength: message.length,
            isProtectedBranch: currentBranch === effectiveDefault,
            durationMs: Date.now() - startTime,
            errorType: 'exception',
          });
          showMessage('error', `Failed to save: ${error.message || err}`);
          return false;
        } finally {
          setIsCommitting(false);
        }
      });
      return result ?? false;
    } finally {
      savePendingRef.current = false;
    }
  }, [repoPath, repoStatus, ensureProjectDefaultBranch, showMessage, refreshAll, closeAllExplorerPreviews, withOperationLock, promptForGitIdentityIfMissing]);

  // Generate unique operation ID

const generateOperationId = useCallback((): string => {
    operationIdCounter.current += 1;
    return `op-${Date.now()}-${operationIdCounter.current}`;
  }, []);

  // Close progress modal
  const closeProgressModal = useCallback(() => {
    setProgressModal({ isOpen: false, operationId: null, title: '' });
  }, []);

  const runStartupAutoPull = useCallback(async (): Promise<void> => {
    if (!startupAutoPullDueRef.current || startupAutoPullDoneRef.current) return;
    if (!repoPath || !repoInfo?.isRepo || !hasRemote) return;

    const lockResult = await withOperationLock('Pulling latest changes', async () => {
      try {
        const pullResult = await Pull(repoPath);
        if (!pullResult.success) {
          console.warn('Startup auto-pull failed:', pullResult.error || 'unknown error');
          return false;
        }
        await refreshAll();
        return true;
      } catch (err) {
        console.warn('Startup auto-pull failed:', err);
        return false;
      }
    });

    if (lockResult !== null) {
      startupAutoPullDoneRef.current = true;
    }
  }, [repoPath, repoInfo?.isRepo, hasRemote, withOperationLock, refreshAll]);

  // Handle progress modal completion
  const handleProgressComplete = useCallback((success: boolean, error?: string) => {
    const startedAt = syncStartTimeRef.current;
    const durationMs = startedAt ? Math.max(1, Date.now() - startedAt) : 1;
    syncStartTimeRef.current = null;

    closeProgressModal();
    setIsSyncing(false);
    
    if (success) {
      trackSyncCompleted({
        success: true,
        durationMs,
      });
      showMessage('success', 'Synced successfully');
      refreshAll();
    } else if (error) {
      trackSyncFailed({
        errorType: 'sync_error',
        hadConflicts: error.toLowerCase().includes('conflict'),
      });
      showMessage('error', error);
    }
  }, [closeProgressModal, showMessage, refreshAll]);

  // Sync repository with progress
  const syncRepo = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    let isDefaultBranchSync = false;
    try {
      isDefaultBranchSync = await IsDefaultBranchSyncEligible(repoPath);
    } catch {
      // Missing remote-default metadata intentionally keeps the existing Sync path.
    }
    if (isDefaultBranchSync) {
      const confirmed = await promptForDefaultBranchSync(repoInfo?.branch || 'default branch');
      if (!confirmed) {
        return false;
      }
    }

    const result = await withOperationLock('Syncing', async () => {
      const operationId = generateOperationId();
      const currentBranch = repoInfo?.branch || 'unknown';
      const localAhead = repoStatus?.ahead ?? 0;
      const localBehind = repoStatus?.behind ?? 0;
      syncStartTimeRef.current = Date.now();
      
      // Track sync started
      trackSyncStarted({
        branchName: currentBranch,
        localAhead,
        localBehind,
      });
      
      setIsSyncing(true);
      setProgressModal({
        isOpen: true,
        operationId,
        title: 'Syncing with remote',
      });
      
      try {
        // Apply fetch settings from repo configuration (prune stale branches, fetch tags)
        const prune = repoSettings?.fetchPrune ?? true;
        const tags = repoSettings?.fetchTags ?? true;
        const syncResult = await SyncWithProgress(repoPath, operationId, prune, tags);

        if (syncResult.outcome === 'needs-decisions') {
          syncStartTimeRef.current = null;
          closeProgressModal();
          setIsSyncing(false);
          await refreshAll();
          return false;
        }
        
        if (!syncResult.success) {
          return false;
        }

        // Refresh immediately on successful backend completion so sidebar status
        // does not remain in a stale "Push Changes" state if completion events
        // are delayed on some platforms.
        await refreshAll();
        
        return true;
      } catch (err) {
        const error = err as Error;
        syncStartTimeRef.current = null;
        trackSyncFailed({
          errorType: 'exception',
          hadConflicts: false,
        });
        closeProgressModal();
        setIsSyncing(false);
        showMessage('error', `Sync failed: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, repoInfo, repoStatus, repoSettings, showMessage, generateOperationId, closeProgressModal, withOperationLock, refreshAll, promptForDefaultBranchSync]);

  // ===== Diff Operations =====

  // Load diff for a working tree file
  const loadWorkingDiff = useCallback(async (filePath: string): Promise<void> => {
    if (!repoPath || !filePath) {
      setCurrentDiff(null);
      return;
    }
    
    setIsDiffLoading(true);
    setSelectedCommit(null);
    setSelectedCommitFile(null);
    
    try {
      const diff = await DiffWorkingRaw(repoPath, filePath);
      setCurrentDiff(diff as FileDiff);
    } catch (err) {
      const error = err as Error;
      console.error('Failed to load diff:', err);
      setCurrentDiff({ hasError: true, error: error.message || 'Failed to load diff' } as FileDiff);
    } finally {
      setIsDiffLoading(false);
    }
  }, [repoPath]);

  // Load commit details
  const selectCommit = useCallback(async (commitHash: string): Promise<void> => {
    if (!repoPath || !commitHash) {
      setSelectedCommit(null);
      setCurrentDiff(null);
      return;
    }
    
    setIsDiffLoading(true);
    setSelectedFileIndex(null);
    setSelectedCommitFile(null);
    setCurrentDiff(null);
    
    try {
      const detail = await ShowCommit(repoPath, commitHash);
      if (detail.hasError) {
        showMessage('error', detail.error || 'Failed to load commit');
        setSelectedCommit(null);
      } else {
        setSelectedCommit(detail as CommitDetail);
      }
    } catch (err) {
      const error = err as Error;
      console.error('Failed to load commit:', err);
      showMessage('error', `Failed to load commit: ${error.message || err}`);
      setSelectedCommit(null);
    } finally {
      setIsDiffLoading(false);
    }
  }, [repoPath, showMessage]);

  // Load diff for a file within a selected commit
  const loadCommitFileDiff = useCallback(async (filePath: string): Promise<void> => {
    if (!repoPath || !selectedCommit || !filePath) {
      return;
    }
    
    setIsDiffLoading(true);
    setSelectedCommitFile(filePath);
    
    try {
      const diff = await DiffCommitFileRaw(repoPath, selectedCommit.hash, filePath);
      setCurrentDiff(diff as FileDiff);
    } catch (err) {
      const error = err as Error;
      console.error('Failed to load commit file diff:', err);
      setCurrentDiff({ hasError: true, error: error.message || 'Failed to load diff' } as FileDiff);
    } finally {
      setIsDiffLoading(false);
    }
  }, [repoPath, selectedCommit]);

  // Clear all selections
  const clearSelection = useCallback(() => {
    setSelectedFileIndex(null);
    setSelectedCommit(null);
    setSelectedCommitFile(null);
    setCurrentDiff(null);
  }, []);

  // ===== Branch Operations =====

  // Fetch branches
  const refreshBranches = useCallback(async (): Promise<void> => {
    if (!repoPath) return;
    const session = repoRefreshSession.current;
    if (session.path !== repoPath) return;
    
    try {
      const branchList = await Branches(repoPath);
      if (session !== repoRefreshSession.current) return;
      if (!branchList.hasError) {
        setBranches(branchList as BranchList);
      }
    } catch (err) {
      console.error('Failed to fetch branches:', err);
    }
  }, [repoPath]);

  // Switch to existing branch
  const switchBranch = useCallback(async (branchName: string): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    const result = await withOperationLock('Switching branch', async () => {
      const fromBranch = repoInfo?.branch || 'unknown';
      
      try {
        const result = await CheckoutBranch(repoPath, branchName);
        
        if (!result.success) {
          showMessage('error', result.error || 'Failed to switch branch');
          return false;
        }
        
        trackBranchSwitched({
          fromBranch,
          toBranch: branchName,
          usedStash: false,
        });

        closeAllExplorerPreviews();
        
        showMessage('success', result.message || `Switched to ${branchName}`);
        clearSelection();
        await refreshAll();
        await refreshBranches();
        return true;
      } catch (err) {
        const error = err as Error;
        showMessage('error', `Failed to switch branch: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, repoInfo, showMessage, clearSelection, refreshAll, refreshBranches, closeAllExplorerPreviews, withOperationLock]);

  // Create new branch and switch to it
  const createBranch = useCallback(async (branchName: string): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    const result = await withOperationLock('Creating branch', async () => {
      const fromBranch = repoInfo?.branch || 'unknown';
      
      try {
        const result = await CreateBranchAndCheckout(repoPath, branchName);
        
        if (!result.success) {
          showMessage('error', result.error || 'Failed to create branch');
          return false;
        }
        
        trackBranchCreated({
          branchName,
          fromBranch,
          movedUncommittedChanges: false,
        });

        closeAllExplorerPreviews();
        
        showMessage('success', result.message || `Created branch ${branchName}`);
        clearSelection();
        await refreshAll();
        await refreshBranches();
        return true;
      } catch (err) {
        const error = err as Error;
        showMessage('error', `Failed to create branch: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, repoInfo, showMessage, clearSelection, refreshAll, refreshBranches, closeAllExplorerPreviews, withOperationLock]);

  // Rename an existing branch (local + remote when upstream exists)
  const renameBranch = useCallback(async (oldName: string, newName: string): Promise<boolean> => {
    if (previewRunningRef.current) return false;
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }

    try {
      const result = await RenameBranch(repoPath, oldName, newName, true);
      if (!result.success) {
        showMessage('error', result.error || 'Failed to rename branch');
        return false;
      }

      showMessage('success', result.message || `Renamed branch '${oldName}' to '${newName}'`);
      await refreshAll();
      await refreshBranches();
      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to rename branch: ${error.message || err}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll, refreshBranches]);

  // Delete an existing branch (local + remote when upstream exists)
  const deleteBranch = useCallback(async (branchName: string): Promise<boolean> => {
    if (previewRunningRef.current) return false;
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }

    try {
      const result = await DeleteBranch(repoPath, branchName, true);
      if (!result.success) {
        showMessage('error', result.error || 'Failed to delete branch');
        return false;
      }

      showMessage('success', result.message || `Deleted branch '${branchName}'`);
      await refreshAll();
      await refreshBranches();
      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to delete branch: ${error.message || err}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll, refreshBranches]);

  // Create new branch, switch to it, and commit changes
  const branchAndCommit = useCallback(async (branchName: string, message: string): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }

    if (!branchName || !branchName.trim()) {
      showMessage('error', 'Branch name is required');
      return false;
    }

    if (!message || !message.trim()) {
      showMessage('error', 'Commit message is required');
      return false;
    }

    if (savePendingRef.current) return false;
    savePendingRef.current = true;
    try {
      const session = repoRefreshSession.current;
      const effectiveDefault = await ensureProjectDefaultBranch();
      if (!effectiveDefault || session !== repoRefreshSession.current) return false;
      const hasIdentity = await promptForGitIdentityIfMissing(repoPath, 'branch-save');
      if (!hasIdentity || session !== repoRefreshSession.current) {
        return false;
      }

      const result = await withOperationLock('Saving to new branch', async () => {
        if (session !== repoRefreshSession.current) return false;
        const status = await Status(repoPath);
        if (session !== repoRefreshSession.current) return false;
        if (status.hasError) {
          showMessage('error', 'The project could not be checked. Refresh the project and try again.');
          return false;
        }
        if (status.hasUpstream === false && status.totalLocalCommits === 0) {
          showMessage('error', 'Save the first snapshot on the current branch before branching and saving.');
          return false;
        }
        const info = await DetectRepo(repoPath);
        if (session !== repoRefreshSession.current) return false;
        const fromBranch = info.branch || 'unknown';
        const wasOnProtectedBranch = fromBranch === effectiveDefault;
        const filesChanged = repoStatus?.changedFiles?.length ?? 0;

        try {
          const switchResult = await StashAndSwitchBranch(repoPath, branchName.trim(), true);
          if (session !== repoRefreshSession.current) return false;

          if (!switchResult.success) {
            showMessage('error', switchResult.error || 'Failed to create branch and move changes');
            return false;
          }

          const commitResult = await CommitAll(repoPath, message.trim());
          if (session !== repoRefreshSession.current) return false;

          if (!commitResult.success) {
            showMessage('error', commitResult.error || 'Branch created but failed to save changes');
            return false;
          }

          trackCommitBranchAndSave({
            newBranchName: branchName,
            filesChanged,
            wasOnProtectedBranch,
          });

          closeAllExplorerPreviews();

          showMessage('success', `Created branch "${branchName}" and saved changes`);
          clearSelection();
          await refreshAll();
          if (session !== repoRefreshSession.current) return false;
          await refreshBranches();
          return session === repoRefreshSession.current;
        } catch (err) {
          const error = err as Error;
          showMessage('error', `Failed: ${error.message || err}`);
          return false;
        }
      });
      return result ?? false;
    } finally {
      savePendingRef.current = false;
    }
  }, [repoPath, repoStatus, ensureProjectDefaultBranch, showMessage, clearSelection, refreshAll, refreshBranches, closeAllExplorerPreviews, withOperationLock, promptForGitIdentityIfMissing]);


// ===== Recovery Operations =====

  // Undo last commit
  const undoLastCommit = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    const result = await withOperationLock('Undoing last commit', async () => {
      try {
        const result = await ResetSoftHead(repoPath, 1, true);
        
        if (!result.success) {
          showMessage('error', result.error || 'Failed to undo last commit');
          return false;
        }
        
        trackCommitUndone({ commitsResetCount: 1 });
        
        showMessage('success', result.message || 'Undid last commit');
        clearSelection();
        await refreshAll();
        return true;
      } catch (err) {
        const error = err as Error;
        showMessage('error', `Failed to undo: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, showMessage, clearSelection, refreshAll, withOperationLock]);

  // Discard all changes
  const discardAllChanges = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    const result = await withOperationLock('Discarding changes', async () => {
      const filesDiscarded = repoStatus?.changedFiles?.length ?? 0;
      
      try {
        const result = await DiscardAll(repoPath, true);
        
        if (!result.success) {
          showMessage('error', result.error || 'Failed to discard changes');
          return false;
        }
        
        trackChangesDiscarded({
          filesDiscarded,
          wasPartial: false,
        });
        
        showMessage('success', result.message || 'All changes discarded');
        clearSelection();
        await refreshAll();
        return true;
      } catch (err) {
        const error = err as Error;
        showMessage('error', `Failed to discard: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, repoStatus, showMessage, clearSelection, refreshAll, withOperationLock]);

  // Rewind to last snapshot
  const rewindToLastSnapshot = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    const result = await withOperationLock('Rewinding', async () => {
      try {
        const result = await ResetHardHead(repoPath, true);
        
        if (!result.success) {
          showMessage('error', result.error || 'Failed to rewind');
          return false;
        }
        
        showMessage('success', result.message || 'Rewound to last snapshot');
        clearSelection();
        await refreshAll();
        return true;
      } catch (err) {
        const error = err as Error;
        showMessage('error', `Failed to rewind: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, showMessage, clearSelection, refreshAll, withOperationLock]);

  // Discard changes to a single file
  const discardFileChanges = useCallback(async (filePath: string): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    
    const result = await withOperationLock('Discarding file changes', async () => {
      try {
        const result = await DiscardFile(repoPath, filePath, true);
        
        if (!result.success) {
          showMessage('error', result.error || 'Failed to discard file changes');
          return false;
        }
        
        trackChangesDiscarded({
          filesDiscarded: 1,
          wasPartial: true,
        });
        
        showMessage('success', result.message || `Discarded changes to ${filePath}`);
        setSelectedFileIndex(null);
        setCurrentDiff(null);
        await refreshStatus();
        return true;
      } catch (err) {
        const error = err as Error;
        showMessage('error', `Failed to discard: ${error.message || err}`);
        return false;
      }
    });
    return result ?? false;
  }, [repoPath, showMessage, refreshStatus, withOperationLock]);

  // ===== Conflict Checking Operations =====

  const loadMergeReviewFiles = useCallback(async (
    targetBranch = '',
    sourceBranch = '',
  ): Promise<MergeReviewFile[]> => {
    if (!repoPath) {
      return [];
    }

    const target = targetBranch || conflictCheckResult?.targetBranch || conflictCheckResult?.parentBranch || detectedParentBranch?.name;
    const source = sourceBranch || conflictCheckResult?.sourceBranch || repoInfo?.branch;

    if (!target || !source) {
      setMergeReviewFiles([]);
      return [];
    }

    setIsLoadingMergeReviewFiles(true);
    try {
      const files = await ListMergeReviewFiles(repoPath, target, source);
      const normalized = (files || []) as MergeReviewFile[];
      setMergeReviewFiles(normalized);
      return normalized;
    } catch (err) {
      const error = err as Error;
      console.error('Failed to load merge review files:', error.message || err);
      setMergeReviewFiles([]);
      return [];
    } finally {
      setIsLoadingMergeReviewFiles(false);
    }
  }, [repoPath, conflictCheckResult, detectedParentBranch, repoInfo?.branch]);

  const loadMergeReviewFileDiff = useCallback(async (
    filePath: string,
    targetBranch = '',
    sourceBranch = '',
  ): Promise<MergeReviewDiffResult | null> => {
    if (!repoPath || !filePath) {
      return null;
    }

    const target = targetBranch || conflictCheckResult?.targetBranch || conflictCheckResult?.parentBranch || detectedParentBranch?.name;
    const source = sourceBranch || conflictCheckResult?.sourceBranch || repoInfo?.branch;

    if (!target || !source) {
      return null;
    }

    try {
      const result = await DiffMergeReviewFileRaw(repoPath, target, source, filePath);
      return normalizeMergeReviewDiffResult(
        filePath,
        target,
        source,
        result as Partial<MergeReviewDiffResult> | null,
      );
    } catch (err) {
      const error = err as Error;
      console.error('Failed to load merge review diff:', error.message || err);
      return null;
    }
  }, [repoPath, conflictCheckResult, detectedParentBranch, repoInfo?.branch]);

  // Check for merge conflicts (DRY-RUN ONLY)
  const checkConflictsOnly = useCallback(async (
    targetBranch = '', 
    sourceBranch = '', 
    options: MergeOptions = {}
  ): Promise<BranchConflictCheckResult | null> => {
    const { squash = isSquashMerge } = options;
    
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return null;
    }
    
    setIsCheckingConflicts(true);
    setConflictedFiles([]);
    setSelectedConflictFile(null);
    setConflictCheckResult(null);
    setConflictSidesInfo(null);
    setMergeReviewFiles([]);
    
    try {
      const result = await CheckBranchConflicts(repoPath, targetBranch, sourceBranch);
      
      const resultWithSquash = { ...result, isSquashMerge: squash, liveMergePhase: 'dry-run' } as BranchConflictCheckResult;
      setConflictCheckResult(resultWithSquash);
      
      if (result.targetBranch || result.parentBranch) {
        setDetectedParentBranch({
          name: result.targetBranch || result.parentBranch,
          source: 'auto-detected',
        });
        
        try {
          const sidesInfo = await GetConflictSidesInfo(repoPath, result.targetBranch || result.parentBranch);
          if (sidesInfo.success) {
            setConflictSidesInfo(sidesInfo as ConflictSidesInfo);
          }
        } catch (sidesErr) {
          console.error('Failed to get conflict sides info:', sidesErr);
        }
      }
      
      if (!result.success) {
        showMessage('error', result.error || 'Failed to check conflicts');
        setIsCheckingConflicts(false);
        return resultWithSquash;
      }

      await loadMergeReviewFiles(result.targetBranch || result.parentBranch, result.sourceBranch || repoInfo?.branch || '');
      
      const target = result.targetBranch || result.parentBranch;
      const source = result.sourceBranch || repoInfo?.branch;
      
      if (result.hasConflicts) {
        setConflictedFiles((result.conflictedFiles || []) as ConflictedFile[]);
        
        // Track conflict detected
        trackConflictDetected({
          conflictedFilesCount: result.conflictedFiles?.length || 0,
          conflictSource: 'merge',
        });
        
        showMessage('info', `Found ${result.conflictedFiles?.length || 0} potential conflict(s) when merging ${source} → ${target}`);
      }
      
      setIsCheckingConflicts(false);
      return resultWithSquash;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to check conflicts: ${error.message || err}`);
      setIsCheckingConflicts(false);
      return null;
    }
  }, [repoPath, showMessage, isSquashMerge, repoInfo?.branch, loadMergeReviewFiles]);

  // Start the actual merge process
  const startMerge = useCallback(async (
    targetBranch = '', 
    sourceBranch = '', 
    options: MergeOptions = {}
  ): Promise<StartMergeResult | null> => {
    const {
      squash = isSquashMerge,
      selective = false,
      selectedFiles = [],
    } = options;
    
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return null;
    }
    
    const target = targetBranch || conflictCheckResult?.targetBranch || conflictCheckResult?.parentBranch || detectedParentBranch?.name;
    const source = sourceBranch || conflictCheckResult?.sourceBranch || repoInfo?.branch;
    const mergeType = squash ? 'Squash merge' : 'Merge';
    
    if (!target) {
      showMessage('error', 'No target branch specified. Please check for conflicts first.');
      return null;
    }
    
    setIsCheckingConflicts(true);
    
    try {
      const mergeResult = await StartMergeWithOptions(repoPath, target, source || '', {
        squash,
        selective,
        selectedFiles,
      });
      
      if (!mergeResult.success) {
        const errorMsg = mergeResult.error || mergeResult.message || 'Failed to start merge';
        showMessage('error', errorMsg);
        setConflictCheckResult(prev => prev ? { ...prev, success: false, error: errorMsg, mergeStarted: false, liveMergePhase: 'dry-run' } : null);
        setIsCheckingConflicts(false);
        return null;
      }
      
      if (mergeResult.error === 'already_up_to_date') {
        showMessage('info', `${target} already contains all changes from ${source} - nothing to merge`);
        setConflictCheckResult(prev => prev ? { ...prev, success: true, alreadyUpToDate: true, mergeStarted: false, liveMergePhase: 'dry-run' } : null);
        setIsCheckingConflicts(false);
        return { success: true, alreadyUpToDate: true, liveMergePhase: 'dry-run' };
      }
      
      if (mergeResult.error === 'auto_completed') {
        showMessage('success', `Merged ${source} into ${target} successfully`);
        setConflictCheckResult(prev => prev ? {
          ...prev,
          success: true,
          autoCompleted: true,
          mergeStarted: true,
          liveMergePhase: 'auto-completed',
        } : null);
        await refreshAll();
        setIsCheckingConflicts(false);
        return { success: true, autoCompleted: true, liveMergePhase: 'auto-completed' };
      }

      setConflictCheckResult((previous) => previous ? {
        ...previous,
        mergeStarted: true,
        liveMergePhase: 'starting',
      } : {
        hasConflicts: false,
        conflictedFiles: [],
        parentBranch: target,
        targetBranch: target,
        sourceBranch: source || '',
        success: true,
        isSquashMerge: squash,
        mergeStarted: true,
        liveMergePhase: 'starting',
      });

      const reconciledMerge = await reconcileLiveMergeState(target, source || '', {
        squash,
        preserveConflictPreview: true,
      });

      if (reconciledMerge.liveMergePhase === 'resolving') {
        showMessage(
          'info',
          `${mergeType} started: ${source} → ${target} with ${reconciledMerge.conflictedFiles.length} conflict(s) to resolve`,
        );
      } else if (reconciledMerge.liveMergePhase === 'ready-to-complete') {
        showMessage('success', `${mergeType} started - ready to complete`);
      } else {
        showMessage('info', 'Merge started. Preparing the conflict list...');
      }

      setIsCheckingConflicts(false);
      return {
        success: true,
        hasConflicts: reconciledMerge.liveMergePhase !== 'ready-to-complete',
        liveMergePhase: reconciledMerge.liveMergePhase,
      };
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to start merge: ${error.message || err}`);
      setIsCheckingConflicts(false);
      return null;
    }
  }, [repoPath, showMessage, isSquashMerge, conflictCheckResult, detectedParentBranch, repoInfo?.branch, refreshAll, reconcileLiveMergeState]);

  // Legacy function for backward compatibility
  const checkBranchConflicts = useCallback(async (
    targetBranch = '', 
    sourceBranch = '', 
    options: MergeOptions = {}
  ): Promise<BranchConflictCheckResult | null> => {
    const checkResult = await checkConflictsOnly(targetBranch, sourceBranch, options);
    if (!checkResult || !checkResult.success) {
      return checkResult;
    }
    const mergeResult = await startMerge(targetBranch, sourceBranch, options);
    if (!mergeResult) {
      return null;
    }
    return { ...checkResult, ...mergeResult };
  }, [checkConflictsOnly, startMerge]);

  // Get parent branch info
  const fetchParentBranch = useCallback(async (): Promise<ParentBranchResult | null> => {
    if (!repoPath) return null;
    
    try {
      const result = await GetParentBranch(repoPath);
      if (result.parentBranch) {
        setDetectedParentBranch({
          name: result.parentBranch,
          source: result.source || 'auto-detected',
        });
        return result as ParentBranchResult;
      }
      return null;
    } catch (err) {
      console.error('Failed to detect parent branch:', err);
      return null;
    }
  }, [repoPath]);

  useEffect(() => {
    setMergeReviewFiles([]);
    setIsLoadingMergeReviewFiles(false);
  }, [repoInfo?.branch]);

  // Set resolution strategy for a file
  const setFileResolution = useCallback((filePath: string, strategy: ResolutionStrategy) => {
    setFileResolutions(prev => ({ ...prev, [filePath]: strategy }));
  }, []);

  const loadConflictResolutionData = useCallback(async (filePath: string): Promise<ConflictResolutionData | null> => {
    if (!repoPath || !filePath) {
      showMessage('error', 'Invalid file path');
      return null;
    }

    try {
      const result = await GetConflictResolutionData(repoPath, filePath);
      return mapConflictResolutionData(result);
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to load conflict details: ${error.message || err}`);
      return null;
    }
  }, [repoPath, showMessage]);

  const resolveConflictWithDecisions = useCallback(async (
    filePath: string,
    token: string,
    decisions: Record<string, ConflictRegionDecision>,
  ): Promise<boolean> => {
    if (!repoPath || !filePath || !token) {
      showMessage('error', 'Invalid conflict resolution data');
      return false;
    }

    setIsResolvingConflict(true);
    try {
      const result = await ResolveConflictWithDecisions(repoPath, filePath, token, toConflictDecisionPayload(decisions));

      if (!result.success) {
        showMessage('error', result.error || result.message || 'Failed to resolve conflict');
        return false;
      }

      trackConflictResolved({ resolutionStrategy: 'manual' });

      const reconciledMerge = await reconcileLiveMergeState(
        conflictCheckResult?.targetBranch || conflictCheckResult?.parentBranch || detectedParentBranch?.name || '',
        conflictCheckResult?.sourceBranch || repoInfo?.branch || '',
        {
          squash: conflictCheckResult?.isSquashMerge ?? isSquashMerge,
          preserveConflictPreview: false,
        },
      );

      if (reconciledMerge.liveMergePhase === 'ready-to-complete') {
        showMessage('success', 'All conflict choices are saved. Add a merge message and finish.');
      } else {
        showMessage(
          'success',
          result.message || `Resolved "${filePath.split('/').pop()}". ${reconciledMerge.conflictedFiles.length} file(s) still need a choice.`,
        );
      }

      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to resolve: ${error.message || err}`);
      return false;
    } finally {
      setIsResolvingConflict(false);
    }
  }, [repoPath, showMessage, reconcileLiveMergeState, conflictCheckResult, detectedParentBranch, repoInfo?.branch, isSquashMerge]);

  // Apply resolution for a single file
  const resolveConflict = useCallback(async (filePath: string, strategy: ResolutionStrategy): Promise<boolean> => {
    if (!repoPath || !filePath) {
      showMessage('error', 'Invalid file path');
      return false;
    }

    setIsResolvingConflict(true);
    try {
      let result;
      if (strategy === 'mine') {
        result = await ResolveConflictKeepOurs(repoPath, filePath);
      } else if (strategy === 'theirs') {
        result = await ResolveConflictKeepTheirs(repoPath, filePath);
      } else if (strategy === 'both') {
        result = await ResolveConflictKeepBoth(repoPath, filePath);
      } else {
        showMessage('error', 'Invalid resolution strategy');
        setIsResolvingConflict(false);
        return false;
      }

      if (!result.success) {
        showMessage('error', result.error || result.message || 'Failed to resolve conflict');
        setIsResolvingConflict(false);
        return false;
      }

      // Track conflict resolution
      trackConflictResolved({
        resolutionStrategy: strategy === 'mine' ? 'ours' : strategy === 'theirs' ? 'theirs' : 'both',
      });

      setFileResolutions(prev => ({ ...prev, [filePath]: strategy }));

      const reconciledMerge = await reconcileLiveMergeState(
        conflictCheckResult?.targetBranch || conflictCheckResult?.parentBranch || detectedParentBranch?.name || '',
        conflictCheckResult?.sourceBranch || repoInfo?.branch || '',
        {
          squash: conflictCheckResult?.isSquashMerge ?? isSquashMerge,
          preserveConflictPreview: false,
        },
      );

      if (reconciledMerge.liveMergePhase === 'ready-to-complete') {
        showMessage('success', 'All conflict choices are saved. Add a merge message and finish.');
      } else {
        showMessage(
          'success',
          result.message || `Resolved "${filePath.split('/').pop()}". ${reconciledMerge.conflictedFiles.length} file(s) still need a choice.`,
        );
      }

      setIsResolvingConflict(false);
      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to resolve: ${error.message || err}`);
      setIsResolvingConflict(false);
      return false;
    }
  }, [repoPath, showMessage, reconcileLiveMergeState, conflictCheckResult, detectedParentBranch, repoInfo?.branch, isSquashMerge]);

  // Apply all pending resolutions
  const applyAllResolutions = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;

    const pending = conflictedFiles.filter(f => fileResolutions[f.path] && fileResolutions[f.path] !== 'both');
    
    if (pending.length === 0) {
      showMessage('info', 'No resolutions to apply');
      return false;
    }

    setIsResolvingConflict(true);
    let successCount = 0;
    
    for (const file of pending) {
      const strategy = fileResolutions[file.path];
      const success = await resolveConflict(file.path, strategy);
      if (success) successCount++;
    }

    setIsResolvingConflict(false);
    
    if (successCount === pending.length) {
      showMessage('success', `Resolved ${successCount} file(s)`);
      return true;
    } else {
      showMessage('warning', `Resolved ${successCount} of ${pending.length} file(s)`);
      return false;
    }
  }, [repoPath, conflictedFiles, fileResolutions, resolveConflict, showMessage]);

  // Abort the current merge
  const abortMerge = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }

    const conflictsRemaining = conflictedFiles.length;
    // Remember the original branch so we can switch back after abort
    const originalBranch = conflictCheckResult?.sourceBranch;

    try {
      const result = await AbortMerge(repoPath);
      
      if (!result.success) {
        showMessage('error', result.error || result.message || 'Failed to abort merge');
        return false;
      }

      trackMergeAborted({ conflictsRemaining });

      // Switch back to the original branch (merge checks out target, so we need to go back)
      if (originalBranch) {
        try {
          const checkoutResult = await CheckoutBranch(repoPath, originalBranch);
          if (checkoutResult.success) {
            showMessage('success', `Merge aborted — switched back to ${originalBranch}`);
          } else {
            showMessage('success', result.message || 'Merge aborted');
            console.warn('[abortMerge] Could not switch back to original branch:', checkoutResult.error || checkoutResult.message);
          }
        } catch (checkoutErr) {
          showMessage('success', result.message || 'Merge aborted');
          console.warn('[abortMerge] Error switching back to original branch:', checkoutErr);
        }
      } else {
        showMessage('success', result.message || 'Merge aborted');
      }

      clearConflicts();
      await refreshStatus();
      await refreshBranches();
      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to abort merge: ${error.message || err}`);
      return false;
    }
  }, [repoPath, conflictedFiles, conflictCheckResult, showMessage, clearConflicts, refreshStatus, refreshBranches]);

  // Complete the merge with a commit message
  const completeMerge = useCallback(async (message: string): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }

    const unresolvedCount = conflictedFiles.filter(f => !fileResolutions[f.path]).length;
    if (unresolvedCount > 0) {
      showMessage('error', `${unresolvedCount} file(s) still need resolution`);
      return false;
    }

    const parentBranchName = detectedParentBranch?.name;
    const totalConflicts = conflictedFiles.length;
    const strategiesUsed = Object.values(fileResolutions).filter(Boolean) as string[];
    const liveTargetBranch = conflictCheckResult?.targetBranch || conflictCheckResult?.parentBranch || detectedParentBranch?.name || '';
    const liveSourceBranch = conflictCheckResult?.sourceBranch || repoInfo?.branch || '';

    try {
      const reconciledMerge = await reconcileLiveMergeState(liveTargetBranch, liveSourceBranch, {
        squash: conflictCheckResult?.isSquashMerge ?? isSquashMerge,
        preserveConflictPreview: false,
      });

      if (reconciledMerge.mergeState.hasConflicts || reconciledMerge.conflictedFiles.length > 0) {
        const liveUnresolvedCount = reconciledMerge.conflictedFiles.length || 1;
        showMessage(
          'error',
          liveUnresolvedCount === 1
            ? '1 file still needs a choice before you can finish this merge.'
            : `${liveUnresolvedCount} files still need a choice before you can finish this merge.`,
        );
        return false;
      }

      const hasIdentity = await promptForGitIdentityIfMissing(repoPath, 'merge-complete');
      if (!hasIdentity) {
        return false;
      }

      // CompleteMerge handles both regular and squash merges on the backend
      const result = await CompleteMerge(repoPath, message || '');
      
      if (!result.success) {
        showMessage('error', result.error || result.message || 'Failed to complete merge');
        return false;
      }

      // Track merge completed
      trackMergeCompleted({
        totalConflicts,
        resolutionStrategiesUsed: strategiesUsed,
      });

      showMessage('success', 'Branch is merged and available to the team');
      clearConflicts();
      clearSelection();
      await refreshAll();
      await refreshBranches();

      if (parentBranchName) {
        try {
          const checkoutResult = await CheckoutBranch(repoPath, parentBranchName);
          if (checkoutResult.success) {
            showMessage('success', `Switched to ${parentBranchName}`);
            await refreshAll();
            await refreshBranches();
          }
        } catch (checkoutErr) {
          console.error('[completeMerge] Error switching to parent branch:', checkoutErr);
        }
      }

      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to complete merge: ${error.message || err}`);
      return false;
    }
  }, [
    repoPath,
    conflictedFiles,
    fileResolutions,
    showMessage,
    clearConflicts,
    clearSelection,
    refreshAll,
    refreshBranches,
    detectedParentBranch,
    conflictCheckResult,
    repoInfo?.branch,
    reconcileLiveMergeState,
    isSquashMerge,
    promptForGitIdentityIfMissing,
  ]);

  // Refresh merge state from backend
  const refreshMergeState = useCallback(async (): Promise<MergeState | null> => {
    if (!repoPath) return null;
    
    try {
      const state = await GetMergeState(repoPath);
      setMergeState(state as MergeState);
      return state as MergeState;
    } catch (err) {
      console.error('Failed to get merge state:', err);
      return null;
    }
  }, [repoPath]);

  // ===== Stuck State Recovery Actions =====

  const abortCurrentOperation = useCallback(async (): Promise<boolean> => {
    if (!repoPath) {
      showMessage('error', 'No repository open');
      return false;
    }
    try {
      const result = await AbortCurrentOperation(repoPath);
      if (!result.success) {
        showMessage('error', result.error || result.message || 'Failed to abort operation');
        return false;
      }
      showMessage('success', result.message || 'Operation aborted');
      clearConflicts();
      await refreshAll();
      return true;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to abort operation: ${error.message || err}`);
      return false;
    }
  }, [repoPath, showMessage, clearConflicts, refreshAll]);

  const abortCherryPick = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await AbortCherryPick(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to abort cherry-pick: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const continueCherryPick = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await ContinueCherryPick(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to continue cherry-pick: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const skipCherryPickCommit = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await SkipCherryPickCommit(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to skip commit: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const abortRevert = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await AbortRevert(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to abort revert: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const continueRevert = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await ContinueRevert(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to continue revert: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const skipRevertCommit = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await SkipRevertCommit(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to skip commit: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const revertCommit = useCallback(async (commitHash: string): Promise<boolean> => {
    if (previewRunningRef.current) return false;
    if (!repoPath) return false;
    try {
      const result = await RevertCommit(repoPath, commitHash);
      if (result.success) {
        closeAllExplorerPreviews();
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to revert commit: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll, closeAllExplorerPreviews]);

  const abortBisect = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await AbortBisect(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to abort bisect: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const getBisectState = useCallback(async (): Promise<BisectState | null> => {
    if (!repoPath) return null;
    try {
      return await GetBisectState(repoPath) as BisectState;
    } catch (err) {
      console.error('Failed to get bisect state:', err);
      return null;
    }
  }, [repoPath]);

  const abortAM = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await AbortAM(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to abort patch application: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const skipAMPatch = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await SkipAMPatch(repoPath);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to skip patch: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  const createBranchFromDetached = useCallback(async (branchName: string): Promise<boolean> => {
    if (!repoPath) return false;
    if (!branchName) {
      showMessage('error', 'Branch name is required');
      return false;
    }
    try {
      const result = await CreateBranchFromDetached(repoPath, branchName);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        await refreshBranches();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to create branch: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll, refreshBranches]);

  const removeAllStaleLocks = useCallback(async (): Promise<boolean> => {
    if (!repoPath) return false;
    try {
      const result = await RemoveAllStaleLocks(repoPath, true);
      if (result.success) {
        showMessage('success', result.message);
        await refreshAll();
        return true;
      }
      showMessage('error', result.error || result.message);
      return false;
    } catch (err) {
      const error = err as Error;
      showMessage('error', `Failed to remove lock files: ${error.message}`);
      return false;
    }
  }, [repoPath, showMessage, refreshAll]);

  // ===== GitHub Handlers (Phase 2) =====

  // Login to GitHub
  const loginGitHub = useCallback(async (): Promise<GitHubAuthResult> => {
    try {
      const result = await AuthLogin();
      if (result.success) {
        // Refresh auth status after login
        await checkGitHubAuth();
        showMessage('success', 'Successfully connected to GitHub');
      } else {
        showMessage('error', result.error || 'GitHub login failed');
      }
      return result as GitHubAuthResult;
    } catch (err) {
      const error = err as Error;
      const result: GitHubAuthResult = {
        success: false,
        error: error.message || 'GitHub login failed',
      };
      showMessage('error', result.error!);
      return result;
    }
  }, [checkGitHubAuth, showMessage]);

  // Start GitHub login (device flow) - returns verification code
  const startGitHubLogin = useCallback(async (): Promise<GitHubDeviceFlowResult> => {
    // Every entry point shares one backend attempt and must have one dialog owner.
    if (gitHubLoginStartRef.current) {
      return { success: false, cancelled: true };
    }
    gitHubLoginStartRef.current = true;
    setIsStartingGitHubLogin(true);
    try {
      const result = await AuthLoginStart();
      return result as GitHubDeviceFlowResult;
    } catch {
      return {
        success: false,
        error: 'GitHub sign-in could not start. Try connecting again.',
      };
    } finally {
      gitHubLoginStartRef.current = false;
      setIsStartingGitHubLogin(false);
    }
  }, []);

  // Complete GitHub login (check if auth completed)
  const completeGitHubLogin = useCallback(async (): Promise<GitHubAuthResult> => {
    try {
      const result = await AuthLoginComplete();
      if (result.success) {
        await checkGitHubAuth();
        showMessage('success', 'Successfully connected to GitHub');
      }
      return result as GitHubAuthResult;
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        error: error.message || 'GitHub login not completed',
      };
    }
  }, [checkGitHubAuth, showMessage]);

  // Cancel GitHub login (abort in-progress device flow)
  const cancelGitHubLogin = useCallback(async (): Promise<GitHubAuthResult> => {
    try {
      const result = await AuthLoginCancel();
      return result as GitHubAuthResult;
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        error: error.message || 'Failed to cancel GitHub login',
      };
    }
  }, []);

  // Logout from GitHub
  const logoutGitHub = useCallback(async (): Promise<GitHubAuthResult> => {
    try {
      const result = await AuthLogout();
      if (result.success) {
        resetGitHubAuth();
        setGhRepos([]);
        await checkGitHubAuth();
        showMessage('success', 'Disconnected from GitHub');
      } else {
        showMessage('error', result.error || 'GitHub logout failed');
      }
      return result as GitHubAuthResult;
    } catch (err) {
      const error = err as Error;
      const result: GitHubAuthResult = {
        success: false,
        error: error.message || 'GitHub logout failed',
      };
      showMessage('error', result.error!);
      return result;
    }
  }, [checkGitHubAuth, resetGitHubAuth, showMessage]);

  // Load GitHub repositories
  const loadGitHubRepos = useCallback(async (
    limit = 30,
    visibility = ''
  ): Promise<GitHubRepoListResult> => {
    setIsLoadingGhRepos(true);
    try {
      const result = await RepoList(limit, visibility);
      if (result.success) {
        setGhRepos((result.repos || []) as GitHubRepo[]);
      } else {
        showMessage('error', result.error || 'Failed to load repositories');
      }
      return result as GitHubRepoListResult;
    } catch (err) {
      const error = err as Error;
      const result: GitHubRepoListResult = {
        success: false,
        repos: [],
        error: error.message || 'Failed to load repositories',
      };
      showMessage('error', result.error!);
      return result;
    } finally {
      setIsLoadingGhRepos(false);
    }
  }, [showMessage]);

  const loadChangeRequests = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      clearChangeRequestState();
      return;
    }

    const loadId = changeRequestLoadIdRef.current + 1;
    changeRequestLoadIdRef.current = loadId;
    setIsLoadingChangeRequests(true);
    setChangeRequestError(null);

    const setError = (code: GitHubChangeRequestErrorCode, message?: string): void => {
      if (changeRequestLoadIdRef.current === loadId) {
        setChangeRequestError({ code, message });
      }
    };

    try {
      const installed = await IsGHInstalled();
      if (changeRequestLoadIdRef.current !== loadId) return;
      setGhInstalled(installed);
      if (!installed) {
        setError('gh_unavailable');
        return;
      }

      const viewerResult = await GetAuthenticatedUser();
      if (changeRequestLoadIdRef.current !== loadId) return;
      if (!viewerResult.success || !viewerResult.user?.login) {
        setError(viewerResult.errorCode as GitHubChangeRequestErrorCode, viewerResult.error);
        return;
      }

      const listResult = await ListChangeRequests(repoPath);
      if (changeRequestLoadIdRef.current !== loadId) return;
      if (!listResult.success) {
        setError(listResult.errorCode as GitHubChangeRequestErrorCode, listResult.error);
        return;
      }

      const orderedRequests = [...listResult.changeRequests]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      setChangeRequestViewerLogin(viewerResult.user.login);
      setChangeRequestRepository(listResult.repository ?? null);
      setChangeRequests(orderedRequests);
      setOmittedExternalChangeRequestCount(listResult.omittedExternalCount);
      setChangeRequestsMayHaveMore(listResult.mayHaveMore);

      // A request that was merged or closed elsewhere no longer needs its
      // downloaded refs kept on disk.
      const openRequest = selectedChangeRequestRef.current;
      if (openRequest && !orderedRequests.some((entry) => entry.number === openRequest.number)) {
        void ClearChangeRequestSnapshot(repoPath, openRequest.number);
      }
    } catch (error) {
      if (changeRequestLoadIdRef.current === loadId) {
        setChangeRequestError({
          code: 'internal_error',
          message: error instanceof Error ? error.message : 'Unable to load Change Requests.',
        });
      }
    } finally {
      if (changeRequestLoadIdRef.current === loadId) {
        setIsLoadingChangeRequests(false);
      }
    }
  }, [clearChangeRequestState, repoPath]);

  const prepareChangeRequestSnapshot = useCallback(async (
    request: GitHubChangeRequest,
    loadId: number,
  ): Promise<void> => {
    if (!repoPath) return;

    setIsPreparingChangeRequestSnapshot(true);
    setChangeRequestSnapshot(null);
    setChangeRequestSnapshotError(null);

    try {
      const result = await EnsureChangeRequestSnapshotsLocal(
        repoPath,
        request.number,
        request.baseRefName,
        request.headRefOid,
        request.isCrossRepository,
      );
      if (changeRequestDetailLoadIdRef.current !== loadId) return;
      if (!result.success || !result.snapshot) {
        setChangeRequestSnapshotError({
          code: result.errorCode as GitHubChangeRequestErrorCode,
          message: result.error,
        });
        return;
      }
      setChangeRequestSnapshot(result.snapshot as ChangeRequestSnapshot);
    } catch (error) {
      if (changeRequestDetailLoadIdRef.current === loadId) {
        setChangeRequestSnapshotError({
          code: 'internal_error',
          message: error instanceof Error ? error.message : 'Unable to download the Change Request contents.',
        });
      }
    } finally {
      if (changeRequestDetailLoadIdRef.current === loadId) {
        setIsPreparingChangeRequestSnapshot(false);
      }
    }
  }, [repoPath]);

  const selectChangeRequest = useCallback(async (number: number): Promise<void> => {
    if (!repoPath) return;

    const loadId = changeRequestDetailLoadIdRef.current + 1;
    changeRequestDetailLoadIdRef.current = loadId;
    setIsLoadingChangeRequestDetail(true);
    setChangeRequestDetailError(null);
    setChangeRequestFiles([]);
    setChangeRequestTotalFiles(0);
    setIsChangeRequestFilesTruncated(false);
    setSelectedChangeRequestFilePath(null);
    setChangeRequestSnapshot(null);
    setChangeRequestSnapshotError(null);
    setIsPreparingChangeRequestSnapshot(false);

    const setDetailError = (code: GitHubChangeRequestErrorCode, message?: string): void => {
      if (changeRequestDetailLoadIdRef.current === loadId) {
        setChangeRequestDetailError({ code, message });
      }
    };

    try {
      const detailResult = await GetChangeRequest(repoPath, number);
      if (changeRequestDetailLoadIdRef.current !== loadId) return;
      if (!detailResult.success || !detailResult.changeRequest) {
        setSelectedChangeRequest(null);
        setDetailError(detailResult.errorCode as GitHubChangeRequestErrorCode, detailResult.error);
        return;
      }
      setSelectedChangeRequest(detailResult.changeRequest as GitHubChangeRequest);

      const filesResult = await ListChangeRequestFiles(repoPath, number);
      if (changeRequestDetailLoadIdRef.current !== loadId) return;
      if (!filesResult.success) {
        setDetailError(filesResult.errorCode as GitHubChangeRequestErrorCode, filesResult.error);
        return;
      }
      setChangeRequestFiles(filesResult.files as GitHubChangeRequestFile[]);
      setChangeRequestTotalFiles(filesResult.totalFiles);
      setIsChangeRequestFilesTruncated(filesResult.isTruncated);

      // Download the comparison refs in the background so the summary and file
      // list stay usable while the contents arrive.
      void prepareChangeRequestSnapshot(detailResult.changeRequest as GitHubChangeRequest, loadId);
    } catch (error) {
      if (changeRequestDetailLoadIdRef.current === loadId) {
        setSelectedChangeRequest(null);
        setDetailError('internal_error', error instanceof Error ? error.message : 'Unable to load Change Request details.');
      }
    } finally {
      if (changeRequestDetailLoadIdRef.current === loadId) {
        setIsLoadingChangeRequestDetail(false);
      }
    }
  }, [prepareChangeRequestSnapshot, repoPath]);

  const selectChangeRequestFile = useCallback((path: string | null): void => {
    setSelectedChangeRequestFilePath(path);
  }, []);

  const returnToChangeRequestOverview = useCallback((): void => {
    changeRequestDetailLoadIdRef.current += 1;
    setSelectedChangeRequest(null);
    setChangeRequestFiles([]);
    setChangeRequestTotalFiles(0);
    setIsChangeRequestFilesTruncated(false);
    setSelectedChangeRequestFilePath(null);
    setIsLoadingChangeRequestDetail(false);
    setChangeRequestDetailError(null);
    setChangeRequestSnapshot(null);
    setIsPreparingChangeRequestSnapshot(false);
    setChangeRequestSnapshotError(null);
  }, []);

  // Determine whether Home may offer Create Change Request for
  // the current synced feature branch. Ineligible outcomes carry a code and
  // message so the button can be shown disabled with guidance rather than hidden.
  const checkChangeRequestCreateEligibility = useCallback(async (
    _sourceBranch: string,
  ): Promise<ChangeRequestCreateEligibility> => {
    if (!repoPath) {
      const unknown: ChangeRequestCreateEligibility = { status: 'unknown' };
      setChangeRequestCreateEligibility(unknown);
      return unknown;
    }

    try {
      const installed = await IsGHInstalled();
      setGhInstalled(installed);
      if (!installed) {
        const result: ChangeRequestCreateEligibility = {
          status: 'ineligible',
          code: 'gh_unavailable',
          message: 'Connect GitHub tools to create Change Requests.',
        };
        setChangeRequestCreateEligibility(result);
        return result;
      }

      const viewer = await GetAuthenticatedUser();
      if (!viewer.success || !viewer.user?.login) {
        const result: ChangeRequestCreateEligibility = {
          status: 'ineligible',
          code: (viewer.errorCode as GitHubChangeRequestErrorCode) || 'auth_required',
          message: 'Connect to GitHub to create Change Requests.',
        };
        setChangeRequestCreateEligibility(result);
        return result;
      }

      const repository = await GetChangeRequestRepository(repoPath);
      if (!repository.success) {
        const result: ChangeRequestCreateEligibility = {
          status: 'ineligible',
          code: repository.errorCode as GitHubChangeRequestErrorCode,
          message: repository.error || 'Change Requests need a GitHub connection.',
        };
        setChangeRequestCreateEligibility(result);
        return result;
      }

      const result: ChangeRequestCreateEligibility = {
        status: 'eligible',
        repository: (repository.repository as GitHubChangeRequestRepository) ?? null,
        defaultBranch: repository.repository?.defaultBranch,
      };
      setChangeRequestCreateEligibility(result);
      return result;
    } catch (error) {
      const result: ChangeRequestCreateEligibility = {
        status: 'ineligible',
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unable to check Change Request availability.',
      };
      setChangeRequestCreateEligibility(result);
      return result;
    }
  }, [repoPath]);

  // Load the origin branches a request may target and the default to preselect.
  const loadChangeRequestTargets = useCallback(async (): Promise<GitHubChangeRequestTargetsResult> => {
    return ListChangeRequestTargets(repoPath ?? '') as Promise<GitHubChangeRequestTargetsResult>;
  }, [repoPath]);

  // Deterministic duplicate lookup used before opening the create dialog.
  const findOpenChangeRequestForBranch = useCallback(async (
    sourceBranch: string,
  ): Promise<GitHubFindChangeRequestResult> => {
    return FindOpenChangeRequestForBranch(repoPath ?? '', sourceBranch) as Promise<GitHubFindChangeRequestResult>;
  }, [repoPath]);

  // Create a request, then refresh the list and select it so the Reviews view
  // can open the new (or existing duplicate) request. Navigation is left to the
  // caller so RepoContext stays free of layout concerns.
  const createChangeRequest = useCallback(async (
    options: GitHubCreateChangeRequestOptions,
  ): Promise<GitHubCreateChangeRequestResult> => {
    if (!repoPath) {
      return {
        success: false,
        isDuplicate: false,
        error: 'Open a project before creating a Change Request.',
        errorCode: 'internal_error',
      } as unknown as GitHubCreateChangeRequestResult;
    }

    setIsCreatingChangeRequest(true);
    try {
      const result = await CreateChangeRequest(repoPath, options) as GitHubCreateChangeRequestResult;
      if (result.success && result.changeRequest?.number) {
        await loadChangeRequests();
        await selectChangeRequest(result.changeRequest.number);
      }
      return result;
    } catch (error) {
      return {
        success: false,
        isDuplicate: false,
        error: error instanceof Error ? error.message : 'Unable to create the Change Request.',
        errorCode: 'internal_error',
      } as unknown as GitHubCreateChangeRequestResult;
    } finally {
      setIsCreatingChangeRequest(false);
    }
  }, [repoPath, loadChangeRequests, selectChangeRequest]);

  // Snapshot refs are disposable caches, not user data. Clear them when a
  // repository is opened as well as when it is left, so a crash or force quit
  // cannot leave stale refs behind.
  useEffect(() => {
    if (!repoPath) return;
    const path = repoPath;
    void ClearChangeRequestSnapshots(path);
    return () => {
      void ClearChangeRequestSnapshots(path);
    };
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath || changeRequestAuthStateRef.current === ghAuthStatus?.loggedIn) {
      return;
    }
    changeRequestAuthStateRef.current = ghAuthStatus?.loggedIn ?? null;
    void loadChangeRequests();
  }, [ghAuthStatus?.loggedIn, loadChangeRequests, repoPath]);

  // Clone a GitHub repository
  const cloneGitHubRepo = useCallback(async (
    repo: string,
    destPath: string
  ): Promise<GitHubCloneResult> => {
    try {
      const result = await RepoClone(repo, destPath, false);
      if (result.success) {
        showMessage('success', `Repository cloned to ${result.cloneDir}`);
        // Optionally open the cloned repo
        if (result.cloneDir) {
          await openRepo(result.cloneDir);
        }
      } else {
        showMessage('error', result.error || 'Failed to clone repository');
      }
      return result as GitHubCloneResult;
    } catch (err) {
      const error = err as Error;
      const result: GitHubCloneResult = {
        success: false,
        error: error.message || 'Failed to clone repository',
      };
      showMessage('error', result.error!);
      return result;
    }
  }, [showMessage, openRepo]);

  // Publish local repo to GitHub
  const publishToGitHub = useCallback(async (
    name: string,
    description: string,
    isPrivate: boolean,
    owner?: string
  ): Promise<GitHubRepoCreateResult> => {
    if (previewRunningRef.current) return { success: false, error: 'Wait for preview generation to finish, then publish the project.' };
    if (!repoPath) {
      return {
        success: false,
        error: 'No repository open',
      };
    }

    const publishStartTime = Date.now();

    // Track publish attempt (Phase 13.2)
    trackProjectPublishAttempted({
      repoName: name,
      isPrivate,
      hasOrganization: !!owner && owner.length > 0,
      source: 'setup_banner',
    });
    
    try {
      const result = await RepoCreateFromLocal(repoPath, name, description, isPrivate, owner || '');
      if (result.success) {
        const displayName = owner ? `${owner}/${name}` : name;
        showMessage('success', `Repository published to GitHub as ${result.repo?.fullName || displayName}`);

        // Track publish completed (Phase 13.2)
        trackProjectPublishCompleted({
          repoName: name,
          isPrivate,
          durationMs: Date.now() - publishStartTime,
        });

        // Refresh status to update remote info
        await refreshStatus();
      } else {
        showMessage('error', result.error || 'Failed to publish repository');
        // Track publish failure (Phase 13.2)
        trackProjectPublishFailed({
          errorType: result.error || 'unknown_error',
          repoName: name,
        });
      }
      return result as GitHubRepoCreateResult;
    } catch (err) {
      const error = err as Error;
      const result: GitHubRepoCreateResult = {
        success: false,
        error: error.message || 'Failed to publish repository',
      };
      showMessage('error', result.error!);

      // Track publish failure (Phase 13.2)
      trackProjectPublishFailed({
        errorType: error.message || 'exception',
        repoName: name,
      });

      return result;
    }
  }, [repoPath, showMessage, refreshStatus]);

  // Load user's organizations for publish form
  const loadUserOrganizations = useCallback(async (): Promise<GitHubOrganizationsResult> => {
    try {
      const result = await ListUserOrganizations();
      return result as GitHubOrganizationsResult;
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        username: '',
        organizations: [],
        error: error.message || 'Failed to load organizations',
      };
    }
  }, []);

  // ===== Project Creation Orchestration (Welcome Screen) =====

  /**
   * createProject - Full project creation flow with step callbacks.
   *
   * Steps:
   *  0 – Initializing (git init, LFS presets, identity)
   *  1 – Saving Changes (initial commit)
   *  2 – Publishing (GitHub repo creation — skipped if local-only)
   *  3 – Done (opens the project)
   *
   * The `onStepChange` callback lets the UI stepper advance.
   */
  const createProject = useCallback(async (options: CreateProjectOptions): Promise<CreateProjectResult> => {
    const { path, remote, onStepChange, gitignoreTemplateId } = options;
    const createStartTime = Date.now();

    if (!gitInstalled || !lfsInstalled || (!remote.skip && !ghInstalled)) {
      const installed = await installRequiredPackages();
      if (!installed) {
        return {
          success: false,
          error: 'Required packages are still being installed. Please wait and try again.',
        };
      }
    }

    // Track setup started (Phase 13.2)
    trackProjectSetupStarted({
      projectState: 'new-project',
      source: 'new_project_page',
      hasFiles: false, // New project page — may or may not have files
    });

    try {
      // ── Step 0: Initialize ──────────────────────────────────────────
      onStepChange?.(0);

      const info = await DetectRepo(path);
      if (!info.isRepo) {
        // Init git
        const initResult = await InitRepo(path);
        if (!initResult.success) {
          return { success: false, error: initResult.error || 'Failed to initialize repository' };
        }

        // Init LFS + preset patterns
        try {
          await InitializeLFS(path);
          const presetPatterns = await GetPresetPatterns();
          for (const preset of presetPatterns) {
            try {
              await TrackPattern(path, preset.pattern);
            } catch (err) {
              console.warn(`Failed to track LFS pattern ${preset.pattern}:`, err);
            }
          }
        } catch (err) {
          console.warn('Failed to initialize LFS:', err);
          // Non-fatal: continue without LFS
        }

        // Ensure git identity from IOFabrik account
        try {
          const identity = await EnsureIdentity(path, userName || '', userEmail || '');
          cacheGitIdentity(path, identity.name || '', identity.email || '');
        } catch (err) {
          console.warn('Failed to ensure git identity:', err);
          clearCachedGitIdentity();
        }

        // Apply selected .gitignore template before first commit
        if (gitignoreTemplateId) {
          try {
            const templateResult = await ApplyGitignoreTemplate(path, gitignoreTemplateId);
            if (!templateResult.success) {
              console.warn('Failed to apply .gitignore template:', templateResult.error);
            }
          } catch (err) {
            console.warn('Failed to apply .gitignore template:', err);
          }
        }
      }

      // Prepare project settings before committing or publishing.
      try {
        const configResult = await WriteRepoLocalConfig(path, {
          createdAt: new Date().toISOString(),
          createdBy: userName || userEmail || 'unknown',
          appVersion: '0.0.0-dev',
        });
        if (!configResult.success) {
          return {
            success: false,
            error: configResult.error || 'Could not prepare the project settings folder. Check the folder\'s permissions and try again.',
          };
        }
      } catch (err) {
        console.warn('Failed to write .iofabrik config:', err);
        return {
          success: false,
          error: 'Could not prepare the project settings folder. Check the folder\'s permissions and try again.',
        };
      }

      // ── Step 1: Commit ──────────────────────────────────────────────
      onStepChange?.(1);

      if (!await ensureProjectDefaultBranch(path)) {
        return { success: false, error: 'Choose a default branch before saving the project.' };
      }

      const hasIdentity = await promptForGitIdentityIfMissing(path, 'initial-commit');
      if (!hasIdentity) {
        return {
          success: false,
          error: 'Add the name and email used for saved changes before IOFabrik can create the first revision.',
        };
      }

      const commitResult = await CommitAll(path, 'Initial commit');
      if (!commitResult.success) {
        // Non-fatal: might be an empty folder with nothing to commit
        console.warn('Initial commit may have been skipped:', commitResult.error);
      }

      // ── Step 2: Publish (if not local-only) ─────────────────────────
      if (!remote.skip && remote.repoName) {
        onStepChange?.(2);

        // Track publish attempt (Phase 13.2)
        trackProjectPublishAttempted({
          repoName: remote.repoName,
          isPrivate: remote.isPrivate ?? true,
          hasOrganization: !!remote.owner && remote.owner.length > 0,
          source: 'new_project_page',
        });

        const publishStart = Date.now();
        const pubResult = await RepoCreateFromLocal(
          path,
          remote.repoName,
          '', // description
          remote.isPrivate ?? true,
          remote.owner || '',
        );

        if (!pubResult.success) {
          // Repo exists locally — return partial success with warning
          const displayName = remote.owner
            ? `${remote.owner}/${remote.repoName}`
            : remote.repoName;
          const errorMsg = `Project created locally, but publishing "${displayName}" failed: ${pubResult.error}`;
          showMessage('warning', errorMsg, 8000);

          // Track publish failure (Phase 13.2)
          trackProjectPublishFailed({
            errorType: pubResult.error || 'unknown_error',
            repoName: remote.repoName,
          });

          // Still open the project so the user isn't stuck
          onStepChange?.(3);
          await openRepo(path);

          return { success: false, error: errorMsg };
        }

        // Track publish completed (Phase 13.2)
        trackProjectPublishCompleted({
          repoName: remote.repoName,
          isPrivate: remote.isPrivate ?? true,
          durationMs: Date.now() - publishStart,
        });

        showMessage('success', `Repository published to GitHub as ${pubResult.repo?.fullName || remote.repoName}`);
      }

      // ── Step 3: Done ────────────────────────────────────────────────
      onStepChange?.(3);
      await openRepo(path);

      trackRepoInitialized({
        lfsEnabled: true,
        initialCommitMade: true,
      });

      // Track project setup completed (Phase 13.2)
      trackProjectSetupCompleted({
        projectState: 'new-project',
        lfsEnabled: true,
        initialCommitMade: true,
        durationMs: Date.now() - createStartTime,
      });

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      trackErrorShown({
        errorContext: 'create_project',
        actionAttempted: 'create_project',
      });
      showMessage('error', `Failed to create project: ${msg}`);
      return { success: false, error: msg };
    }
  }, [cacheGitIdentity, clearCachedGitIdentity, userName, userEmail, openRepo, showMessage, gitInstalled, lfsInstalled, ghInstalled, installRequiredPackages, promptForGitIdentityIfMissing, ensureProjectDefaultBranch]);

  // ===== Effects =====

  // Track local portable toolchain progress emitted by backend.
  useEffect(() => {
    const unsubscribe = onEvent('local-bin:progress', (event: any) => {
      const payload = (event?.data?.[0] ?? event?.data ?? event) as {
        component?: string;
        phase?: string;
        message?: string;
        percent?: number;
        error?: string;
      };

      if (!payload || typeof payload !== 'object') return;

      if (payload.message) {
        setPackagesInstallMessage(payload.message);
      }

      if (typeof payload.percent === 'number' && Number.isFinite(payload.percent)) {
        setPackagesInstallPercent(Math.max(0, Math.min(100, payload.percent)));
      }

      if (payload.phase === 'error') {
        setIsInstallingPackages(false);
        if (payload.error) {
          showMessage('error', payload.error);
        }
        return;
      }

      if (payload.component === 'toolchain' && payload.phase === 'done') {
        setIsInstallingPackages(false);
        setPackagesInstallMessage(payload.message || 'Additional packages are ready');
        return;
      }

      setIsInstallingPackages(true);
    });

    return () => {
      unsubscribe();
    };
  }, [showMessage]);

  // Prevent app shutdown while package download is in progress.
  useEffect(() => {
    if (!isInstallingPackages) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = 'Supporting tools are being checked. Please wait.';
      return event.returnValue;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isInstallingPackages]);

  // Validate required CLI packages at startup and install if missing.
  useEffect(() => {
    const initializeToolchain = async () => {
      const status = await refreshToolchainStatus();
      const hasMissing = !status.hasGit || !status.hasGh || !status.hasLfs;

      if (hasMissing && isWindowsPlatform()) {
        await installRequiredPackages();
        await refreshToolchainStatus();
      }
    };

    initializeToolchain();
  }, [refreshToolchainStatus, installRequiredPackages, isWindowsPlatform]);

  // Load last opened repository on mount
  useEffect(() => {
    const loadLastRepo = async () => {
      try {
        const settings = await GetAppSettings();
        if (settings.lastRepoPath) {
          await openRepo(settings.lastRepoPath);
        }
      } catch (err) {
        console.error('Failed to load last repo:', err);
      }
    };
    loadLastRepo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time startup auto-pull after app boot delay.
  useEffect(() => {
    const delay = Math.max(0, startupAutoPullDeadlineRef.current - Date.now());
    const timeoutId = setTimeout(() => {
      startupAutoPullDueRef.current = true;
      void runStartupAutoPull();
    }, delay);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [runStartupAutoPull]);

  // If the repository opens after the startup delay elapses, trigger pending auto-pull once.
  useEffect(() => {
    void runStartupAutoPull();
  }, [runStartupAutoPull]);

  // Start polling when git repo is open
  useStatusPolling({
    enabled: Boolean(repoPath && repoInfo?.isRepo),
    repositoryKey: repoPath,
    intervalMs: STATUS_POLL_INTERVAL,
    onInitialRefresh: refreshAll,
    onRefreshStatus: refreshStatus,
  });

  // Event-based refresh for file changes
  useEffect(() => {
    if (!repoPath || !repoInfo?.isRepo) return;
    
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const normalizedRepoPath = repoPath.replace(/\\/g, '/');
    
    const handleFilesChanged = (event: {
      data?: {
        path?: string;
        eventType?: string;
        isDir?: boolean;
      };
    }) => {
      const changedPath = event.data?.path;
      const eventType = event.data?.eventType;
      const isDir = event.data?.isDir;

      if (!isDir && changedPath && (eventType === 'write' || eventType === 'rename' || eventType === 'remove')) {
        const normalizedChangedPath = changedPath.replace(/\\/g, '/');
        const repoPrefix = `${normalizedRepoPath}/`;

        if (normalizedChangedPath.startsWith(repoPrefix)) {
          const relativePath = normalizedChangedPath.slice(repoPrefix.length);

          // Ignore internal git metadata updates.
          if (relativePath && !relativePath.startsWith('.git/')) {
            closeExplorerPreviewsForFile(relativePath);
          }
        }
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        refreshStatus();
      }, 300);
    };
    
    const unsubscribe = onEvent('files-changed', handleFilesChanged);
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [repoPath, repoInfo?.isRepo, refreshStatus, closeExplorerPreviewsForFile]);

  // Reset conflict check state when local changes are detected
  useEffect(() => {
    if (repoStatus?.hasChanges && conflictCheckResult) {
      if (conflictedFiles.length > 0) {
        return;
      }
      if (conflictCheckResult.success && !conflictCheckResult.hasConflicts) {
        return;
      }
      setConflictCheckResult(null);
      setConflictedFiles([]);
      setSelectedConflictFile(null);
      setFileResolutions({});
      setMergeState(null);
      setConflictSidesInfo(null);
    }
  }, [repoStatus?.hasChanges, conflictCheckResult, conflictedFiles.length]);

  // Listen for folder-selected event from native menu
  useEffect(() => {
    const unsubscribe = onEvent('folder-selected', async (event: { data?: string }) => {
      if (event.data) {
        await openFolder(event.data);
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, [openFolder]);

  // Listen for folder-closed event from native menu
  useEffect(() => {
    const unsubscribe = onEvent('folder-closed', async () => {
      await closeRepo();
    });
    
    return () => {
      unsubscribe();
    };
  }, [closeRepo]);

  // Listen for file:reveal-in-finder event from native menu
  useEffect(() => {
    const unsubscribe = onEvent('file:reveal-in-finder', async () => {
      if (repoPath) {
        const result = await RevealInFinder(repoPath);
        if (!result.success && result.error) {
          toast.error(result.error);
        }
      } else {
        toast.error('No folder is currently open');
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, [repoPath]);

  // Listen for file:open-in-terminal event from native menu
  useEffect(() => {
    const unsubscribe = onEvent('file:open-in-terminal', async () => {
      if (repoPath) {
        const result = await OpenInTerminal(repoPath);
        if (!result.success && result.error) {
          toast.error(result.error);
        }
      } else {
        toast.error('No folder is currently open');
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, [repoPath]);

  // Refresh branches when repo changes
  useEffect(() => {
    if (repoPath) {
      refreshBranches();
    }
  }, [repoPath, refreshBranches]);

  // Publication workspaces are internal; retain other files and recovery remnants.
  const displayRepoStatus = useMemo(() => {
    if (!repoStatus?.changedFiles) return repoStatus;
    const changedFiles = repoStatus.changedFiles.filter(file => !isActivePreviewStagingPath(file.path, previewNotification));
    return changedFiles.length === repoStatus.changedFiles.length ? repoStatus : { ...repoStatus, changedFiles, hasChanges: changedFiles.length > 0 };
  }, [repoStatus, previewNotification]);

  // ===== Memoized Context Value =====
  const value = useMemo<RepoContextValue>(() => ({
    // State
    repoPath,
    repoInfo,
    repoStatus: displayRepoStatus,
    commits: graphCommits,
    graphCommits,
    branches,
    selectedFileIndex,
    setSelectedFileIndex,
    
    // v2: Selection state
    selectedCommit,
    selectedCommitFile,
    currentDiff,
    
    // Loading states
    isLoading,
    isSyncing,
    isCommitting,
    isDiffLoading,
    gitInstalled,
    lfsInstalled,
    isInstallingPackages,
    packagesInstallMessage,
    packagesInstallPercent,

    // Global operation lock
    operationInProgress,
    operationLabel,
    
    // Remote state
    hasRemote,
    refreshRemotes,

    // Repository settings (protected branches, fetch options)
    repoSettings,
    refreshRepoSettings,
    ...projectDefaultState,
    
    // Progress modal state
    progressModal,
    generatePreview,
    previewNotification,
    dismissPreviewNotification,
    handleProgressComplete,
    
    // Feedback
    showMessage,

    // Non-git folder prompt state
    nonGitFolderPromptPath,
    dismissNonGitFolderPrompt,
    gitIdentityPrompt,
    submitGitIdentityPrompt,
    cancelGitIdentityPrompt,
    defaultBranchSyncPrompt,
    confirmDefaultBranchSync,
    cancelDefaultBranchSync,
    
    // Actions
    openRepo,
    openFolder,
    closeRepo,
    startTracking,
    installRequiredPackages,
    commitChanges,
    syncRepo,
    refreshStatus,
    refreshCommits,
    refreshAll,
    
    // v2: Diff actions
    loadWorkingDiff,
    selectCommit,
    loadCommitFileDiff,
    clearSelection,
    
    // v2: Branch actions
    refreshBranches,
    switchBranch,
    createBranch,
    renameBranch,
    deleteBranch,
    branchAndCommit,
    
    // v2: Recovery actions
    undoLastCommit,
    discardAllChanges,
    discardFileChanges,
    rewindToLastSnapshot,
    
    // v2: Conflict checking actions
    conflictedFiles,
    selectedConflictFile,
    setSelectedConflictFile,
    conflictCheckResult,
    mergeReviewFiles,
    isLoadingMergeReviewFiles,
    isCheckingConflicts,
    loadMergeReviewFiles,
    loadMergeReviewFileDiff,
    checkConflictsOnly,
    startMerge,
    checkBranchConflicts,
    clearConflicts,
    detectedParentBranch,
    fetchParentBranch,
    conflictSidesInfo,
    
    // v2: Merge options
    isSquashMerge,
    setIsSquashMerge,
    
    // v2: Conflict resolution actions
    fileResolutions,
    setFileResolution,
    mergeState,
    isResolvingConflict,
    loadConflictResolutionData,
    resolveConflictWithDecisions,
    resolveConflict,
    applyAllResolutions,
    abortMerge,
    completeMerge,
    refreshMergeState,

    // v2: Stuck state recovery actions
    abortCurrentOperation,
    abortCherryPick,
    continueCherryPick,
    skipCherryPickCommit,
    revertCommit,
    abortRevert,
    continueRevert,
    skipRevertCommit,
    abortBisect,
    getBisectState,
    abortAM,
    skipAMPatch,
    createBranchFromDetached,
    removeAllStaleLocks,

    // GitHub Integration (Phase 2)
    ghInstalled,
    ghVersion,
    ghAuthStatus,
    isOffline,
    isCheckingGhAuth,
    isStartingGitHubLogin,
    ghRepos,
    isLoadingGhRepos,
    changeRequestRepository,
    changeRequestViewerLogin,
    changeRequests,
    omittedExternalChangeRequestCount,
    changeRequestsMayHaveMore,
    isLoadingChangeRequests,
    changeRequestError,
    selectedChangeRequest,
    changeRequestFiles,
    changeRequestTotalFiles,
    isChangeRequestFilesTruncated,
    selectedChangeRequestFilePath,
    isLoadingChangeRequestDetail,
    changeRequestDetailError,
    changeRequestSnapshot,
    isPreparingChangeRequestSnapshot,
    changeRequestSnapshotError,
    changeRequestCreateEligibility,
    isCreatingChangeRequest,
    checkGitHubAuth,
    loginGitHub,
    startGitHubLogin,
    completeGitHubLogin,
    cancelGitHubLogin,
    logoutGitHub,
    loadGitHubRepos,
    cloneGitHubRepo,
    publishToGitHub,
    loadUserOrganizations,
    loadChangeRequests,
    selectChangeRequest,
    selectChangeRequestFile,
    returnToChangeRequestOverview,
    clearChangeRequestState,
    checkChangeRequestCreateEligibility,
    loadChangeRequestTargets,
    findOpenChangeRequestForBranch,
    createChangeRequest,

    // Project creation (Welcome Screen)
    createProject,
  }), [
    repoPath, repoInfo, displayRepoStatus, graphCommits, branches, selectedFileIndex,
    selectedCommit, selectedCommitFile, currentDiff,
    isLoading, isSyncing, isCommitting, isDiffLoading,
    gitInstalled, lfsInstalled, isInstallingPackages, packagesInstallMessage, packagesInstallPercent,
    operationInProgress, operationLabel,
    hasRemote, refreshRemotes,
    repoSettings, refreshRepoSettings, projectDefaultState,
    progressModal, handleProgressComplete, generatePreview, previewNotification, dismissPreviewNotification,
    showMessage,
    nonGitFolderPromptPath, dismissNonGitFolderPrompt,
    gitIdentityPrompt, submitGitIdentityPrompt, cancelGitIdentityPrompt,
    defaultBranchSyncPrompt, confirmDefaultBranchSync, cancelDefaultBranchSync,
    openRepo, openFolder, closeRepo, startTracking, installRequiredPackages, commitChanges, syncRepo, refreshStatus, refreshCommits, refreshAll,
    loadWorkingDiff, selectCommit, loadCommitFileDiff, clearSelection,
    refreshBranches, switchBranch, createBranch, renameBranch, deleteBranch, branchAndCommit,
    undoLastCommit, discardAllChanges, discardFileChanges, rewindToLastSnapshot,
    conflictedFiles, selectedConflictFile, conflictCheckResult, isCheckingConflicts, 
    mergeReviewFiles, isLoadingMergeReviewFiles,
    loadMergeReviewFiles, loadMergeReviewFileDiff,
    checkConflictsOnly, startMerge, checkBranchConflicts, clearConflicts,
    detectedParentBranch, fetchParentBranch, conflictSidesInfo,
    isSquashMerge,
    fileResolutions, setFileResolution, mergeState, isResolvingConflict,
    loadConflictResolutionData, resolveConflictWithDecisions,
    resolveConflict, applyAllResolutions, abortMerge, completeMerge, refreshMergeState,
    abortCurrentOperation,
    abortCherryPick, continueCherryPick, skipCherryPickCommit,
    revertCommit, abortRevert, continueRevert, skipRevertCommit,
    abortBisect, getBisectState,
    abortAM, skipAMPatch,
    createBranchFromDetached,
    removeAllStaleLocks,
    // GitHub dependencies
    ghInstalled, ghVersion, ghAuthStatus, isOffline, isCheckingGhAuth, isStartingGitHubLogin, ghRepos, isLoadingGhRepos,
    changeRequestRepository, changeRequestViewerLogin, changeRequests, omittedExternalChangeRequestCount, changeRequestsMayHaveMore, isLoadingChangeRequests, changeRequestError,
    selectedChangeRequest, changeRequestFiles, changeRequestTotalFiles, isChangeRequestFilesTruncated, selectedChangeRequestFilePath, isLoadingChangeRequestDetail, changeRequestDetailError,
    changeRequestSnapshot, isPreparingChangeRequestSnapshot, changeRequestSnapshotError,
    changeRequestCreateEligibility, isCreatingChangeRequest,
    checkGitHubAuth, loginGitHub, startGitHubLogin, completeGitHubLogin, cancelGitHubLogin, logoutGitHub, loadGitHubRepos, cloneGitHubRepo, publishToGitHub, loadUserOrganizations, loadChangeRequests, selectChangeRequest, selectChangeRequestFile, returnToChangeRequestOverview, clearChangeRequestState,
    checkChangeRequestCreateEligibility, loadChangeRequestTargets, findOpenChangeRequestForBranch, createChangeRequest,
    createProject,
  ]);

  return (
    <RepoContext.Provider value={value}>
      {children}
    </RepoContext.Provider>
  );
}

/**
 * useRepo - Hook to access repository context.
 * Must be used within a RepoProvider.
 */
export function useRepo(): RepoContextValue {
  const context = useContext(RepoContext);
  if (!context) {
    // During React Fast Refresh (HMR), context identity can break when
    // createContext() re-executes in the updated module. The Provider still
    // holds the old context reference while consumers get the new one.
    // Force a full page reload instead of crashing with a white screen.
    if (import.meta.hot) {
      import.meta.hot.invalidate('RepoContext identity changed during HMR');
      return {} as RepoContextValue;
    }
    throw new Error('useRepo must be used within a RepoProvider');
  }
  return context;
}
