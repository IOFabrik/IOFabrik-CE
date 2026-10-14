import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffRenderer } from '../shared/DiffRenderer';
import { buildChangeRequestDiffRequest, buildCommitDiffRequest, buildMergeReviewDiffRequest, buildWorkingTreeDiffRequest } from '../../registry/diff-request-adapters';
import { DiffCommitFileRaw, DiffMergeReviewFileRaw, DiffWorkingRaw, ReadFileAtRevisionLarge } from '../../../../bindings/iofabrik/services/gitservice';
import { OpenFile, ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';

const events = vi.hoisted(() => ({ listener: undefined as undefined | ((event: unknown) => void) }));
vi.mock('../../../shared/runtime/events', () => ({ onEvent: (_name: string, handler: (event: unknown) => void) => { events.listener = handler; return vi.fn(); } }));
vi.mock('./l5x-layout-diff/L5XLayoutDiffViewer', () => ({ default: () => <div>Cannot generate L5X diff</div> }));
vi.mock('../../../../bindings/iofabrik/services/gitservice', () => ({
  DiffCommitFileRaw: vi.fn(), DiffMergeReviewFileRaw: vi.fn(), DiffWorkingRaw: vi.fn(), ReadFileAtRevisionLarge: vi.fn(),
}));
vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({ ReadTextFile: vi.fn(), OpenFile: vi.fn() }));

const patch = 'diff --git a/Main.L5X b/Main.L5X\n--- a/Main.L5X\n+++ b/Main.L5X\n@@ -1 +1 @@\n-old XML\n+new XML\n';
const result = { path: 'Main.L5X', status: 'modified', binary: false, rawDiff: patch, hasError: false };
let counter = 0;

describe('L5X diff mode through the shared renderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counter++;
    vi.mocked(ReadFileAtRevisionLarge).mockResolvedValue({ content: '<Controller />', hasError: false });
    vi.mocked(ReadTextFile).mockResolvedValue({ content: '<Controller />', success: true });
    vi.mocked(DiffWorkingRaw).mockResolvedValue(result);
    vi.mocked(DiffCommitFileRaw).mockResolvedValue(result);
    vi.mocked(DiffMergeReviewFileRaw).mockResolvedValue(result);
    vi.mocked(OpenFile).mockResolvedValue({ success: true, error: '' });
  });

  it.each(['working', 'history', 'merge', 'change request'])('uses the standard text diff for %s, including missing file sides', async (context) => {
    const input = { repoPath: `/repo-${counter}`, filePath: 'Main.L5X', fileStatus: context === 'history' ? 'deleted' : 'added', showHeader: false };
    const request = context === 'working' ? buildWorkingTreeDiffRequest({ ...input, absoluteFilePath: `${input.repoPath}/Main.L5X` })
      : context === 'history' ? buildCommitDiffRequest({ ...input, commitHash: 'abc123', parentHash: 'deadbeef' })
      : context === 'merge' ? buildMergeReviewDiffRequest({ ...input, targetRef: 'main', sourceRef: 'feature' })
      : buildChangeRequestDiffRequest({ ...input, baseRef: 'refs/iofabrik/base', headRef: 'refs/iofabrik/head' });
    render(<DiffRenderer {...request} />);
    await screen.findByText('Cannot generate L5X diff');
    expect(ReadFileAtRevisionLarge).not.toHaveBeenCalled();
    expect(DiffWorkingRaw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(await screen.findByText('new XML')).toBeVisible();
    expect(screen.getByText('old XML')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Open in Default App' })).toHaveLength(1);
    if (context === 'working') expect(DiffWorkingRaw).toHaveBeenCalledWith(input.repoPath, input.filePath);
    if (context === 'history') expect(DiffCommitFileRaw).toHaveBeenCalledWith(input.repoPath, 'abc123', input.filePath);
    if (context === 'merge') expect(DiffMergeReviewFileRaw).toHaveBeenCalledWith(input.repoPath, 'main', 'feature', input.filePath);
    if (context === 'change request') expect(DiffMergeReviewFileRaw).toHaveBeenCalledWith(input.repoPath, 'refs/iofabrik/base', 'refs/iofabrik/head', input.filePath);
    fireEvent.click(screen.getByRole('button', { name: 'Pretty' }));
    expect(screen.getByText('Cannot generate L5X diff')).toBeVisible();
  });

  it('blocks oversized revision text before loading a patch and keeps the toggle usable', async () => {
    vi.mocked(ReadFileAtRevisionLarge).mockResolvedValue({ content: '', hasError: true, error: 'File is too large to display (max 10MB)' });
    const request = buildCommitDiffRequest({ repoPath: `/repo-${counter}`, filePath: 'Main.L5X', commitHash: 'abc123', fileStatus: 'modified' });
    render(<DiffRenderer {...request} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raw' }));
    expect(await screen.findByText(/exceeds the 10 MB/)).toBeVisible();
    expect(DiffCommitFileRaw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pretty' }));
    expect(screen.getByText('Cannot generate L5X diff')).toBeVisible();
  });

  it('refreshes working diffs and resets mode when reopened', async () => {
    const request = buildWorkingTreeDiffRequest({ repoPath: `/repo-${counter}`, filePath: 'Main.L5X', absoluteFilePath: `/repo-${counter}/Main.L5X`, fileStatus: 'modified' });
    const view = render(<DiffRenderer {...request} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raw' }));
    await screen.findByText('new XML');
    vi.mocked(DiffWorkingRaw).mockResolvedValue({ ...result, rawDiff: patch.replace('new XML', 'updated XML') });
    await act(async () => events.listener?.({ data: { path: `/repo-${counter}/Main.L5X`, eventType: 'write' } }));
    expect(await screen.findByText('updated XML')).toBeVisible();
    view.unmount();
    render(<DiffRenderer {...request} />);
    expect(await screen.findByRole('button', { name: 'Pretty' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows binary text-diff results without routing back into the L5X renderer', async () => {
    vi.mocked(DiffWorkingRaw).mockResolvedValue({ ...result, binary: true, rawDiff: '' });
    const request = buildWorkingTreeDiffRequest({ repoPath: `/repo-${counter}`, filePath: 'Main.L5X', absoluteFilePath: `/repo-${counter}/Main.L5X` });
    render(<DiffRenderer {...request} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raw' }));
    expect(await screen.findByText('This file cannot be displayed as a text diff.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Raw' })).toHaveLength(1);
  });

  it('opens the absolute working path from a Windows repository', async () => {
    const request = buildWorkingTreeDiffRequest({ repoPath: 'C:\\repo', filePath: 'Main.L5X', absoluteFilePath: 'C:\\repo\\Main.L5X' });
    render(<DiffRenderer {...request} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Default App' }));
    await waitFor(() => expect(OpenFile).toHaveBeenCalledWith('C:\\repo\\Main.L5X'));
  });

  it('checks both renamed paths before displaying the existing text diff', async () => {
    const request = buildMergeReviewDiffRequest({
      repoPath: `/repo-${counter}`, filePath: 'New.L5X', oldPath: 'Old.L5X',
      fileStatus: 'renamed', targetRef: 'main', sourceRef: 'feature',
    });
    render(<DiffRenderer {...request} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raw' }));
    await screen.findByText('new XML');
    expect(ReadFileAtRevisionLarge).toHaveBeenCalledWith(request.repoPath, 'Old.L5X', 'main');
    expect(ReadFileAtRevisionLarge).toHaveBeenCalledWith(request.repoPath, 'New.L5X', 'feature');
    expect(DiffMergeReviewFileRaw).toHaveBeenCalledWith(request.repoPath, 'main', 'feature', 'New.L5X');
  });
});
