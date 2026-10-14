import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutStore, integrationStore, repoStore } = vi.hoisted(() => ({
  repoStore: {
    projectDefaultBranch: { availability: 'ready', effectiveBranch: 'main' },
    ensureProjectDefaultBranch: vi.fn(),
  },
  layoutStore: {
    openExplorerTab: vi.fn(),
    openExplorerMergeModal: vi.fn(),
  },
  integrationStore: {
    current: {
      enabled: true,
      isBusy: false,
      isSaveBlocked: false,
      startUpdate: vi.fn(),
      refresh: vi.fn(),
    },
  },
}));

vi.mock('../../../context', () => ({
  useLayout: () => layoutStore,
  useRepo: () => ({ ghAuthStatus: null, ...repoStore }),
}));

vi.mock('../../integration', () => ({
  useIntegrationSession: () => integrationStore.current,
}));

vi.mock('../hooks/useLfsAutoTrackBeforeSave', () => ({
  useLfsAutoTrackBeforeSave: () => ({
    modalOpen: false,
    candidates: [],
    selectedFilePaths: new Set<string>(),
    isApplying: false,
    runBeforeSave: async (action: () => Promise<boolean>, onSuccess?: () => void) => {
      if (await action()) onSuccess?.();
    },
    toggleCandidate: vi.fn(),
    toggleSelectAll: vi.fn(),
    cancelModal: vi.fn(),
    confirmAndContinue: vi.fn(),
  }),
}));

vi.mock('../../../../bindings/iofabrik/services/settingsservice', () => ({
  GetUserProfile: vi.fn().mockResolvedValue({ name: 'Engineer' }),
}));

vi.mock('./LFSAutoTrackModal', () => ({ default: () => null }));
vi.mock('../../../widgets/layout', () => ({ RewindConfirmModal: () => null }));

import SidebarCommitPanel from './SidebarCommitPanel';

function renderPanel({
  currentBranch = 'feature/valve',
  onCommit = vi.fn().mockResolvedValue(true),
  onBranchAndCommit = vi.fn().mockResolvedValue(true),
  repoPath = '/repo',
  isFirstSave = false,
}: {
  currentBranch?: string;
  onCommit?: (message: string, force?: boolean) => Promise<boolean>;
  onBranchAndCommit?: (branch: string, message: string) => Promise<boolean>;
  repoPath?: string;
  isFirstSave?: boolean;
} = {}) {
  const view = render(
    <SidebarCommitPanel
      changedFiles={[{ path: 'logic/valve.L5X', name: 'valve.L5X', status: 'modified' }]}
      onCommit={onCommit}
      onBranchAndCommit={onBranchAndCommit}
      onRewind={vi.fn().mockResolvedValue(true)}
      onDiscardFile={vi.fn().mockResolvedValue(true)}
      currentBranch={currentBranch}
      repoPath={repoPath}
      isFirstSave={isFirstSave}
      isCommitting={false}
      isRewinding={false}
    />,
  );
  return { onCommit, onBranchAndCommit, unmount: view.unmount };
}

async function enterMessageAndSave(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('Describe changes...'), {
    target: { value: 'Update valve timing' },
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); });
}

describe('SidebarCommitPanel conflict check option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoStore.projectDefaultBranch = { availability: 'ready', effectiveBranch: 'main' };
    repoStore.ensureProjectDefaultBranch.mockResolvedValue('main');
    integrationStore.current = {
      enabled: true,
      isBusy: false,
      isSaveBlocked: false,
      startUpdate: vi.fn().mockResolvedValue({ state: 'updated' }),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('saves normally when the option is unchecked', async () => {
    const { onCommit } = renderPanel();

    await enterMessageAndSave();

    expect(onCommit).toHaveBeenCalledWith('Update valve timing');
    expect(integrationStore.current.startUpdate).not.toHaveBeenCalled();
    expect(integrationStore.current.refresh).toHaveBeenCalledTimes(1);
  });

  it('starts one update after a checked successful save and opens conflict review', async () => {
    integrationStore.current.startUpdate.mockResolvedValue({ state: 'needs-decisions' });
    const { onCommit } = renderPanel();
    const checkbox = screen.getByRole('checkbox', { name: 'Check for conflicts' });
    fireEvent.click(checkbox);

    await enterMessageAndSave();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(integrationStore.current.startUpdate).toHaveBeenCalledTimes(1);
    expect(layoutStore.openExplorerMergeModal).toHaveBeenCalledTimes(1);
    expect(checkbox).not.toBeChecked();
  });

  it('does not start an update after a failed save and resets the option', async () => {
    const onCommit = vi.fn().mockResolvedValue(false);
    renderPanel({ onCommit });
    const checkbox = screen.getByRole('checkbox', { name: 'Check for conflicts' });
    fireEvent.click(checkbox);

    await enterMessageAndSave();

    expect(integrationStore.current.startUpdate).not.toHaveBeenCalled();
    expect(checkbox).not.toBeChecked();
  });

  it('hides the option on a main branch', () => {
    renderPanel({ currentBranch: 'main' });

    expect(screen.queryByRole('checkbox', { name: 'Check for conflicts' })).not.toBeInTheDocument();
  });

  it('disables save controls while an update needs attention', () => {
    integrationStore.current = {
      ...integrationStore.current,
      isSaveBlocked: true,
    };
    renderPanel();

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Check for conflicts' })).toBeDisabled();
  });

  it('disables save controls before the first update event arrives', () => {
    integrationStore.current = {
      ...integrationStore.current,
      isBusy: true,
    };
    renderPanel();

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Check for conflicts' })).toBeDisabled();
  });

  it('offers default Save choices with the exact custom branch name', async () => {
    repoStore.projectDefaultBranch.effectiveBranch = 'Release/2026';
    repoStore.ensureProjectDefaultBranch.mockResolvedValue('Release/2026');
    const { onCommit, onBranchAndCommit } = renderPanel({ currentBranch: 'Release/2026' });
    await enterMessageAndSave();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Save on the default branch?');
    expect(screen.getByRole('radio', { name: /Save on Release\/2026/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Check for conflicts' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Save on Release\/2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledExactlyOnceWith('Update valve timing'));
    expect(onBranchAndCommit).not.toHaveBeenCalled();
  });

  it('saves the initialized branch first without entering a branch creation loop', async () => {
    const { onCommit, onBranchAndCommit } = renderPanel({ currentBranch: 'main', isFirstSave: true });
    await enterMessageAndSave();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Update valve timing');
    expect(onBranchAndCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it.each(['main', 'master', 'release/2026'])('treats nondefault %s as ordinary work, preserving case', async (currentBranch) => {
    repoStore.projectDefaultBranch.effectiveBranch = 'Release/2026';
    repoStore.ensureProjectDefaultBranch.mockResolvedValue('Release/2026');
    const { onCommit } = renderPanel({ currentBranch });
    expect(screen.getByRole('checkbox', { name: 'Check for conflicts' })).toBeInTheDocument();
    await enterMessageAndSave();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Update valve timing');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the message and performs no Save when default selection is cancelled', async () => {
    repoStore.projectDefaultBranch = { availability: 'needs-selection', effectiveBranch: '' };
    repoStore.ensureProjectDefaultBranch.mockResolvedValue(null);
    const { onCommit, onBranchAndCommit } = renderPanel();
    await enterMessageAndSave();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onBranchAndCommit).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Describe changes...')).toHaveValue('Update valve timing');
  });

  it('resumes only one Save after a pending selection and repeated clicks', async () => {
    let select!: (branch: string) => void;
    repoStore.ensureProjectDefaultBranch.mockReturnValue(new Promise<string>(resolve => { select = resolve; }));
    const { onCommit } = renderPanel();
    fireEvent.change(screen.getByPlaceholderText('Describe changes...'), { target: { value: 'Pending message' } });
    const save = screen.getByRole('button', { name: 'Save Changes' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => { select('trunk'); });
    await waitFor(() => expect(onCommit).toHaveBeenCalledExactlyOnceWith('Pending message'));
    expect(repoStore.ensureProjectDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it('remembers a successful choice only for the same project and effective default', async () => {
    const first = renderPanel({ currentBranch: 'main', repoPath: '/remember-first' });
    await enterMessageAndSave();
    fireEvent.click(screen.getByRole('radio', { name: /Save on main/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember my choice for this session' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
    expect(first.onCommit).toHaveBeenCalledTimes(1);
    first.unmount();

    const same = renderPanel({ currentBranch: 'main', repoPath: '/remember-first' });
    await enterMessageAndSave();
    expect(same.onCommit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    same.unmount();

    const other = renderPanel({ currentBranch: 'main', repoPath: '/remember-second' });
    await enterMessageAndSave();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(other.onCommit).not.toHaveBeenCalled();
    other.unmount();

    repoStore.projectDefaultBranch.effectiveBranch = 'release/2026';
    repoStore.ensureProjectDefaultBranch.mockResolvedValue('release/2026');
    const changed = renderPanel({ currentBranch: 'release/2026', repoPath: '/remember-first' });
    await enterMessageAndSave();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(changed.onCommit).not.toHaveBeenCalled();
  });
});
