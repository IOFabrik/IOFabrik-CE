import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureProjectDefaultBranch: vi.fn(), GetTrackedPatterns: vi.fn(), TrackPattern: vi.fn(),
}));
vi.mock('../../../context', () => ({ useRepo: () => mocks }));
vi.mock('../../../../bindings/iofabrik/services/lfsservice', () => mocks);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useLfsAutoTrackBeforeSave } from './useLfsAutoTrackBeforeSave';

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
});
