import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtime: {
    isWindowsDesktop: vi.fn(),
    isMacDesktop: vi.fn(),
    getCurrentWindowIsMaximised: vi.fn(),
    onCurrentWindowStateChange: vi.fn(),
    minimiseCurrentWindow: vi.fn(),
    toggleCurrentWindowMaximise: vi.fn(),
    closeCurrentWindow: vi.fn(),
  },
  repo: {
    repoPath: '/tmp/repo' as string | null,
    repoInfo: { branch: 'main', isRepo: true },
    repoStatus: {
      hasUpstream: true,
      ahead: 2,
      behind: 3,
      totalLocalCommits: 8,
      changedFiles: [{ path: 'unsaved.L5X' }],
    },
    branches: { local: [{ name: 'main' }, { name: 'feature/valve' }, { name: 'feature/pump' }] },
    closeRepo: vi.fn(),
    openFolder: vi.fn(),
    commits: [{ hash: 'abc' }],
    undoLastCommit: vi.fn(),
    syncRepo: vi.fn(),
    switchBranch: vi.fn(),
    createBranch: vi.fn(),
    refreshBranches: vi.fn(),
    operationInProgress: false,
    isLoading: false,
    isSyncing: false,
    hasRemote: true,
  },
  layout: {
    sidebarCollapsed: false,
    sidebarWidth: 280,
    setActiveView: vi.fn(),
    setSidebarCollapsed: vi.fn(),
  },
  recent: vi.fn(),
  compact: false,
}));

vi.mock('../../shared/runtime/window', () => mocks.runtime);
vi.mock('../../context', () => ({ useRepo: () => mocks.repo, useLayout: () => mocks.layout }));
vi.mock('../../shared/hooks', () => ({
  useWindowSize: () => ({ isCompactTopBar: mocks.compact }),
}));
vi.mock('../../shared/utils/recentFolders', () => ({ loadMergedRecentFolders: mocks.recent }));
vi.mock('../../shared/ui/UndoLastSaveDialog', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button onClick={onConfirm}>Confirm undo</button> : null,
}));

import TopBar from './TopBar';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.isWindowsDesktop.mockReturnValue(true);
  mocks.runtime.isMacDesktop.mockReturnValue(false);
  mocks.runtime.getCurrentWindowIsMaximised.mockResolvedValue(false);
  mocks.runtime.onCurrentWindowStateChange.mockReturnValue(() => {});
  mocks.repo.operationInProgress = false;
  mocks.repo.isLoading = false;
  mocks.repo.isSyncing = false;
  mocks.repo.hasRemote = true;
  mocks.repo.repoPath = '/tmp/repo';
  mocks.repo.repoInfo = { branch: 'main', isRepo: true };
  mocks.repo.repoStatus = {
    hasUpstream: true,
    ahead: 2,
    behind: 3,
    totalLocalCommits: 8,
    changedFiles: [{ path: 'unsaved.L5X' }],
  };
  mocks.layout.sidebarCollapsed = false;
  mocks.compact = false;
  mocks.repo.syncRepo.mockResolvedValue(true);
  mocks.repo.openFolder.mockResolvedValue(true);
  mocks.repo.switchBranch.mockResolvedValue(true);
  mocks.repo.createBranch.mockResolvedValue(true);
  mocks.repo.refreshBranches.mockResolvedValue(undefined);
  mocks.recent.mockResolvedValue(['/tmp/repo', '/tmp/other-project']);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unified Windows top bar', () => {
  it('keeps project, branch and actions mounted when the sidebar collapses or changes width', async () => {
    const { rerender } = render(<TopBar />);
    const sync = screen.getByRole('button', { name: 'Sync Changes' });
    mocks.layout.sidebarCollapsed = true;
    mocks.layout.sidebarWidth = 390;
    rerender(<TopBar />);
    expect(screen.getByRole('button', { name: 'Sync Changes' })).toBe(sync);
    expect(screen.getByRole('button', { name: 'Switch project' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Switch branch' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /sidebar/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /account|profile|sign in/i })
    ).not.toBeInTheDocument();
  });

  it('uses a single live Sync operation and distinguishes saved counts from unsaved files', () => {
    render(<TopBar />);
    const sync = screen.getByRole('button', { name: 'Sync Changes' });
    expect(within(sync).getByLabelText('3 incoming saved changes')).toBeInTheDocument();
    expect(within(sync).getByLabelText('2 outgoing saved changes')).toBeInTheDocument();
    expect(sync.title).toContain('not uncommitted files');
    fireEvent.click(sync);
    expect(mocks.repo.syncRepo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^Pull|^Push/ })).not.toBeInTheDocument();
  });

  it.each([
    { behind: 0, ahead: 0 },
    { behind: 3, ahead: 0 },
    { behind: 0, ahead: 2 },
  ])('hides zero sync counts independently (pull $behind, push $ahead)', ({ behind, ahead }) => {
    mocks.repo.repoStatus.behind = behind;
    mocks.repo.repoStatus.ahead = ahead;
    render(<TopBar />);
    const sync = screen.getByRole('button', { name: 'Sync Changes' });
    expect(within(sync).queryByLabelText('0 incoming saved changes')).not.toBeInTheDocument();
    expect(within(sync).queryByLabelText('0 outgoing saved changes')).not.toBeInTheDocument();
    if (behind > 0) {
      expect(within(sync).getByLabelText(`${behind} incoming saved changes`)).toBeInTheDocument();
    }
    if (ahead > 0) {
      expect(within(sync).getByLabelText(`${ahead} outgoing saved changes`)).toBeInTheDocument();
    }
  });

  it('disables mutation controls while busy and Sync for a local-only project', () => {
    mocks.repo.operationInProgress = true;
    const { rerender } = render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Sync Changes' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Switch branch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch project' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo Last Save' })).toBeDisabled();
    mocks.repo.operationInProgress = false;
    mocks.repo.hasRemote = false;
    rerender(<TopBar />);
    expect(screen.getByRole('button', { name: 'Sync Changes' })).toBeDisabled();
  });

  it('keeps unavailable incoming counts in the tooltip when there is no upstream branch', () => {
    mocks.repo.repoStatus.hasUpstream = false;
    render(<TopBar />);
    expect(screen.queryByLabelText(/incoming saved changes/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync Changes' }).title).toContain(
      'Incoming count is unavailable'
    );
    expect(screen.getByLabelText('8 outgoing saved changes')).toBeInTheDocument();
  });

  it('runs caption actions and maximises only from unused bar space', async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }));
    expect(mocks.runtime.minimiseCurrentWindow).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByRole('combobox', { name: 'Switch branch' }));
    expect(mocks.runtime.toggleCurrentWindowMaximise).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByTestId('window-drag-space'));
    expect(mocks.runtime.toggleCurrentWindowMaximise).toHaveBeenCalledTimes(1);
    const listener = mocks.runtime.onCurrentWindowStateChange.mock.calls[0][0];
    act(() => listener(true));
    expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
    expect(mocks.runtime.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it('filters local branches and switches through the existing handler with keyboard selection', async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Switch branch' }));
    const search = await screen.findByRole('combobox', { name: 'Search branches...' });
    fireEvent.change(search, { target: { value: 'valve' } });
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'feature/pump' })).not.toBeInTheDocument()
    );
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Home' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(mocks.repo.switchBranch).toHaveBeenCalledWith('feature/valve'));
    expect(mocks.repo.refreshBranches).toHaveBeenCalled();
  });

  it('opens the existing Create Branch dialog from the combobox', async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Switch branch' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Create branch' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Branch' })).toBeInTheDocument();
  });

  it('loads recent projects and opens them through the existing folder safeguards', async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'other-project' }));
    await waitFor(() => expect(mocks.repo.openFolder).toHaveBeenCalledWith('/tmp/other-project'));
  });

  it('keeps the existing confirmation flow for opening another project', async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open another project' }));
    expect(await screen.findByRole('heading', { name: 'Switch Project?' })).toBeInTheDocument();
    expect(mocks.repo.closeRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Another Project' }));
    await waitFor(() => expect(mocks.repo.closeRepo).toHaveBeenCalledTimes(1));
    expect(mocks.layout.setSidebarCollapsed).toHaveBeenCalledWith(false);
  });

  it('keeps Undo available in the narrow-window overflow menu', async () => {
    mocks.compact = true;
    render(<TopBar />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Application actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    const undo = await screen.findByRole('menuitem', { name: 'undo' });
    fireEvent.click(undo);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm undo' }));
    expect(mocks.repo.undoLastCommit).toHaveBeenCalledTimes(1);
  });
});
