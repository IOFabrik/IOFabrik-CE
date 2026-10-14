import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConflictQueue from './ConflictQueue';

describe('ConflictQueue', () => {
  const baseProps = {
    conflictedFiles: [
      { path: 'logic/alpha.L5X', status: 'both-modified' as const },
      { path: 'logic/beta.L5X', status: 'both-added' as const },
    ],
    fileResolutions: {},
    isResolvingConflict: false,
    conflictSidesInfo: null,
    sourceBranch: 'feature/mixer-update',
    targetBranch: 'main',
    onResolve: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to the first unresolved file when no file is selected', async () => {
    const onSelectFile = vi.fn();

    render(
      <ConflictQueue
        {...baseProps}
        selectedConflictFile={null}
        onSelectFile={onSelectFile}
      />,
    );

    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith('logic/alpha.L5X');
    });
  });

  it('auto-advances to the next unresolved file after a decision is saved', async () => {
    const onSelectFile = vi.fn();
    const { rerender } = render(
      <ConflictQueue
        {...baseProps}
        selectedConflictFile="logic/alpha.L5X"
        onSelectFile={onSelectFile}
      />,
    );

    rerender(
      <ConflictQueue
        {...baseProps}
        selectedConflictFile="logic/alpha.L5X"
        fileResolutions={{ 'logic/alpha.L5X': 'mine' }}
        onSelectFile={onSelectFile}
      />,
    );

    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith('logic/beta.L5X');
    });
  });

  it('clears the active file when every conflict has been resolved', async () => {
    const onSelectFile = vi.fn();

    render(
      <ConflictQueue
        {...baseProps}
        selectedConflictFile="logic/beta.L5X"
        fileResolutions={{
          'logic/alpha.L5X': 'mine',
          'logic/beta.L5X': 'theirs',
        }}
        onSelectFile={onSelectFile}
      />,
    );

    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalledWith(null);
    });
  });

  it('sends the active file path when the user keeps their current branch version', () => {
    const onSelectFile = vi.fn();

    render(
      <ConflictQueue
        {...baseProps}
        selectedConflictFile="logic/alpha.L5X"
        onSelectFile={onSelectFile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Keep Current File/ }));

    expect(baseProps.onResolve).toHaveBeenCalledWith('logic/alpha.L5X', 'mine');
  });

  it('shows the complete-file fallback when detailed conflict data is unavailable', () => {
    render(
      <ConflictQueue
        {...baseProps}
        selectedConflictFile="logic/alpha.L5X"
        onSelectFile={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Keep Current File/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep Incoming File/ })).toBeInTheDocument();
  });

  it('shows the completion state once there are no remaining conflicted files to choose from', () => {
    const onSelectFile = vi.fn();

    render(
      <ConflictQueue
        {...baseProps}
        conflictedFiles={[]}
        selectedConflictFile={null}
        onSelectFile={onSelectFile}
      />,
    );

    expect(screen.getByText('All decisions are complete')).toBeInTheDocument();
    expect(screen.getByText('IOFabrik is updating your work now. Keep this project open.')).toBeInTheDocument();
  });
});