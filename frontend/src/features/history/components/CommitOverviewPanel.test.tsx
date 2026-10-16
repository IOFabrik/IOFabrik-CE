import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { CommitDetail } from '../../../context';
vi.mock('../../../viewers/components/shared/DiffRenderer', () => ({ DiffRenderer: () => null }));
import CommitOverviewPanel from './CommitOverviewPanel';

it('keeps history previews available while disabling snapshot and file restoration', () => {
  const selectFile = vi.fn();
  const restore = vi.fn();
  const commit = {
    hash: 'a'.repeat(40), message: 'Saved project', author: 'Test', date: '2026-10-16T12:00:00Z',
    parentHashes: [], files: [{ path: 'README.txt', status: 'modified', additions: 1, deletions: 0 }],
  } as unknown as CommitDetail;
  const { rerender } = render(<CommitOverviewPanel repoPath="/project" commit={commit} operationInProgress onSelectFile={selectFile} onRestoreCommit={restore} />);
  for (const button of screen.getAllByRole('button', { name: /Restore/ })) expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(selectFile).toHaveBeenCalledWith('README.txt');
  expect(restore).not.toHaveBeenCalled();
  rerender(<CommitOverviewPanel repoPath="/project" commit={commit} operationInProgress={false} onSelectFile={selectFile} onRestoreCommit={restore} />);
  for (const button of screen.getAllByRole('button', { name: /Restore/ })) expect(button).toBeEnabled();
});
