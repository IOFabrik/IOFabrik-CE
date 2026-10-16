import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), onEvent: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../services/repo-commands', () => ({ GeneratePreview: mocks.generate }));
vi.mock('../../../shared/runtime/events', () => ({ onEvent: mocks.onEvent }));
import { usePreviewGeneration } from './usePreviewGeneration';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('preview generation lifecycle', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.onEvent.mockReturnValue(mocks.unsubscribe); });

  it('keeps the lock through refresh, filters events, and exposes the final result', async () => {
    const backend = deferred<{ success: boolean }>();
    const refresh = deferred<void>();
    let locked = false;
    const lock = async <T,>(_label: string, operation: () => Promise<T>) => {
      if (locked) return null;
      locked = true;
      try { return await operation(); } finally { locked = false; }
    };
    mocks.generate.mockImplementation(() => {
      expect(mocks.onEvent).toHaveBeenCalled();
      return backend.promise;
    });
    const { result } = renderHook(() => usePreviewGeneration('C:\\Project', lock, () => refresh.promise));
    let task!: Promise<boolean>;
    act(() => { task = result.current.generatePreview('C:\\Project\\Controller.ACD'); });
    expect(locked).toBe(true);
    expect(result.current.previewRunningRef.current).toBe(true);
    expect(result.current.previewNotification?.status).toBe('running');
    const event = mocks.onEvent.mock.calls[0][1];
    act(() => event({ data: { operationId: 'different', message: 'Wrong operation' } }));
    expect(result.current.previewNotification?.message).not.toBe('Wrong operation');
    act(() => event({ data: { operationId: mocks.generate.mock.calls[0][2], message: 'Exporting the copied project…' } }));
    expect(result.current.previewNotification?.message).toBe('Exporting the copied project…');
    act(() => result.current.dismissPreviewNotification());
    expect(result.current.previewNotification).not.toBeNull();
    await act(async () => { expect(await result.current.generatePreview('Other.ACD')).toBe(false); });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    await act(async () => { backend.resolve({ success: true }); });
    expect(locked).toBe(true);
    expect(result.current.previewNotification?.message).toBe('Refreshing project files…');
    await act(async () => { refresh.resolve(); expect(await task).toBe(true); });
    expect(locked).toBe(false);
    expect(result.current.previewRunningRef.current).toBe(false);
    expect(result.current.previewNotification?.status).toBe('success');
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(['result', 'exception', 'refresh'])('retains a dismissible failure after a %s failure', async kind => {
    mocks.generate.mockImplementation(async () => {
      if (kind === 'exception') throw new Error('internal details');
      return { success: kind === 'refresh', error: 'Choose another ACD and try again.' };
    });
    const refresh = vi.fn(async () => { if (kind === 'refresh') throw new Error('refresh failed'); });
    const lock = async <T,>(_label: string, operation: () => Promise<T>) => operation();
    const { result } = renderHook(() => usePreviewGeneration('/Project', lock, refresh));
    await act(async () => { expect(await result.current.generatePreview('/Project/Controller.ACD')).toBe(false); });
    expect(result.current.previewNotification?.status).toBe('error');
    expect(result.current.previewNotification?.message).not.toContain('internal details');
    expect(result.current.previewRunningRef.current).toBe(false);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => result.current.dismissPreviewNotification());
    expect(result.current.previewNotification).toBeNull();
  });
});
