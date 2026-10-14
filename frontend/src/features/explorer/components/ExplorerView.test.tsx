import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repoStore } = vi.hoisted(() => ({
  repoStore: {
    current: null as Record<string, unknown> | null,
    listeners: new Set<() => void>(),
  },
}));

const { layoutStore } = vi.hoisted(() => ({
  layoutStore: {
    current: null as Record<string, unknown> | null,
    listeners: new Set<() => void>(),
  },
}));

const { integrationStore } = vi.hoisted(() => ({
  integrationStore: {
    current: {
      enabled: true,
      session: null as { state: string; message: string; error?: string } | null,
      entries: [] as Array<{ path: string }>,
      isBusy: false,
      startUpdate: vi.fn(),
    },
  },
}));

vi.mock('../../../context', () => ({
  useRepo: () => {
    const { useSyncExternalStore } = require('react') as typeof import('react');

    return useSyncExternalStore(
      (listener) => {
        repoStore.listeners.add(listener);
        return () => repoStore.listeners.delete(listener);
      },
      () => repoStore.current,
      () => repoStore.current,
    );
  },
  useLayout: () => {
    const { useSyncExternalStore } = require('react') as typeof import('react');
    return useSyncExternalStore(
      (listener) => {
        layoutStore.listeners.add(listener);
        return () => layoutStore.listeners.delete(listener);
      },
      () => layoutStore.current,
      () => layoutStore.current,
    );
  },
}));

vi.mock('../../integration', () => ({
  useIntegrationSession: () => integrationStore.current,
}));

vi.mock('./SidebarCommitPanel', () => ({
  default: ({ currentBranch }: { currentBranch: string }) => (
    <div data-testid="sidebar-commit-panel">Commit panel for {currentBranch}</div>
  ),
}));

vi.mock('./ExplorerStatusPanel', () => ({
  default: ({ onOpenCombineChanges, status, branchName }: { onOpenCombineChanges: () => void; status: string; branchName?: string }) => (
    <button type="button" data-status={status} data-branch={branchName || ''} onClick={onOpenCombineChanges}>
      Open merge modal
    </button>
  ),
}));

vi.mock('../../history/components/HistoryTimeline', () => ({
  default: ({
    selectedHash,
    onSelectCommit,
  }: {
    selectedHash?: string | null;
    onSelectCommit?: (hash: string | null) => void;
  }) => (
    <div data-testid="explorer-timeline" data-selected-hash={selectedHash || ''}>
      Timeline
      <button type="button" onClick={() => onSelectCommit?.('abc123')}>
        Select timeline commit
      </button>
    </div>
  ),
}));

vi.mock('../../auth/components/GitHubDeviceFlowModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div>Device flow modal</div> : null),
}));

import ExplorerView from './ExplorerView';

function createRepoValue(overrides: Record<string, unknown> = {}) {
  return {
    repoPath: '/tmp/repo',
    repoInfo: { isRepo: true },
    projectDefaultBranch: { availability: 'ready', effectiveBranch: 'main' },
    repoStatus: {
      changedFiles: [],
      ahead: 0,
      hasUpstream: true,
      totalLocalCommits: 0,
      branch: 'feature/tank-logic',
    },
    graphCommits: [],
    startTracking: vi.fn(),
    installRequiredPackages: vi.fn(),
    commitChanges: vi.fn(),
    branchAndCommit: vi.fn(),
    discardFileChanges: vi.fn(),
    syncRepo: vi.fn(),
    rewindToLastSnapshot: vi.fn(),
    isLoading: false,
    isCommitting: false,
    isSyncing: false,
    operationInProgress: false,
    hasRemote: true,
    refreshRemotes: vi.fn(),
    gitInstalled: true,
    lfsInstalled: true,
    isInstallingPackages: false,
    ghInstalled: true,
    ghAuthStatus: null,
    startGitHubLogin: vi.fn(),
    publishToGitHub: vi.fn(),
    loadUserOrganizations: vi.fn(),
    changeRequestCreateEligibility: { status: 'unknown' },
    checkChangeRequestCreateEligibility: vi.fn(),
    findOpenChangeRequestForBranch: vi.fn(),
    selectChangeRequest: vi.fn(),
    ...overrides,
  };
}

function createLayoutValue(overrides: Record<string, unknown> = {}) {
  return {
    openExplorerTab: vi.fn(),
    explorerTabs: [{ id: 'file-browser', type: 'file-browser', title: 'File Browser', isPinned: true }],
    activeExplorerTab: 'file-browser',
    setActiveExplorerTab: vi.fn(),
    openExplorerMergeModal: vi.fn(),
    setActiveView: vi.fn(),
    timelineHeight: 160,
    setTimelineHeight: vi.fn((height: number) => {
      layoutStore.current = { ...layoutStore.current, timelineHeight: height };
      layoutStore.listeners.forEach((listener) => listener());
    }),
    ...overrides,
  };
}

describe('ExplorerView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoStore.listeners.clear();
    layoutStore.listeners.clear();
    repoStore.current = null;
    layoutStore.current = null;
    integrationStore.current.session = null;
    integrationStore.current.entries = [];
  });

  it.each([
    ['release/2026', 'release/2026', 'synced'],
    ['main', 'release/2026', 'featureBranch'],
    ['master', 'trunk', 'featureBranch'],
    ['Release/2026', 'release/2026', 'featureBranch'],
    ['', 'trunk', 'synced'],
  ])('classifies %s against %s without inventing a current branch', (branch, effectiveBranch, status) => {
    repoStore.current = createRepoValue({
      projectDefaultBranch: { availability: 'ready', effectiveBranch },
      repoStatus: { branch, changedFiles: [], ahead: 0, hasUpstream: true, totalLocalCommits: 0 },
    });
    layoutStore.current = createLayoutValue();
    render(<ExplorerView />);
    expect(screen.getByRole('button', { name: 'Open merge modal' })).toHaveAttribute('data-status', status);
    expect(screen.getByRole('button', { name: 'Open merge modal' })).toHaveAttribute('data-branch', branch);
  });

  it('keeps an unknown branch unknown while showing unsaved work', () => {
    repoStore.current = createRepoValue({ repoStatus: { changedFiles: [{ path: 'logic.L5X', status: 'modified' }] } });
    layoutStore.current = createLayoutValue();
    render(<ExplorerView />);
    expect(screen.getByTestId('sidebar-commit-panel')).toHaveTextContent('Commit panel for');
    expect(screen.getByTestId('sidebar-commit-panel')).not.toHaveTextContent('main');
  });

  it('keeps the merge modal mounted when merge start changes the panel to has changes', () => {
    repoStore.current = createRepoValue();
    const openExplorerMergeModal = vi.fn();
    layoutStore.current = createLayoutValue({ openExplorerMergeModal });

    render(<ExplorerView />);

    fireEvent.click(screen.getByRole('button', { name: 'Open merge modal' }));

    expect(openExplorerMergeModal).toHaveBeenCalledTimes(1);

    act(() => {
      repoStore.current = createRepoValue({
        repoStatus: {
          changedFiles: [{ path: 'logic/alpha.L5X', staged: false, status: 'modified' }],
          ahead: 0,
          hasUpstream: true,
          totalLocalCommits: 0,
          branch: 'main',
        },
      });
      repoStore.listeners.forEach((listener) => listener());
    });

    expect(screen.getByTestId('sidebar-commit-panel')).toHaveTextContent('Commit panel for main');
    expect(screen.getByTestId('explorer-timeline')).toBeInTheDocument();
    expect(openExplorerMergeModal).toHaveBeenCalledTimes(1);
  });

  it('renders the timeline alongside the upper explorer panel', () => {
    repoStore.current = createRepoValue();
    layoutStore.current = createLayoutValue();

    render(<ExplorerView />);

    expect(screen.getByRole('button', { name: 'Open merge modal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByTestId('explorer-timeline')).toBeInTheDocument();
  });

  it('starts Timeline expanded and preserves its user-defined height when the repository changes', () => {
    repoStore.current = createRepoValue();
    layoutStore.current = createLayoutValue();
    render(<ExplorerView />);
    expect(screen.getByRole('region', { name: 'Timeline' })).toHaveStyle({ height: '160px' });
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Timeline' }), { key: 'ArrowUp' });
    expect(screen.getByRole('region', { name: 'Timeline' })).toHaveStyle({ height: '176px' });
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(screen.getByRole('button', { name: 'Timeline' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('explorer-timeline')).not.toBeVisible();
    act(() => {
      repoStore.current = createRepoValue({ repoPath: '/tmp/other-project' });
      repoStore.listeners.forEach((listener) => listener());
    });
    expect(screen.getByRole('button', { name: 'Timeline' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Timeline' })).toHaveStyle({ height: '176px' });
    expect(screen.getByTestId('explorer-timeline')).toBeVisible();
  });

  it('keeps owned default-branch conflicts in persistent review status', () => {
    integrationStore.current.session = {
      state: 'needs-decisions',
      message: 'Some files need a decision.',
    };
    integrationStore.current.entries = [{ path: 'shared.txt' }];
    repoStore.current = createRepoValue({
      repoStatus: {
        changedFiles: [{ path: 'shared.txt', status: 'modified' }],
        ahead: 1,
        hasUpstream: true,
        totalLocalCommits: 1,
        branch: 'main',
      },
    });
    layoutStore.current = createLayoutValue();

    render(<ExplorerView />);

    expect(screen.queryByTestId('sidebar-commit-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open merge modal' })).toBeInTheDocument();
  });

  it('opens a commit tab when the explorer timeline selects a commit', () => {
    const openExplorerTab = vi.fn();

    repoStore.current = createRepoValue({
      graphCommits: [
        {
          hash: 'abc123',
          shortHash: 'abc123',
          message: 'Inspect valve sync\nWith extra details',
        },
      ],
    });
    layoutStore.current = createLayoutValue({ openExplorerTab });

    render(<ExplorerView />);

    fireEvent.click(screen.getByRole('button', { name: 'Select timeline commit' }));

    expect(openExplorerTab).toHaveBeenCalledWith({
      id: 'commit-abc123',
      title: 'Inspect valve sync',
      type: 'commit',
      commitContext: {
        commitHash: 'abc123',
      },
    });
  });
});
