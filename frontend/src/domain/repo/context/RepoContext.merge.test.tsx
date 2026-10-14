import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const {
  DetectRepo,
  Status,
  GetCommitGraph,
  Branches,
  GetMergeState,
  GetConflictedFiles,
  GetGitVersion,
  IsGHInstalled,
  GetGHVersion,
  AuthStatus,
  IsLFSInstalled,
  GetPresetPatterns,
  GetRemotes,
  GetSettings,
  StartMergeWithOptions,
  CompleteMerge,
  GetAppSettings,
  SaveAppSettings,
  EnsureIdentity,
  GetUserProfile,
  SetUserProfile,
  StartBackgroundTasks,
  StopBackgroundTasks,
  EnsureIOFabrikDir,
  WatchDirectory,
  StopWatching,
  CheckoutBranch,
  analyticsMocks,
  toastMocks,
} = vi.hoisted(() => ({
  DetectRepo: vi.fn(),
  Status: vi.fn(),
  GetCommitGraph: vi.fn(),
  Branches: vi.fn(),
  GetMergeState: vi.fn(),
  GetConflictedFiles: vi.fn(),
  GetGitVersion: vi.fn(),
  IsGHInstalled: vi.fn(),
  GetGHVersion: vi.fn(),
  AuthStatus: vi.fn(),
  IsLFSInstalled: vi.fn(),
  GetPresetPatterns: vi.fn(),
  GetRemotes: vi.fn(),
  GetSettings: vi.fn(),
  StartMergeWithOptions: vi.fn(),
  CompleteMerge: vi.fn(),
  GetAppSettings: vi.fn(),
  SaveAppSettings: vi.fn(),
  EnsureIdentity: vi.fn(),
  GetUserProfile: vi.fn(),
  SetUserProfile: vi.fn(),
  StartBackgroundTasks: vi.fn(),
  StopBackgroundTasks: vi.fn(),
  EnsureIOFabrikDir: vi.fn(),
  WatchDirectory: vi.fn(),
  StopWatching: vi.fn(),
  CheckoutBranch: vi.fn(),
  analyticsMocks: {
    trackRepoOpened: vi.fn(),
    trackRepoClosed: vi.fn(),
    trackRepoInitialized: vi.fn(),
    trackCommitCreated: vi.fn(),
    trackCommitBranchAndSave: vi.fn(),
    trackCommitUndone: vi.fn(),
    trackChangesDiscarded: vi.fn(),
    trackSyncStarted: vi.fn(),
    trackSyncCompleted: vi.fn(),
    trackSyncFailed: vi.fn(),
    trackBranchSwitched: vi.fn(),
    trackBranchCreated: vi.fn(),
    trackConflictDetected: vi.fn(),
    trackConflictResolved: vi.fn(),
    trackMergeCompleted: vi.fn(),
    trackMergeAborted: vi.fn(),
    trackErrorShown: vi.fn(),
    trackProjectSetupStarted: vi.fn(),
    trackProjectSetupCompleted: vi.fn(),
    trackProjectPublishAttempted: vi.fn(),
    trackProjectPublishFailed: vi.fn(),
    trackProjectPublishCompleted: vi.fn(),
  },
  toastMocks: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../../../bindings/iofabrik/services/repositorysettingsservice', () => ({
  GetProjectDefaultBranch: vi.fn().mockResolvedValue({ effectiveBranch: '', mode: 'automatic', availability: 'needs-selection', choices: [] }),
  RefreshProjectDefaultBranch: vi.fn().mockResolvedValue({ effectiveBranch: '', mode: 'automatic', availability: 'needs-selection', choices: [] }),
  SetProjectDefaultBranch: vi.fn(),
  UseGitHubDefault: vi.fn(),
}));

vi.mock('../services/repo-queries', () => ({
  DetectRepo,
  Status,
  GetCommitGraph,
  ShowCommit: vi.fn(),
  DiffWorkingRaw: vi.fn(),
  DiffCommitFileRaw: vi.fn(),
  Branches,
  CheckBranchConflicts: vi.fn(),
  ListMergeReviewFiles: vi.fn(),
  DiffMergeReviewFileRaw: vi.fn(),
  GetParentBranch: vi.fn(),
  GetMergeState,
  GetConflictedFiles,
  GetConflictSidesInfo: vi.fn(),
  GetBisectState: vi.fn(),
  GetGitVersion,
  IsGHInstalled,
  GetGHVersion,
  AuthStatus,
  RepoList: vi.fn(),
  ListUserOrganizations: vi.fn(),
  IsLFSInstalled,
  GetPresetPatterns,
  GetRemotes,
  GetSettings,
}));

vi.mock('../services/repo-commands', () => ({
  CommitAll: vi.fn(),
  CheckoutBranch,
  CreateBranchAndCheckout: vi.fn(),
  RenameBranch: vi.fn(),
  DeleteBranch: vi.fn(),
  StashAndSwitchBranch: vi.fn(),
  ResetSoftHead: vi.fn(),
  ResetHardHead: vi.fn(),
  DiscardAll: vi.fn(),
  DiscardFile: vi.fn(),
  InitRepo: vi.fn(),
  StartMergeWithOptions,
  EnsureChangeRequestSnapshotsLocal: vi.fn(),
  EnsureChangeRequestFileContent: vi.fn(),
  ClearChangeRequestSnapshot: vi.fn(),
  ClearChangeRequestSnapshots: vi.fn(),
  ResolveConflictKeepOurs: vi.fn(),
  ResolveConflictKeepTheirs: vi.fn(),
  ResolveConflictKeepBoth: vi.fn(),
  AbortMerge: vi.fn(),
  CompleteMerge,
  AbortCurrentOperation: vi.fn(),
  AbortCherryPick: vi.fn(),
  ContinueCherryPick: vi.fn(),
  SkipCherryPickCommit: vi.fn(),
  AbortRevert: vi.fn(),
  ContinueRevert: vi.fn(),
  SkipRevertCommit: vi.fn(),
  RevertCommit: vi.fn(),
  AbortBisect: vi.fn(),
  AbortAM: vi.fn(),
  SkipAMPatch: vi.fn(),
  CreateBranchFromDetached: vi.fn(),
  RemoveAllStaleLocks: vi.fn(),
  Pull: vi.fn(),
  AuthLogin: vi.fn(),
  AuthLoginStart: vi.fn(),
  AuthLoginComplete: vi.fn(),
  AuthLoginCancel: vi.fn(),
  AuthLogout: vi.fn(),
  RepoClone: vi.fn(),
  RepoCreateFromLocal: vi.fn(),
  InitializeLFS: vi.fn(),
  TrackPattern: vi.fn(),
  EnsurePortableToolchainIfNeeded: vi.fn(),
  SyncWithProgress: vi.fn(),
  GetAppSettings,
  SaveAppSettings,
  EnsureIdentity,
  GetUserProfile,
  SetUserProfile,
  WriteRepoLocalConfig: vi.fn(),
  EnsureIOFabrikDir,
  StartBackgroundTasks,
  StopBackgroundTasks,
  ApplyGitignoreTemplate: vi.fn(),
  RevealInFinder: vi.fn(),
  OpenInTerminal: vi.fn(),
}));

vi.mock('../polling/useStatusPolling', () => ({
  useStatusPolling: vi.fn(),
}));

vi.mock('../../auth/context/AuthContext', () => ({
  useAuth: () => ({
    userName: 'Test User',
    userEmail: 'test@iofabrik.com',
  }),
}));

vi.mock('../../analytics/analytics', () => analyticsMocks);

vi.mock('../../../../bindings/iofabrik/services/filewatcherservice', () => ({
  WatchDirectory,
  StopWatching,
}));

vi.mock('../../../shared/runtime/events', () => ({
  onEvent: vi.fn(() => () => {}),
}));

vi.mock('../../../shared/utils/recentFolders', () => ({
  addRecentFolder: vi.fn(),
}));

vi.mock('../../../viewers/registry/viewer-cache', () => ({
  clearViewerCache: vi.fn(),
}));

vi.mock('../../../viewers/components/file/l5x', () => ({
  clearAllTabStates: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: toastMocks,
}));

import { RepoProvider, useRepo } from './RepoContext';

function createMergeState(hasConflicts: boolean, inMerge = true) {
  return {
    inMerge,
    inRebase: false,
    hasConflicts,
    inCherryPick: false,
    inRevert: false,
    inBisect: false,
    inAM: false,
    isDetached: false,
    hasLockFile: false,
  };
}

function CaptureRepoApi({ onReady }: { onReady: (api: ReturnType<typeof useRepo>) => void }): null {
  const api = useRepo();
  onReady(api);
  return null;
}

function renderHarness(onReady: (api: ReturnType<typeof useRepo>) => void): void {
  const Wrapper = ({ children }: { children: ReactNode }) => <RepoProvider>{children}</RepoProvider>;
  render(
    <Wrapper>
      <CaptureRepoApi onReady={onReady} />
    </Wrapper>,
  );
}

describe('RepoContext merge completion guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    DetectRepo.mockResolvedValue({ path: '/tmp/repo', isRepo: true, branch: 'main', hasError: false });
    Status.mockResolvedValue({
      branch: 'main',
      ahead: 0,
      behind: 0,
      changedFiles: [],
      hasChanges: false,
      hasUpstream: true,
      totalLocalCommits: 0,
      hasError: false,
    });
    GetCommitGraph.mockResolvedValue({ hasError: false, commits: [] });
    Branches.mockResolvedValue({ hasError: false, current: 'main', local: [], remote: [] });
    GetMergeState.mockResolvedValue(createMergeState(false, false));
    GetConflictedFiles.mockResolvedValue([]);
    GetGitVersion.mockResolvedValue('2.45.0');
    IsGHInstalled.mockResolvedValue(false);
    GetGHVersion.mockResolvedValue('');
    AuthStatus.mockResolvedValue(null);
    IsLFSInstalled.mockResolvedValue(true);
    GetPresetPatterns.mockResolvedValue([]);
    GetRemotes.mockResolvedValue(['origin']);
    GetSettings.mockResolvedValue({ fetchSettings: { pruneStaleBranches: true, fetchTags: true } });

    StartMergeWithOptions.mockResolvedValue({ success: true });
    CompleteMerge.mockResolvedValue({ success: true });

    GetAppSettings.mockResolvedValue({ lastRepoPath: '' });
    SaveAppSettings.mockResolvedValue({ success: true });
    EnsureIdentity.mockResolvedValue({ wasAutoSet: false, name: '', email: '' });
    GetUserProfile.mockResolvedValue({ name: 'Test User', email: 'test@iofabrik.com' });
    SetUserProfile.mockResolvedValue({ success: true, message: 'saved' });
    StartBackgroundTasks.mockResolvedValue({ success: true });
    StopBackgroundTasks.mockResolvedValue({ success: true });
    EnsureIOFabrikDir.mockResolvedValue({ success: true });
    WatchDirectory.mockResolvedValue({ success: true });
    StopWatching.mockResolvedValue({ success: true });
    CheckoutBranch.mockResolvedValue({ success: true });
  });

  it('blocks completion when the live repository state still reports conflicts', async () => {
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => {
      api = value;
    });

    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      await api!.openRepo('/tmp/repo');
    });

    await waitFor(() => {
      expect(api!.repoPath).toBe('/tmp/repo');
    });

    GetMergeState.mockResolvedValueOnce(createMergeState(false, true));
    GetConflictedFiles.mockResolvedValueOnce([]);

    await act(async () => {
      await api!.startMerge('main', 'feature/tank-logic', { squash: true });
    });

    await waitFor(() => {
      expect(api!.conflictCheckResult?.liveMergePhase).toBe('ready-to-complete');
    });

    GetMergeState.mockResolvedValueOnce(createMergeState(true, true));
    GetConflictedFiles.mockResolvedValueOnce([
      { path: 'logic/alpha.L5X', status: 'both-modified' },
    ]);

    let result = false;
    await act(async () => {
      result = await api!.completeMerge('Finish merge');
    });

    expect(result).toBe(false);
    expect(CompleteMerge).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(api!.conflictedFiles).toEqual([{ path: 'logic/alpha.L5X', status: 'both-modified' }]);
      expect(api!.selectedConflictFile).toBe('logic/alpha.L5X');
      expect(api!.conflictCheckResult?.liveMergePhase).toBe('resolving');
    });

    expect(toastMocks.error).toHaveBeenCalledWith(
      '1 file still needs a choice before you can finish this merge.',
      expect.any(Object),
    );
  });

  it('hydrates live conflicted files after merge start before allowing the finish step', async () => {
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => {
      api = value;
    });

    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      await api!.openRepo('/tmp/repo');
    });

    await waitFor(() => {
      expect(api!.repoPath).toBe('/tmp/repo');
    });

    GetMergeState.mockResolvedValueOnce(createMergeState(false, true));
    GetConflictedFiles.mockResolvedValueOnce([
      { path: 'logic/alpha.L5X', status: 'both-modified' },
    ]);

    await act(async () => {
      await api!.startMerge('main', 'feature/tank-logic', { squash: true });
    });

    await waitFor(() => {
      expect(api!.conflictedFiles).toEqual([
        { path: 'logic/alpha.L5X', status: 'both-modified' },
      ]);
      expect(api!.selectedConflictFile).toBe('logic/alpha.L5X');
      expect(api!.conflictCheckResult?.liveMergePhase).toBe('resolving');
    });
  });

  it('allows completion only after the live repository state is conflict-free', async () => {
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => {
      api = value;
    });

    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      await api!.openRepo('/tmp/repo');
    });

    await waitFor(() => {
      expect(api!.repoPath).toBe('/tmp/repo');
    });

    GetMergeState.mockResolvedValueOnce(createMergeState(false, true));
    GetConflictedFiles.mockResolvedValueOnce([]);

    await act(async () => {
      await api!.startMerge('main', 'feature/tank-logic', { squash: true });
    });

    await waitFor(() => {
      expect(api!.conflictCheckResult?.liveMergePhase).toBe('ready-to-complete');
    });

    GetMergeState.mockResolvedValueOnce(createMergeState(false, true));
    GetConflictedFiles.mockResolvedValueOnce([]);

    let result = false;
    await act(async () => {
      result = await api!.completeMerge('Finish merge');
    });

    expect(result).toBe(true);
    expect(CompleteMerge).toHaveBeenCalledWith('/tmp/repo', 'Finish merge');
  });
});