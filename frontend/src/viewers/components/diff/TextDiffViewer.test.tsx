import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const diffViewerSpy = vi.fn<(props: unknown) => JSX.Element>((_props) => <div data-testid="diff-viewer" />);

vi.mock('../../../features/explorer/components/DiffViewer', () => ({
  default: (props: unknown) => diffViewerSpy(props),
}));

vi.mock('../../../../bindings/iofabrik/services/gitservice', () => ({
  DiffCommitFileRaw: vi.fn(),
  DiffMergeReviewFileRaw: vi.fn(),
  DiffWorkingRaw: vi.fn(),
}));

import {
  DiffCommitFileRaw,
  DiffMergeReviewFileRaw,
  DiffWorkingRaw,
} from '../../../../bindings/iofabrik/services/gitservice';
import TextDiffViewer from './TextDiffViewer';

describe('TextDiffViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads working tree diffs from HEAD vs working snapshots', async () => {
    vi.mocked(DiffWorkingRaw).mockResolvedValue({
      path: 'Docs/notes.txt',
      status: 'modified',
      binary: false,
      rawDiff: '@@ -1 +1 @@',
      hasError: false,
      error: '',
    });

    render(
      <TextDiffViewer
        repoPath="/repo"
        filePath="Docs/notes.txt"
        oldSide={{ kind: 'ref', ref: 'HEAD', path: 'Docs/notes.txt' }}
        newSide={{ kind: 'working', absolutePath: '/repo/Docs/notes.txt', path: 'Docs/notes.txt' }}
        fileStatus="modified"
      />,
    );

    await waitFor(() => {
      expect(DiffWorkingRaw).toHaveBeenCalledWith('/repo', 'Docs/notes.txt');
    });
    expect(DiffCommitFileRaw).not.toHaveBeenCalled();
    expect(DiffMergeReviewFileRaw).not.toHaveBeenCalled();
  });

  it('loads commit history diffs from parent and commit refs', async () => {
    vi.mocked(DiffCommitFileRaw).mockResolvedValue({
      path: 'Docs/notes.txt',
      status: 'modified',
      binary: false,
      rawDiff: '@@ -1 +1 @@',
      hasError: false,
      error: '',
    });

    render(
      <TextDiffViewer
        repoPath="/repo"
        filePath="Docs/notes.txt"
        oldSide={{ kind: 'ref', ref: 'abc123^', path: 'Docs/notes.txt' }}
        newSide={{ kind: 'ref', ref: 'abc123', path: 'Docs/notes.txt' }}
        fileStatus="modified"
      />,
    );

    await waitFor(() => {
      expect(DiffCommitFileRaw).toHaveBeenCalledWith('/repo', 'abc123', 'Docs/notes.txt');
    });
    expect(DiffWorkingRaw).not.toHaveBeenCalled();
    expect(DiffMergeReviewFileRaw).not.toHaveBeenCalled();
  });

  it('loads explicit-parent history diffs through the commit diff endpoint', async () => {
    vi.mocked(DiffCommitFileRaw).mockResolvedValue({
      path: 'Docs/notes.txt',
      status: 'modified',
      binary: false,
      rawDiff: '@@ -1 +1 @@',
      hasError: false,
      error: '',
    });

    render(
      <TextDiffViewer
        textDiffSource={{ kind: 'commit', commit: 'abc123' }}
        repoPath="/repo"
        filePath="Docs/notes.txt"
        oldSide={{ kind: 'ref', ref: 'deadbeef', path: 'Docs/notes.txt' }}
        newSide={{ kind: 'ref', ref: 'abc123', path: 'Docs/notes.txt' }}
        fileStatus="modified"
      />,
    );

    await waitFor(() => {
      expect(DiffCommitFileRaw).toHaveBeenCalledWith('/repo', 'abc123', 'Docs/notes.txt');
    });
    expect(DiffWorkingRaw).not.toHaveBeenCalled();
    expect(DiffMergeReviewFileRaw).not.toHaveBeenCalled();
  });

  it('uses preloaded merge-review diffs without fetching', async () => {
    render(
      <TextDiffViewer
        repoPath="/repo"
        filePath="Docs/notes.txt"
        oldSide={{ kind: 'ref', ref: 'origin/main', path: 'Docs/notes.txt' }}
        newSide={{ kind: 'ref', ref: 'feature/docs', path: 'Docs/notes.txt' }}
        fileStatus="modified"
        fileDiff={{
          path: 'Docs/notes.txt',
          status: 'modified',
          binary: false,
          rawDiff: '@@ -1 +1 @@',
          hasError: false,
          error: '',
        } as any}
      />,
    );

    await waitFor(() => {
      expect(diffViewerSpy).toHaveBeenCalled();
    });
    expect(DiffWorkingRaw).not.toHaveBeenCalled();
    expect(DiffCommitFileRaw).not.toHaveBeenCalled();
    expect(DiffMergeReviewFileRaw).not.toHaveBeenCalled();
  });

  it('does not mistake two arbitrary revision hashes for a commit and its parent', async () => {
    vi.mocked(DiffMergeReviewFileRaw).mockResolvedValue({
      path: 'Revisions/Main.L5X', status: 'modified', binary: false,
      rawDiff: '@@ -1 +1 @@', hasError: false,
    });
    render(<TextDiffViewer repoPath="/repo" filePath="Revisions/Main.L5X"
      oldSide={{ kind: 'ref', ref: '1111111', path: 'Revisions/Main.L5X' }}
      newSide={{ kind: 'ref', ref: '2222222', path: 'Revisions/Main.L5X' }}
    />);
    await waitFor(() => expect(DiffMergeReviewFileRaw).toHaveBeenCalledWith('/repo', '1111111', '2222222', 'Revisions/Main.L5X'));
    expect(DiffCommitFileRaw).not.toHaveBeenCalled();
  });
});
