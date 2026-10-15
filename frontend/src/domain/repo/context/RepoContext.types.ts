import type { ProjectDefaultBranchPrompt } from '../hooks/useProjectDefaultBranch';
import type {
  ProjectDefaultBranchResult,
  GitHubChangeRequest as GitHubChangeRequestModel,
  GitHubChangeRequestFile as GitHubChangeRequestFileModel,
  GitHubChangeRequestRepository as GitHubChangeRequestRepositoryModel,
  GitHubChangeRequestErrorCode as GitHubChangeRequestErrorCodeModel,
  GitHubChangeRequestBranch as GitHubChangeRequestBranchModel,
  GitHubChangeRequestTargetsResult as GitHubChangeRequestTargetsResultModel,
  GitHubFindChangeRequestResult as GitHubFindChangeRequestResultModel,
  GitHubCreateChangeRequestOptions as GitHubCreateChangeRequestOptionsModel,
  GitHubCreateChangeRequestResult as GitHubCreateChangeRequestResultModel,
  ChangeRequestSnapshot as ChangeRequestSnapshotModel,
} from '../../../../bindings/iofabrik/services/models';
import type { ConflictRegionDecision, ConflictResolutionData } from '../../../features/conflict/types';

/**
 * Type definitions for RepoContext
 * 
 * These types are derived from:
 * - Backend service models (frontend/bindings/iofabrik/services/models.js)
 * - Component prop types
 * - React state shape analysis
 */

import type { ReactNode, Dispatch, SetStateAction } from 'react';
export type { ConflictResolutionData } from '../../../features/conflict/types';

// ============================================================================
// Enums and Constants
// ============================================================================

export type FileStatusType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export type ConflictFileStatus = 'both-modified' | 'deleted-by-us' | 'deleted-by-them' | 'both-added' | 'both-deleted';
export type ResolutionStrategy = 'mine' | 'theirs' | 'both';
export type MessageType = 'success' | 'error' | 'info' | 'warning';
export type ProjectSetupStartSource = 'status_bar_nudge' | 'setup_banner';
export type LiveMergePhase = 'dry-run' | 'starting' | 'resolving' | 'ready-to-complete' | 'auto-completed';
export type GitIdentityPromptReason = 'save' | 'branch-save' | 'initial-commit' | 'merge-complete';

export interface GitIdentityPromptState {
  isOpen: boolean;
  repoPath: string;
  name: string;
  email: string;
  reason: GitIdentityPromptReason;
}

export interface DefaultBranchSyncPromptState {
  isOpen: boolean;
  branch: string;
}

// ============================================================================
// GitHub Types (for Phase 2: GitHub Integration)
// ============================================================================

/**
 * GitHubAuthStatus - Authentication status for GitHub
 */
export interface GitHubAuthStatus {
  loggedIn: boolean;
  username?: string;
  accountType?: string; // "user" or "org"
  protocol?: string;    // "https" or "ssh"
  host?: string;        // e.g., "github.com"
  token?: string;       // Masked or partial token
  scopes?: string;      // Token scopes
  error?: string;
  errorCode?: GitHubChangeRequestErrorCode;
}

/**
 * GitHubAuthResult - Result of GitHub auth operation
 */
export interface GitHubAuthResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * GitHubDeviceFlowResult - Device flow authentication state
 */
export interface GitHubDeviceFlowResult {
  success: boolean;
  cancelled?: boolean;
  userCode?: string;        // The one-time code user needs to enter
  verificationUrl?: string; // URL to visit for authentication
  error?: string;
}

/**
 * GitHubRepo - Repository information from GitHub
 */
export interface GitHubRepo {
  name: string;
  fullName: string;     // owner/repo format
  description: string;
  url: string;
  sshUrl: string;
  cloneUrl: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string;
  stargazersCount: number;
  forksCount: number;
  updatedAt: string;
  createdAt: string;
}

/**
 * GitHubRepoListResult - Result of listing GitHub repositories
 */
export interface GitHubRepoListResult {
  success: boolean;
  repos: GitHubRepo[];
  error?: string;
}

/**
 * GitHubCloneResult - Result of cloning a GitHub repository
 */
export interface GitHubCloneResult {
  success: boolean;
  cloneDir?: string;
  error?: string;
}

/**
 * GitHubRepoCreateResult - Result of creating a GitHub repository
 */
export interface GitHubRepoCreateResult {
  success: boolean;
  repo?: GitHubRepo;
  cloneDir?: string;
  error?: string;
}

/**
 * GitHubOrganization - A GitHub organization the user belongs to
 */
export interface GitHubOrganization {
  login: string;       // Organization slug/name
  name: string;        // Display name
  description?: string; // Organization description
}

/**
 * GitHubOrganizationsResult - Result of listing user's organizations
 */
export interface GitHubOrganizationsResult {
  success: boolean;
  username: string;      // The authenticated user's username
  organizations: GitHubOrganization[]; // Organizations the user belongs to
  error?: string;
}

export type GitHubChangeRequestErrorCode = `${GitHubChangeRequestErrorCodeModel}`;

export type GitHubChangeRequestRepository = GitHubChangeRequestRepositoryModel;

export type GitHubChangeRequest = GitHubChangeRequestModel;

export type GitHubChangeRequestFile = GitHubChangeRequestFileModel;

/**
 * ChangeRequestSnapshot names the local refs a Change Request is compared
 * against. `baseRef` is the merge base rather than the target branch tip, so a
 * two-dot baseRef..headRef diff matches GitHub's own file list.
 */
export type ChangeRequestSnapshot = ChangeRequestSnapshotModel;

export interface GitHubChangeRequestError {
  code: GitHubChangeRequestErrorCode;
  message?: string;
}

export type GitHubChangeRequestBranch = GitHubChangeRequestBranchModel;
export type GitHubChangeRequestTargetsResult = GitHubChangeRequestTargetsResultModel;
export type GitHubFindChangeRequestResult = GitHubFindChangeRequestResultModel;
export type GitHubCreateChangeRequestOptions = GitHubCreateChangeRequestOptionsModel;
export type GitHubCreateChangeRequestResult = GitHubCreateChangeRequestResultModel;

/**
 * ChangeRequestCreateEligibility describes whether Home may
 * offer Create Change Request for the current synced feature branch. When the
 * status is `ineligible`, `code` and `message` explain why so the button can be
 * shown disabled with guidance.
 */
export interface ChangeRequestCreateEligibility {
  status: 'unknown' | 'eligible' | 'ineligible';
  code?: GitHubChangeRequestErrorCode;
  message?: string;
  repository?: GitHubChangeRequestRepository | null;
  defaultBranch?: string;
}

/**
 * GitInitOptions - Options for initializing a git repository
 */
export interface GitInitOptions {
  type: 'clone' | 'init';
  lfsEnabled?: boolean;
  lfsAttributes?: Array<{ pattern: string; description: string }>;
  userName?: string;
  userEmail?: string;
  createReadme?: boolean;
  createGitignore?: boolean;
  // Clone-specific options
  url?: string;
  recursive?: boolean;
}

// ============================================================================
// Backend Model Types (from services/models.js)
// ============================================================================

/**
 * RepoInfo - Basic repository information from DetectRepo()
 */
export interface RepoInfo {
  path: string;
  isRepo: boolean;
  branch: string;
  hasError: boolean;
  error?: string;
}

/**
 * FileStatus - Status of a changed file from git status
 */
export interface FileStatus {
  path: string;
  name: string;
  status: FileStatusType;
}

/**
 * RepoStatus - Current state of the repository from Status()
 */
export interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  changedFiles: FileStatus[];
  hasChanges: boolean;
  hasUpstream: boolean;
  totalLocalCommits: number;
  hasError: boolean;
  error?: string;
}

/**
 * GraphCommit - Commit with parent references for graph visualization
 */
export interface GraphCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  relativeDate: string;
  parents: string[];
  refs: string[];
}

/**
 * CommitStats - Statistics for a commit
 */
export interface CommitStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/**
 * CommitFileInfo - File changed in a commit
 */
export interface CommitFileInfo {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  hasNoLineStats?: boolean;
}

/**
 * CommitDetail - Detailed information about a single commit from ShowCommit()
 */
export interface CommitDetail {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: string;
  authorEmail: string;
  date: string;
  relativeDate: string;
  parentHashes: string[];
  files: CommitFileInfo[];
  stats: CommitStats;
  hasError: boolean;
  error?: string;
}

/**
 * BranchInfo - Git branch information
 */
export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream?: string;
  lastUpdatedUnix?: number;
}

/**
 * BranchList - All branches in a repository from Branches()
 */
export interface BranchList {
  current: string;
  local: BranchInfo[];
  remote: BranchInfo[];
  hasError: boolean;
  error?: string;
}

/**
 * FileDiff - Diff information for a file
 */
export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: boolean;
  rawDiff?: string;
  hasError?: boolean;
  error?: string;
}

/**
 * ConflictedFile - File with merge conflicts
 */
export interface ConflictedFile {
  path: string;
  status: ConflictFileStatus;
}

/**
 * ConflictCommitInfo - Minimal commit info for conflict resolution display
 */
export interface ConflictCommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/**
 * ConflictSidesInfo - Commit info for both sides of a conflict
 */
export interface ConflictSidesInfo {
  ours: ConflictCommitInfo;
  theirs: ConflictCommitInfo;
  success: boolean;
  error?: string;
}

/**
 * BranchConflictCheckResult - Result of checking for conflicts between branches
 */
export interface BranchConflictCheckResult {
  hasConflicts: boolean;
  conflictedFiles: ConflictedFile[];
  parentBranch: string;
  targetBranch: string;
  sourceBranch: string;
  success: boolean;
  error?: string;
  message?: string;
  // Extended fields added by frontend
  isSquashMerge?: boolean;
  mergeStarted?: boolean;
  alreadyUpToDate?: boolean;
  autoCompleted?: boolean;
  liveMergePhase?: LiveMergePhase;
}

/**
 * MergeReviewFile - File shown in pre-merge review list
 */
export interface MergeReviewFile {
  path: string;
  status?: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  oldPath?: string;
}

/**
 * MergeReviewDiffResult - Raw diff payload for merge review file preview
 */
export interface MergeReviewDiffResult {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: boolean;
  rawDiff?: string;
  hasError?: boolean;
  error?: string;
  targetRef?: string;
  sourceRef?: string;
}

/**
 * MergeState - Current repository operation state
 */
export interface MergeState {
  inMerge: boolean;
  inRebase: boolean;
  hasConflicts: boolean;
  message?: string;
  // Additional stuck states
  inCherryPick: boolean;
  inRevert: boolean;
  inBisect: boolean;
  inAM: boolean;
  isDetached: boolean;
  hasLockFile: boolean;
  // Additional context
  detachedAt?: string;
  lockFiles?: string[];
  stuckType?: string;
  userMessage?: string;
}

/**
 * OperationResult - Generic result from a git operation
 */
export interface OperationResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * DetectedParentBranch - Auto-detected parent branch info
 */
export interface DetectedParentBranch {
  name: string;
  source: string;
}

/**
 * ParentBranchResult - Result from GetParentBranch()
 */
export interface ParentBranchResult {
  parentBranch: string;
  source?: string;
}

/**
 * BisectState - Current bisect operation state
 */
export interface BisectState {
  inProgress: boolean;
  currentCommit?: string;
  goodCommits?: string[];
  badCommits?: string[];
  stepsRemaining?: number;
}

// ============================================================================
// Progress Modal Types
// ============================================================================

export interface ProgressModalState {
  isOpen: boolean;
  operationId: string | null;
  title: string;
  kind?: 'preview';
}

// ============================================================================
// File Resolutions Map
// ============================================================================

export type FileResolutionsMap = Record<string, ResolutionStrategy>;

// ============================================================================
// Merge Options
// ============================================================================

export interface MergeOptions {
  squash?: boolean;
  selective?: boolean;
  selectedFiles?: string[];
}

// ============================================================================
// Start Merge Result
// ============================================================================

export interface StartMergeResult {
  success: boolean;
  hasConflicts?: boolean;
  alreadyUpToDate?: boolean;
  autoCompleted?: boolean;
  liveMergePhase?: LiveMergePhase;
}

// ============================================================================
// Project Creation Types
// ============================================================================

/**
 * Options for the createProject orchestration method.
 * Combines repo init + optional GitHub publish into a single flow.
 */
export interface CreateProjectOptions {
  /** Absolute path to the folder to initialise. */
  path: string;
  /** Optional .gitignore template ID to apply before first commit. */
  gitignoreTemplateId?: string;
  /** Remote configuration. */
  remote: {
    /** If true, skip GitHub publishing (local-only project). */
    skip: boolean;
    /** GitHub owner (username or org login). Empty string = personal account. */
    owner?: string;
    /** Repository name on GitHub. */
    repoName?: string;
    /** Whether the GitHub repo should be private. Defaults to true. */
    isPrivate?: boolean;
  };
  /**
   * Called each time the orchestrator advances to a new step.
   * Step index is zero-based and maps to the stepper's `steps` array.
   */
  onStepChange?: (step: number) => void;
}

/**
 * Result returned by createProject.
 */
export interface CreateProjectResult {
  success: boolean;
  /** If the local init succeeded but publish failed, this will contain the publish error. */
  error?: string;
}

// ============================================================================
// Context Value Type
// ============================================================================

export interface RepoContextValue {
  // ===== State =====
  repoPath: string | null;
  repoInfo: RepoInfo | null;
  repoStatus: RepoStatus | null;
  commits: GraphCommit[]; // Alias for graphCommits
  graphCommits: GraphCommit[];
  branches: BranchList | null;
  selectedFileIndex: number | null;
  setSelectedFileIndex: Dispatch<SetStateAction<number | null>>;

  // v2: Selection state
  selectedCommit: CommitDetail | null;
  selectedCommitFile: string | null;
  currentDiff: FileDiff | null;

  // Loading states
  isLoading: boolean;
  isSyncing: boolean;
  isCommitting: boolean;
  isDiffLoading: boolean;

  // Global operation lock — true when any mutating git operation is running
  operationInProgress: boolean;
  /** Human-readable label of the current operation, e.g. "Syncing" */
  operationLabel: string | null;

  // CLI/package availability state
  gitInstalled: boolean;
  lfsInstalled: boolean;
  isInstallingPackages: boolean;
  packagesInstallMessage: string;
  packagesInstallPercent: number | null;

  // Remote state
  hasRemote: boolean;
  refreshRemotes: () => Promise<boolean>;

  // Repository settings (fetch options)
  repoSettings: {
    fetchPrune: boolean;
    fetchTags: boolean;
  } | null;
  refreshRepoSettings: (pathOverride?: string) => Promise<void>;

  projectDefaultBranch: ProjectDefaultBranchResult | null;
  projectDefaultBranchPrompt: ProjectDefaultBranchPrompt | null;
  projectDefaultBranchError: string;
  isLoadingProjectDefaultBranch: boolean;
  isSavingProjectDefaultBranch: boolean;
  refreshProjectDefaultBranch: (discover?: boolean, pathOverride?: string) => Promise<ProjectDefaultBranchResult | null>;
  chooseProjectDefaultBranch: () => Promise<string | null>;
  ensureProjectDefaultBranch: () => Promise<string | null>;
  submitProjectDefaultBranch: (branch: string) => Promise<boolean>;
  cancelProjectDefaultBranchSelection: () => void;
  useGitHubDefaultBranch: () => Promise<boolean>;

  // Progress modal state
  progressModal: ProgressModalState;
  handleProgressComplete: (success: boolean, error?: string) => void;
  generatePreview: (filePath: string) => Promise<boolean>;
  previewError: string | null;
  dismissPreviewError: () => void;

  // Feedback
  showMessage: (type: MessageType, text: string, duration?: number) => void;

  // Non-git folder prompt state
  nonGitFolderPromptPath: string | null;
  dismissNonGitFolderPrompt: () => void;
  gitIdentityPrompt: GitIdentityPromptState | null;
  submitGitIdentityPrompt: (name: string, email: string, saveGlobally: boolean) => Promise<boolean>;
  cancelGitIdentityPrompt: () => void;
  defaultBranchSyncPrompt: DefaultBranchSyncPromptState | null;
  confirmDefaultBranchSync: () => void;
  cancelDefaultBranchSync: () => void;

  // ===== Actions =====
  openRepo: (path: string) => Promise<boolean>;
  openFolder: (path: string) => Promise<boolean>;
  closeRepo: () => Promise<void>;
  startTracking: (source?: ProjectSetupStartSource) => Promise<boolean>;
  installRequiredPackages: () => Promise<boolean>;
  commitChanges: (message: string, force?: boolean) => Promise<boolean>;
  syncRepo: () => Promise<boolean>;
  refreshStatus: () => Promise<void>;
  refreshCommits: () => Promise<void>;
  refreshAll: () => Promise<void>;

  // v2: Diff actions
  loadWorkingDiff: (filePath: string) => Promise<void>;
  selectCommit: (commitHash: string) => Promise<void>;
  loadCommitFileDiff: (filePath: string) => Promise<void>;
  clearSelection: () => void;

  // v2: Branch actions
  refreshBranches: () => Promise<void>;
  switchBranch: (branchName: string) => Promise<boolean>;
  createBranch: (branchName: string) => Promise<boolean>;
  renameBranch: (oldName: string, newName: string) => Promise<boolean>;
  deleteBranch: (branchName: string) => Promise<boolean>;
  branchAndCommit: (branchName: string, message: string) => Promise<boolean>;

  // v2: Recovery actions
  undoLastCommit: () => Promise<boolean>;
  discardAllChanges: () => Promise<boolean>;
  discardFileChanges: (filePath: string) => Promise<boolean>;
  rewindToLastSnapshot: () => Promise<boolean>;

  // v2: Conflict checking actions
  conflictedFiles: ConflictedFile[];
  selectedConflictFile: string | null;
  setSelectedConflictFile: Dispatch<SetStateAction<string | null>>;
  conflictCheckResult: BranchConflictCheckResult | null;
  mergeReviewFiles: MergeReviewFile[];
  isLoadingMergeReviewFiles: boolean;
  isCheckingConflicts: boolean;
  loadMergeReviewFiles: (targetBranch?: string, sourceBranch?: string) => Promise<MergeReviewFile[]>;
  loadMergeReviewFileDiff: (filePath: string, targetBranch?: string, sourceBranch?: string) => Promise<MergeReviewDiffResult | null>;
  checkConflictsOnly: (targetBranch?: string, sourceBranch?: string, options?: MergeOptions) => Promise<BranchConflictCheckResult | null>;
  startMerge: (targetBranch?: string, sourceBranch?: string, options?: MergeOptions) => Promise<StartMergeResult | null>;
  checkBranchConflicts: (targetBranch?: string, sourceBranch?: string, options?: MergeOptions) => Promise<BranchConflictCheckResult | null>;
  clearConflicts: () => void;
  detectedParentBranch: DetectedParentBranch | null;
  fetchParentBranch: () => Promise<ParentBranchResult | null>;
  conflictSidesInfo: ConflictSidesInfo | null;

  // v2: Merge options
  isSquashMerge: boolean;
  setIsSquashMerge: Dispatch<SetStateAction<boolean>>;

  // v2: Conflict resolution actions
  fileResolutions: FileResolutionsMap;
  setFileResolution: (filePath: string, strategy: ResolutionStrategy) => void;
  mergeState: MergeState | null;
  isResolvingConflict: boolean;
  loadConflictResolutionData: (path: string) => Promise<ConflictResolutionData | null>;
  resolveConflictWithDecisions: (
    path: string,
    token: string,
    decisions: Record<string, ConflictRegionDecision>,
  ) => Promise<boolean>;
  resolveConflict: (filePath: string, strategy: ResolutionStrategy) => Promise<boolean>;
  applyAllResolutions: () => Promise<boolean>;
  abortMerge: () => Promise<boolean>;
  completeMerge: (message: string) => Promise<boolean>;
  refreshMergeState: () => Promise<MergeState | null>;

  // v2: Stuck state recovery actions
  abortCurrentOperation: () => Promise<boolean>;
  // Cherry-pick
  abortCherryPick: () => Promise<boolean>;
  continueCherryPick: () => Promise<boolean>;
  skipCherryPickCommit: () => Promise<boolean>;
  // Revert
  revertCommit: (commitHash: string) => Promise<boolean>;
  abortRevert: () => Promise<boolean>;
  continueRevert: () => Promise<boolean>;
  skipRevertCommit: () => Promise<boolean>;
  // Bisect
  abortBisect: () => Promise<boolean>;
  getBisectState: () => Promise<BisectState | null>;
  // AM (patch)
  abortAM: () => Promise<boolean>;
  skipAMPatch: () => Promise<boolean>;
  // Detached HEAD
  createBranchFromDetached: (branchName: string) => Promise<boolean>;
  // Lock files
  removeAllStaleLocks: () => Promise<boolean>;

  // ===== GitHub Integration (Phase 2) =====
  
  // GitHub state
  ghInstalled: boolean;
  ghVersion: string;
  ghAuthStatus: GitHubAuthStatus | null;
  isOffline: boolean;
  isCheckingGhAuth: boolean;
  isStartingGitHubLogin: boolean;
  ghRepos: GitHubRepo[];
  isLoadingGhRepos: boolean;
  changeRequestRepository: GitHubChangeRequestRepository | null;
  changeRequestViewerLogin: string;
  changeRequests: GitHubChangeRequest[];
  omittedExternalChangeRequestCount: number;
  changeRequestsMayHaveMore: boolean;
  isLoadingChangeRequests: boolean;
  changeRequestError: GitHubChangeRequestError | null;
  selectedChangeRequest: GitHubChangeRequest | null;
  changeRequestFiles: GitHubChangeRequestFile[];
  changeRequestTotalFiles: number;
  isChangeRequestFilesTruncated: boolean;
  selectedChangeRequestFilePath: string | null;
  isLoadingChangeRequestDetail: boolean;
  changeRequestDetailError: GitHubChangeRequestError | null;
  changeRequestSnapshot: ChangeRequestSnapshot | null;
  isPreparingChangeRequestSnapshot: boolean;
  changeRequestSnapshotError: GitHubChangeRequestError | null;
  changeRequestCreateEligibility: ChangeRequestCreateEligibility;
  isCreatingChangeRequest: boolean;
  
  // GitHub actions
  checkGitHubAuth: () => Promise<void>;
  loginGitHub: () => Promise<GitHubAuthResult>;
  startGitHubLogin: () => Promise<GitHubDeviceFlowResult>;
  completeGitHubLogin: () => Promise<GitHubAuthResult>;
  cancelGitHubLogin: () => Promise<GitHubAuthResult>;
  logoutGitHub: () => Promise<GitHubAuthResult>;
  loadGitHubRepos: (limit?: number, visibility?: string) => Promise<GitHubRepoListResult>;
  cloneGitHubRepo: (repo: string, destPath: string) => Promise<GitHubCloneResult>;
  publishToGitHub: (name: string, description: string, isPrivate: boolean, owner?: string) => Promise<GitHubRepoCreateResult>;
  loadUserOrganizations: () => Promise<GitHubOrganizationsResult>;
  loadChangeRequests: () => Promise<void>;
  selectChangeRequest: (number: number) => Promise<void>;
  selectChangeRequestFile: (path: string | null) => void;
  returnToChangeRequestOverview: () => void;
  clearChangeRequestState: () => void;
  checkChangeRequestCreateEligibility: (sourceBranch: string) => Promise<ChangeRequestCreateEligibility>;
  loadChangeRequestTargets: () => Promise<GitHubChangeRequestTargetsResult>;
  findOpenChangeRequestForBranch: (sourceBranch: string) => Promise<GitHubFindChangeRequestResult>;
  createChangeRequest: (options: GitHubCreateChangeRequestOptions) => Promise<GitHubCreateChangeRequestResult>;

  // ===== Project Creation (Welcome Screen) =====

  /**
   * Orchestrate full project creation: init → commit → (optional) publish.
   * Calls `onStepChange` as each phase begins so the UI stepper can advance.
   */
  createProject: (options: CreateProjectOptions) => Promise<CreateProjectResult>;
}

// ============================================================================
// Provider Props
// ============================================================================

export interface RepoProviderProps {
  children: ReactNode;
}
