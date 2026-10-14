import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const {
  DetectRepo,
  Status,
  CommitAll,
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
  InitializeLFS,
  TrackPattern,
  InitRepo,
  GetAppSettings,
  SaveAppSettings,
  EnsureIdentity,
  GetUserProfile,
  SetUserProfile,
  StartBackgroundTasks,
  StopBackgroundTasks,
  WriteRepoLocalConfig,
  RepoCreateFromLocal,
  EnsureIOFabrikDir,
  WatchDirectory,
  StopWatching,
  toastMocks,
} = vi.hoisted(() => ({
  DetectRepo: vi.fn(),
  Status: vi.fn(),
  CommitAll: vi.fn(),
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
  InitializeLFS: vi.fn(),
  TrackPattern: vi.fn(),
  InitRepo: vi.fn(),
  GetAppSettings: vi.fn(),
  SaveAppSettings: vi.fn(),
  EnsureIdentity: vi.fn(),
  GetUserProfile: vi.fn(),
  SetUserProfile: vi.fn(),
  StartBackgroundTasks: vi.fn(),
  StopBackgroundTasks: vi.fn(),
  WriteRepoLocalConfig: vi.fn(),
  RepoCreateFromLocal: vi.fn(),
  EnsureIOFabrikDir: vi.fn(),
  WatchDirectory: vi.fn(),
  StopWatching: vi.fn(),
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
  CommitAll,
  CheckoutBranch: vi.fn(),
  CreateBranchAndCheckout: vi.fn(),
  RenameBranch: vi.fn(),
  DeleteBranch: vi.fn(),
  StashAndSwitchBranch: vi.fn(),
  ResetSoftHead: vi.fn(),
  ResetHardHead: vi.fn(),
  DiscardAll: vi.fn(),
  DiscardFile: vi.fn(),
  InitRepo,
  StartMergeWithOptions: vi.fn(),
  EnsureChangeRequestSnapshotsLocal: vi.fn(),
  EnsureChangeRequestFileContent: vi.fn(),
  ClearChangeRequestSnapshot: vi.fn(),
  ClearChangeRequestSnapshots: vi.fn(),
  ResolveConflictKeepOurs: vi.fn(),
  ResolveConflictKeepTheirs: vi.fn(),
  ResolveConflictKeepBoth: vi.fn(),
  AbortMerge: vi.fn(),
  CompleteMerge: vi.fn(),
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
  RepoCreateFromLocal,
  InitializeLFS,
  TrackPattern,
  EnsurePortableToolchainIfNeeded: vi.fn(),
  SyncWithProgress: vi.fn(),
  GetAppSettings,
  SaveAppSettings,
  EnsureIdentity,
  GetUserProfile,
  SetUserProfile,
  WriteRepoLocalConfig,
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
    userName: null,
    userEmail: null,
  }),
}));

vi.mock('../../analytics/analytics', () => ({
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
}));

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

describe('RepoContext git identity prompts', () => {
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
    CommitAll.mockResolvedValue({ success: true, message: 'ok' });
    GetCommitGraph.mockResolvedValue({ hasError: false, commits: [] });
    Branches.mockResolvedValue({ hasError: false, current: 'main', local: [], remote: [] });
    GetMergeState.mockResolvedValue({ inMerge: false, inRebase: false, hasConflicts: false });
    GetConflictedFiles.mockResolvedValue([]);
    GetGitVersion.mockResolvedValue('2.45.0');
    IsGHInstalled.mockResolvedValue(false);
    GetGHVersion.mockResolvedValue('');
    AuthStatus.mockResolvedValue(null);
    IsLFSInstalled.mockResolvedValue(true);
    GetPresetPatterns.mockResolvedValue([]);
    GetRemotes.mockResolvedValue(['origin']);
    GetSettings.mockResolvedValue({ fetchSettings: { pruneStaleBranches: true, fetchTags: true } });
    InitializeLFS.mockResolvedValue({ success: true });
    TrackPattern.mockResolvedValue({ success: true });
    InitRepo.mockResolvedValue({ success: true });
    GetAppSettings.mockResolvedValue({ lastRepoPath: '' });
    SaveAppSettings.mockResolvedValue({ success: true });
    EnsureIdentity.mockResolvedValue({ wasAutoSet: false, name: '', email: '' });
    GetUserProfile.mockResolvedValue({ name: '', email: '' });
    SetUserProfile.mockResolvedValue({ success: true, message: 'saved' });
    StartBackgroundTasks.mockResolvedValue({ success: true });
    StopBackgroundTasks.mockResolvedValue({ success: true });
    EnsureIOFabrikDir.mockResolvedValue({ success: true });
    WriteRepoLocalConfig.mockResolvedValue({ success: true });
    WatchDirectory.mockResolvedValue({ success: true });
    StopWatching.mockResolvedValue({ success: true });
  });

  it.each([true, false])('does not prepare project settings just by opening a folder (isRepo=%s)', async (isRepo) => {
    DetectRepo.mockResolvedValue({ path: '/tmp/folder', isRepo, branch: 'main', hasError: false });
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => { api = value; });
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      expect(await api!.openRepo('/tmp/folder')).toBe(true);
    });

    expect(EnsureIOFabrikDir).not.toHaveBeenCalled();
  });

  it.each(['result', 'rejection'])('stops project setup when the settings folder cannot be prepared (%s)', async (failure) => {
    const error = 'Could not prepare the project settings folder. Check the folder\'s permissions and try again.';
    DetectRepo.mockResolvedValue({ path: '/tmp/folder', isRepo: false, hasError: false });
    if (failure === 'result') {
      EnsureIOFabrikDir.mockResolvedValue({ success: false, error });
    } else {
      EnsureIOFabrikDir.mockRejectedValue(new Error('Attribute update failed'));
    }
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => { api = value; });
    await waitFor(() => expect(api?.gitInstalled && api?.lfsInstalled).toBe(true));
    await act(async () => { await api!.openRepo('/tmp/folder'); });

    await act(async () => { expect(await api!.startTracking()).toBe(false); });

    expect(EnsureIOFabrikDir).toHaveBeenCalledWith('/tmp/folder');
    expect(CommitAll).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(error, expect.any(Object));
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(api!.isLoading).toBe(false);
  });

  it.each(['result', 'rejection'])('stops project creation before saving or publishing when settings fail (%s)', async (failure) => {
    const error = 'Could not prepare the project settings folder. Check the folder\'s permissions and try again.';
    IsGHInstalled.mockResolvedValue(true);
    DetectRepo.mockResolvedValue({ path: '/tmp/new-project', isRepo: false, hasError: false });
    if (failure === 'result') {
      WriteRepoLocalConfig.mockResolvedValue({ success: false, error });
    } else {
      WriteRepoLocalConfig.mockRejectedValue(new Error('Attribute update failed'));
    }
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => { api = value; });
    await waitFor(() => expect(api?.gitInstalled && api?.lfsInstalled && api?.ghInstalled).toBe(true));
    const onStepChange = vi.fn();

    await act(async () => {
      expect(await api!.createProject({
        path: '/tmp/new-project',
        remote: { skip: false, repoName: 'new-project' },
        onStepChange,
      })).toEqual({ success: false, error });
    });

    expect(WriteRepoLocalConfig).toHaveBeenCalledWith('/tmp/new-project', expect.any(Object));
    expect(CommitAll).not.toHaveBeenCalled();
    expect(RepoCreateFromLocal).not.toHaveBeenCalled();
    expect(onStepChange.mock.calls).toEqual([[0]]);
  });

  it('prompts before saving changes when git identity is missing', async () => {
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => {
      api = value;
    });

    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      await api!.openRepo('/tmp/repo');
    });

    const commitPromise = api!.commitChanges('Save tank logic');

    await waitFor(() => {
      expect(api!.gitIdentityPrompt?.isOpen).toBe(true);
    });

    expect(CommitAll).not.toHaveBeenCalled();
    expect(api!.gitIdentityPrompt?.reason).toBe('save');

    await act(async () => {
      api!.cancelGitIdentityPrompt();
    });

    await expect(commitPromise).resolves.toBe(false);
  });

  it('continues saving after the user supplies a repo-local identity', async () => {
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => {
      api = value;
    });

    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      await api!.openRepo('/tmp/repo');
    });

    const commitPromise = api!.commitChanges('Save tank logic');

    await waitFor(() => {
      expect(api!.gitIdentityPrompt?.isOpen).toBe(true);
    });

    await act(async () => {
      await api!.submitGitIdentityPrompt('Guest User', 'guest@example.com', false);
    });

    await expect(commitPromise).resolves.toBe(true);
    expect(SetUserProfile).toHaveBeenCalledWith(
      '/tmp/repo',
      { name: 'Guest User', email: 'guest@example.com' },
      false,
    );
    expect(CommitAll).toHaveBeenCalledWith('/tmp/repo', 'Save tank logic');
  });

  it('skips the initial setup commit when the user cancels the identity prompt', async () => {
    let api: ReturnType<typeof useRepo> | null = null;
    renderHarness((value) => {
      api = value;
    });

    await waitFor(() => expect(api).not.toBeNull());

    DetectRepo.mockResolvedValueOnce({ path: '/tmp/new-project', isRepo: false, branch: '', hasError: false });
    await act(async () => {
      await api!.openRepo('/tmp/new-project');
    });

    let startTrackingPromise!: Promise<boolean>;
    act(() => {
      startTrackingPromise = api!.startTracking();
    });

    await waitFor(() => {
      expect(api!.gitIdentityPrompt?.isOpen).toBe(true);
      expect(api!.gitIdentityPrompt?.reason).toBe('initial-commit');
    });

    await act(async () => {
      api!.cancelGitIdentityPrompt();
    });

    await expect(startTrackingPromise).resolves.toBe(true);
    expect(CommitAll).not.toHaveBeenCalled();
    expect(toastMocks.info).toHaveBeenCalledWith(
      'The first saved revision was skipped until a name and email are added.',
      expect.any(Object),
    );
  });
});
