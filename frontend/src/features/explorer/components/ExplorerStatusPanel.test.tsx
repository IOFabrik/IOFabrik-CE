import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../welcome/components/PublishToCloudModal', () => ({ default: () => null }));

import ExplorerStatusPanel from './ExplorerStatusPanel';

const baseProps = {
  status: 'featureBranch' as const,
  branchName: 'feature/valve',
  effectiveDefaultBranch: 'main',
  updateWorkflowEnabled: true,
};

describe('ExplorerStatusPanel update workflow', () => {
  it.each([
    ['release/2026', 'release/2026', false],
    ['main', 'release/2026', true],
    ['master', 'trunk', true],
    ['Trunk', 'trunk', true],
    ['', 'trunk', false],
    ['work', undefined, false],
  ] as const)('classifies %s against the selected default %s', (branchName, effectiveDefaultBranch, visible) => {
    render(<ExplorerStatusPanel status="push" hasRemote={false} branchName={branchName} effectiveDefaultBranch={effectiveDefaultBranch} />);
    const action = screen.queryByRole('button', { name: 'I am ready to merge' });
    if (visible) expect(action).toBeInTheDocument();
    else expect(action).not.toBeInTheDocument();
  });

  it('disables publishing a local project during a preview operation', () => {
    render(<ExplorerStatusPanel status="push" hasRemote={false} operationInProgress />);
    expect(screen.getByRole('button', { name: 'Publish to Cloud' })).toBeDisabled();
  });

  it('does not expose an alternate update trigger without an active session', () => {
    render(<ExplorerStatusPanel {...baseProps} />);

    expect(screen.queryByRole('button', { name: 'I am ready to merge' })).not.toBeInTheDocument();
  });

  it('offers sharing only after the local update is complete', () => {
    const onOpenCombineChanges = vi.fn();
    render(
      <ExplorerStatusPanel
        {...baseProps}
        review={{
          state: 'updated',
          message: 'Your work is up to date with the shared project.',
          conflictCount: 0,
        }}
        onOpenCombineChanges={onOpenCombineChanges}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share updated work' }));
    expect(onOpenCombineChanges).toHaveBeenCalledTimes(1);
  });

  it('opens Conflict Review while files need decisions', () => {
    const onOpenCombineChanges = vi.fn();
    render(
      <ExplorerStatusPanel
        {...baseProps}
        review={{
          state: 'needs-decisions',
          message: 'Some files need a decision.',
          conflictCount: 2,
        }}
        onOpenCombineChanges={onOpenCombineChanges}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Conflict Review' }));
    expect(onOpenCombineChanges).toHaveBeenCalledTimes(1);
  });

  it('shows an inline recovery message and retries a blocked update', () => {
    const onRetryUpdate = vi.fn();
    render(
      <ExplorerStatusPanel
        {...baseProps}
        review={{
          state: 'blocked',
          message: 'Shared updates could not be added.',
          error: 'This project has unsaved files. Save or discard them, then try again.',
          conflictCount: 0,
        }}
        onRetryUpdate={onRetryUpdate}
      />,
    );

    expect(screen.getByText(/has unsaved files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRetryUpdate).toHaveBeenCalledTimes(1);
  });

  it('reopens recovery for a failed interrupted update', () => {
    const onOpenCombineChanges = vi.fn();
    render(
      <ExplorerStatusPanel
        {...baseProps}
        review={{
          state: 'failed',
          message: 'The update could not finish safely.',
          error: 'The update could not finish. Review the project, then cancel or try again.',
          conflictCount: 0,
        }}
        onOpenCombineChanges={onOpenCombineChanges}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(onOpenCombineChanges).toHaveBeenCalledTimes(1);
  });

  it('disables actions while shared updates are being checked', () => {
    render(
      <ExplorerStatusPanel
        {...baseProps}
        review={{
          state: 'fetching',
          message: 'IOFabrik is checking for shared updates.',
          conflictCount: 0,
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled();
  });
});
