import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutStore, integrationStore } = vi.hoisted(() => ({
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
  useRepo: () => ({ ghAuthStatus: null }),
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
  GetUserProfile: vi.fn(() => new Promise(() => {})),
}));

vi.mock('./LFSAutoTrackModal', () => ({ default: () => null }));
vi.mock('./MainBranchSaveChoiceModal', () => ({ default: () => null }));
vi.mock('../../../widgets/layout', () => ({ RewindConfirmModal: () => null }));

import SidebarCommitPanel from './SidebarCommitPanel';

function renderPanel({
  currentBranch = 'feature/valve',
  onCommit = vi.fn().mockResolvedValue(true),
}: {
  currentBranch?: string;
  onCommit?: (message: string, force?: boolean) => Promise<boolean>;
} = {}) {
  render(
    <SidebarCommitPanel
      changedFiles={[{ path: 'logic/valve.L5X', name: 'valve.L5X', status: 'modified' }]}
      onCommit={onCommit}
      onBranchAndCommit={vi.fn().mockResolvedValue(true)}
      onRewind={vi.fn().mockResolvedValue(true)}
      onDiscardFile={vi.fn().mockResolvedValue(true)}
      currentBranch={currentBranch}
      repoPath="/repo"
      isCommitting={false}
      isRewinding={false}
    />,
  );
  return { onCommit };
}

async function enterMessageAndSave(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('Describe changes...'), {
    target: { value: 'Update valve timing' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument());
}

describe('SidebarCommitPanel conflict check option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
