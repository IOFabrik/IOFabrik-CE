import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitHubAuthStatus } from './useGitHubAuthStatus';
import type { GitHubAuthStatus } from '../context/RepoContext.types';

const { AuthStatus, GetGHVersion, IsGHInstalled } = vi.hoisted(() => ({
  AuthStatus: vi.fn(), GetGHVersion: vi.fn(), IsGHInstalled: vi.fn(),
}));
vi.mock('../services/repo-queries', () => ({ AuthStatus, GetGHVersion, IsGHInstalled }));

const signedIn = { loggedIn: true, username: 'operator' };
const signedOut = { loggedIn: false, errorCode: 'auth_required' };
const offline = { loggedIn: false, errorCode: 'network_unavailable' };
const authStatus = AuthStatus;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountStatus() {
  const hook = renderHook(() => useGitHubAuthStatus());
  await act(async () => {});
  return hook;
}

function setOnline(online: boolean): void {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
}

describe('shared GitHub authentication status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    setOnline(true);
    IsGHInstalled.mockResolvedValue(true);
    GetGHVersion.mockResolvedValue('2.80.0');
    authStatus.mockResolvedValue(signedIn);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('checks on startup and every 10 seconds, detecting external logout and login', async () => {
    const { result } = await mountStatus();
    expect(result.current.ghAuthStatus).toMatchObject(signedIn);
    expect(result.current.ghVersion).toBe('2.80.0');
    authStatus.mockResolvedValue(signedOut);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(authStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.ghAuthStatus?.loggedIn).toBe(false);
    authStatus.mockResolvedValue(signedIn);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.ghAuthStatus?.loggedIn).toBe(true);
  });

  it('refreshes when the app regains focus or becomes visible', async () => {
    await mountStatus();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(authStatus).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(authStatus).toHaveBeenCalledTimes(3);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(authStatus).toHaveBeenCalledTimes(3);
  });

  it('keeps the last login while offline and rechecks on reconnection', async () => {
    const { result } = await mountStatus();
    authStatus.mockResolvedValue(offline);
    await act(async () => { await result.current.checkGitHubAuth(); });
    expect(result.current.isOffline).toBe(true);
    expect(result.current.ghAuthStatus).toMatchObject(signedIn);
    authStatus.mockResolvedValue(signedOut);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.isOffline).toBe(false);
    expect(result.current.ghAuthStatus?.loggedIn).toBe(false);
  });

  it('shows offline before any auth result and checks again when the network returns', async () => {
    setOnline(false);
    const { result } = await mountStatus();
    expect(result.current.isOffline).toBe(true);
    expect(result.current.ghAuthStatus).toBeNull();
    expect(IsGHInstalled).not.toHaveBeenCalled();
    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.isOffline).toBe(false);
    expect(result.current.ghAuthStatus?.loggedIn).toBe(true);
  });

  it('ignores an auth response that arrives after the browser goes offline', async () => {
    const pending = deferred<GitHubAuthStatus>();
    authStatus.mockReturnValue(pending.promise);
    const { result } = await mountStatus();
    setOnline(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    await act(async () => { pending.resolve(signedIn); });
    expect(result.current.isOffline).toBe(true);
    expect(result.current.ghAuthStatus).toBeNull();
    expect(result.current.isCheckingGhAuth).toBe(false);
  });

  it('does not show a login failure while the first offline check is unresolved', async () => {
    authStatus.mockResolvedValue(offline);
    const { result } = await mountStatus();
    expect(result.current.isOffline).toBe(true);
    expect(result.current.ghAuthStatus).toBeNull();
  });

  it('preserves the last known status on unknown or transport failures', async () => {
    const { result } = await mountStatus();
    authStatus.mockResolvedValue({ loggedIn: false, errorCode: 'rate_limited', error: 'Try again shortly.' });
    await act(async () => { await result.current.checkGitHubAuth(); });
    expect(result.current.ghAuthStatus).toMatchObject(signedIn);
    expect(result.current.isOffline).toBe(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authStatus.mockRejectedValue(new Error('bridge unavailable'));
    await act(async () => { await result.current.checkGitHubAuth(); });
    expect(result.current.ghAuthStatus).toMatchObject(signedIn);
    expect(result.current.isCheckingGhAuth).toBe(false);
  });

  it('does not overlap periodic or focus checks while a request is pending', async () => {
    const pending = deferred<GitHubAuthStatus>();
    authStatus.mockReturnValue(pending.promise);
    const { result } = await mountStatus();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(authStatus).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(signedIn); });
    expect(result.current.isCheckingGhAuth).toBe(false);
  });

  it('ignores an older poll when a fresh check after login completes first', async () => {
    const old = deferred<GitHubAuthStatus>();
    authStatus.mockReturnValueOnce(old.promise).mockResolvedValue(signedIn);
    const { result } = await mountStatus();
    await act(async () => { await result.current.checkGitHubAuth(); });
    await act(async () => { old.resolve(signedOut as GitHubAuthStatus); });
    expect(result.current.ghAuthStatus).toMatchObject(signedIn);
  });

  it('invalidates a pending signed-in result immediately after logout', async () => {
    const pending = deferred<GitHubAuthStatus>();
    authStatus.mockReturnValue(pending.promise);
    const { result } = await mountStatus();
    act(() => { result.current.resetGitHubAuth(); });
    await act(async () => { pending.resolve(signedIn); });
    expect(result.current.ghAuthStatus?.loggedIn).toBe(false);
  });

  it('handles missing supporting tools without attempting authentication', async () => {
    IsGHInstalled.mockResolvedValue(false);
    const { result } = await mountStatus();
    expect(authStatus).not.toHaveBeenCalled();
    expect(result.current.ghInstalled).toBe(false);
    expect(result.current.ghAuthStatus).toBeNull();
  });

  it('removes listeners and polling when the provider unmounts', async () => {
    const { unmount } = await mountStatus();
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(authStatus).toHaveBeenCalledTimes(1);
  });
});
