import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  useLayout: () => layoutStore.current,
}));

vi.mock('../../../../bindings/iofabrik/services/filedialogservice', () => ({
  OpenFolderDialog: vi.fn(),
}));

vi.mock('../../welcome/pages', () => ({
  RecentProjectsPage: () => <div>Recent projects</div>,
  NewProjectPage: () => <div>New project</div>,
  CloneProjectPage: () => <div>Clone project</div>,
  OpenFolderPage: () => <div>Open folder</div>,
}));

vi.mock('../components/SimpleFileBrowser', () => ({
  default: () => <div data-testid="file-browser">File browser</div>,
}));

vi.mock('../components/ExplorerTabsBar', () => ({
  default: () => <div data-testid="explorer-tabs">Tabs</div>,
}));

vi.mock('../components/ExplorerCommitTabContent', () => ({
  default: () => <div>Commit tab</div>,
}));

vi.mock('../components/ProjectSetupBanner', () => ({
  default: ({ onConnectGitHub }: { onConnectGitHub?: () => Promise<void> }) => (
    <button type="button" onClick={() => void onConnectGitHub?.()}>
      Connect GitHub
    </button>
  ),
}));

vi.mock('../../../viewers/components/shared/ViewerRenderer', () => ({
  ViewerRenderer: () => <div>Viewer</div>,
  getViewerForFile: vi.fn(),
  getViewerById: vi.fn(),
}));

vi.mock('../../../viewers/components/shared/DiffRenderer', () => ({
  DiffRenderer: () => <div>Diff</div>,
}));

vi.mock('../../../viewers/registry/diff-request-adapters', () => ({
  buildCommitDiffRequest: vi.fn(),
  buildWorkingTreeDiffRequest: vi.fn(),
}));

vi.mock('../../auth/components/GitHubDeviceFlowModal', () => ({
  default: ({ open, userCode, verificationUrl }: { open: boolean; userCode: string; verificationUrl: string }) => (
    open ? <div>{`Device flow modal ${userCode} ${verificationUrl}`}</div> : null
  ),
}));

import ExplorerPage from './ExplorerPage';

function createRepoValue(overrides: Record<string, unknown> = {}) {
  return {
    repoPath: '/tmp/repo',
    repoInfo: { isRepo: true, path: '/tmp/repo' },
    repoStatus: {
      changedFiles: [],
      branch: 'main',
    },
    openFolder: vi.fn(),
    startTracking: vi.fn(),
    installRequiredPackages: vi.fn(),
    publishToGitHub: vi.fn(),
    startGitHubLogin: vi.fn(),
    loadUserOrganizations: vi.fn(),
    refreshRemotes: vi.fn(),
    hasRemote: false,
    isLoading: false,
    gitInstalled: true,
    lfsInstalled: true,
    isInstallingPackages: false,
    ghInstalled: true,
    ghAuthStatus: null,
    ...overrides,
  };
}

function createLayoutValue(overrides: Record<string, unknown> = {}) {
  return {
    activeExplorerTab: 'file-browser',
    explorerTabs: [{ id: 'file-browser', type: 'file-browser', title: 'File Browser', isPinned: true }],
    selectedWelcomeCategory: 'recent-projects',
    newProjectPrefillPath: '',
    setNewProjectPrefillPath: vi.fn(),
    ...overrides,
  };
}

describe('ExplorerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoStore.listeners.clear();
    repoStore.current = null;
    layoutStore.current = null;
  });

  it('opens the GitHub device flow modal from the publish banner when auth starts', async () => {
    const startGitHubLogin = vi.fn().mockResolvedValue({
      success: true,
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://github.com/login/device',
    });

    repoStore.current = createRepoValue({ startGitHubLogin });
    layoutStore.current = createLayoutValue();

    render(<ExplorerPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    await waitFor(() => {
      expect(startGitHubLogin).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Device flow modal ABCD-EFGH https://github.com/login/device')).toBeInTheDocument();
    });
  });
});