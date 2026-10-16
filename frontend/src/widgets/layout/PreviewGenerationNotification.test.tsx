import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewNotificationState } from '../../domain/repo/hooks/usePreviewGeneration';
const mocks = vi.hoisted(() => ({ notification: null as PreviewNotificationState | null, dismiss: vi.fn() }));
vi.mock('../../context', () => ({ useRepo: () => ({ previewNotification: mocks.notification, dismissPreviewNotification: mocks.dismiss }) }));
import { PreviewGenerationNotification } from './PreviewGenerationNotification';

const running: PreviewNotificationState = { operationId: 'one', startedAt: 0, repoPath: 'C:\\Projects\\Line 1', filePath: 'C:\\Projects\\Line 1\\Controller.ACD', status: 'running', message: 'Exporting the copied project…' };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('persistent preview notification', () => {
  it('leaves browsing and focus available and cannot be dismissed while running', () => {
    vi.useFakeTimers();
    mocks.notification = running;
    const browse = vi.fn();
    render(<><button onClick={browse}>Browse history</button><PreviewGenerationNotification /></>);
    const button = screen.getByRole('button', { name: 'Browse history' });
    button.focus();
    fireEvent.click(button);
    expect(browse).toHaveBeenCalled();
    expect(button).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Controller.ACD');
    expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
    expect(screen.queryByText(running.message)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60000));
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it('counts down without resetting for stage updates and stays active beyond the estimate', () => {
    mocks.notification = running;
    const { rerender } = render(<PreviewGenerationNotification />);
    expect(screen.getByRole('img', { name: 'Estimated time remaining: 45 seconds' })).toHaveTextContent('45s');
    act(() => vi.advanceTimersByTime(12000));
    mocks.notification = { ...running, message: 'Publishing preview…' };
    rerender(<PreviewGenerationNotification />);
    expect(screen.getByRole('img', { name: 'Estimated time remaining: 33 seconds' })).toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('33s');
    act(() => vi.advanceTimersByTime(33000));
    expect(screen.getByRole('img', { name: /Taking longer than estimated/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Generating preview');
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
    mocks.notification = { ...running, operationId: 'two', startedAt: Date.now() };
    rerender(<PreviewGenerationNotification />);
    expect(screen.getByRole('img', { name: 'Estimated time remaining: 45 seconds' })).toBeInTheDocument();
  });

  it('uses the operation start time after remount and stops the countdown on completion', () => {
    mocks.notification = running;
    act(() => vi.advanceTimersByTime(10000));
    const { rerender, unmount } = render(<PreviewGenerationNotification />);
    expect(screen.getByRole('img', { name: 'Estimated time remaining: 35 seconds' })).toBeInTheDocument();
    mocks.notification = { ...running, status: 'success' };
    rerender(<PreviewGenerationNotification />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Preview ready');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('auto-dismisses success after five seconds, cancelling its timer for a new operation', () => {
    vi.useFakeTimers();
    mocks.notification = { ...running, status: 'success', message: 'The preview is ready.' };
    const { rerender } = render(<PreviewGenerationNotification />);
    act(() => vi.advanceTimersByTime(4999));
    expect(mocks.dismiss).not.toHaveBeenCalled();
    mocks.notification = { ...running, operationId: 'two' };
    rerender(<PreviewGenerationNotification />);
    act(() => vi.advanceTimersByTime(5000));
    expect(mocks.dismiss).not.toHaveBeenCalled();
    mocks.notification = { ...running, operationId: 'two', status: 'success' };
    rerender(<PreviewGenerationNotification />);
    act(() => vi.advanceTimersByTime(5000));
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });

  it('retains failure and recovery guidance until dismissed', () => {
    vi.useFakeTimers();
    mocks.notification = { ...running, status: 'error', message: 'Choose another ACD and try again.' };
    render(<PreviewGenerationNotification />);
    act(() => vi.advanceTimersByTime(60000));
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Choose another ACD');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss preview notification' }));
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });
});
