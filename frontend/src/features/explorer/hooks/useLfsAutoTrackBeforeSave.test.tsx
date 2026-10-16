import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureProjectDefaultBranch: vi.fn(), GetTrackedPatterns: vi.fn(), TrackPattern: vi.fn(),
}));
vi.mock('../../../context', () => ({ useRepo: () => mocks }));
vi.mock('../../../../bindings/iofabrik/services/lfsservice', () => mocks);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useLfsAutoTrackBeforeSave } from './useLfsAutoTrackBeforeSave';
import LFSAutoTrackModal from '../components/LFSAutoTrackModal';

function DialogHarness({ save }: { save: () => Promise<boolean> }) {
  const flow = useLfsAutoTrackBeforeSave({
    repoPath: '/first', changedFiles: [{ path: 'Controller.ACD', name: 'Controller.ACD', status: 'untracked' }],
  });
  return <>
    <button onClick={() => void flow.runBeforeSave(save)}>Start Save</button>
    <LFSAutoTrackModal
      open={flow.modalOpen}
      candidates={flow.candidates}
      selectedFilePaths={flow.selectedFilePaths}
      isApplying={flow.isApplying}
      onOpenChange={open => { if (!open) flow.cancelModal(); }}
      onToggleFile={flow.toggleCandidate}
      onToggleSelectAll={flow.toggleSelectAll}
      onConfirm={flow.confirmAndContinue}
    />
  </>;
}

function harness() {
  return renderHook(({ repoPath }) => useLfsAutoTrackBeforeSave({
    repoPath, changedFiles: [{ path: 'Controller.ACD', name: 'Controller.ACD', status: 'untracked' }],
  }), { initialProps: { repoPath: '/first' } });
}

describe('Save readiness before automatic file tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureProjectDefaultBranch.mockResolvedValue('trunk');
    mocks.GetTrackedPatterns.mockResolvedValue([]);
    mocks.TrackPattern.mockResolvedValue({ success: true });
  });

  it('does not enter tracking or Save after cancelled default selection', async () => {
    mocks.ensureProjectDefaultBranch.mockResolvedValue(null);
    const { result } = harness();
    const save = vi.fn();
    await act(async () => { await result.current.runBeforeSave(save); });
    expect(mocks.GetTrackedPatterns).not.toHaveBeenCalled();
    expect(mocks.TrackPattern).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(result.current.modalOpen).toBe(false);
  });

  it('revalidates before tracking and retains the pending Save after cancellation', async () => {
    const { result } = harness();
    const save = vi.fn().mockResolvedValue(true);
    await act(async () => { await result.current.runBeforeSave(save); });
    expect(result.current.modalOpen).toBe(true);
    mocks.ensureProjectDefaultBranch.mockResolvedValue(null);
    await act(async () => { await result.current.confirmAndContinue(); });
    expect(mocks.TrackPattern).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    mocks.ensureProjectDefaultBranch.mockResolvedValue('trunk');
    await act(async () => { await Promise.all([result.current.confirmAndContinue(), result.current.confirmAndContinue()]); });
    expect(mocks.TrackPattern).toHaveBeenCalledExactlyOnceWith('/first', '*.acd');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancels pending tracking and Save when switching projects', async () => {
    const { result, rerender } = harness();
    const save = vi.fn();
    await act(async () => { await result.current.runBeforeSave(save); });
    rerender({ repoPath: '/second' });
    await act(async () => { await result.current.confirmAndContinue(); });
    expect(result.current.modalOpen).toBe(false);
    expect(mocks.TrackPattern).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not track files or save after cancelling during readiness validation', async () => {
    const { result } = harness();
    const save = vi.fn().mockResolvedValue(true);
    const onSuccess = vi.fn();
    await act(async () => { await result.current.runBeforeSave(save, onSuccess); });
    let finishReadiness!: (branch: string) => void;
    mocks.ensureProjectDefaultBranch.mockImplementationOnce(() => new Promise<string>(resolve => { finishReadiness = resolve; }));
    let confirming!: Promise<void>;
    act(() => { confirming = result.current.confirmAndContinue(); });
    act(() => { result.current.cancelModal(); });
    await act(async () => { finishReadiness('trunk'); await confirming; });

    expect(result.current.modalOpen).toBe(false);
    expect(mocks.TrackPattern).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not let a cancelled confirmation apply a replacement Save request', async () => {
    const { result } = harness();
    const save = vi.fn().mockResolvedValue(true);
    await act(async () => { await result.current.runBeforeSave(save); });
    let finishReadiness!: (branch: string) => void;
    mocks.ensureProjectDefaultBranch.mockImplementationOnce(() => new Promise<string>(resolve => { finishReadiness = resolve; }));
    let confirming!: Promise<void>;
    act(() => { confirming = result.current.confirmAndContinue(); });
    act(() => { result.current.cancelModal(); });
    // Reusing the same Save callback still represents a new confirmation.
    await act(async () => { await result.current.runBeforeSave(save); });
    await act(async () => { finishReadiness('trunk'); await confirming; });
    expect(result.current.modalOpen).toBe(true);
    expect(mocks.TrackPattern).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    await act(async () => { await result.current.confirmAndContinue(); });
    expect(mocks.TrackPattern).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves once when the real dialog is confirmed twice during readiness validation', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(<DialogHarness save={save} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start Save' })); });
    let finishReadiness!: (branch: string) => void;
    mocks.ensureProjectDefaultBranch.mockImplementationOnce(() => new Promise<string>(resolve => { finishReadiness = resolve; }));
    const confirm = screen.getByRole('button', { name: 'Remember & Save' });
    await act(async () => { fireEvent.click(confirm); fireEvent.click(confirm); });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => { finishReadiness('trunk'); });
    expect(mocks.TrackPattern).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps a replacement dialog open when an old cancelled confirmation finishes', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(<DialogHarness save={save} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start Save' })); });
    let finishReadiness!: (branch: string) => void;
    mocks.ensureProjectDefaultBranch.mockImplementationOnce(() => new Promise<string>(resolve => { finishReadiness = resolve; }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remember & Save' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start Save' })); });
    await act(async () => { finishReadiness('trunk'); });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mocks.TrackPattern).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remember & Save' })); });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
