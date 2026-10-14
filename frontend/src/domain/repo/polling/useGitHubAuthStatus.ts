import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthStatus, GetGHVersion, IsGHInstalled } from '../services/repo-queries';
import type { GitHubAuthStatus } from '../context/RepoContext.types';

const AUTH_CHECK_INTERVAL_MS = 60_000;

/** Shared GitHub state for the app, including external login/logout and connectivity. */
export function useGitHubAuthStatus() {
  const [ghInstalled, setGhInstalled] = useState(false);
  const [ghVersion, setGhVersion] = useState('');
  const [ghAuthStatus, setGhAuthStatus] = useState<GitHubAuthStatus | null>(null);
  const [isCheckingGhAuth, setIsCheckingGhAuth] = useState(false);
  const [isOffline, setIsOffline] = useState(() => navigator.onLine === false);
  const requestRef = useRef(0);
  const checkingRef = useRef(false);

  const checkGitHubAuth = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    if (navigator.onLine === false) {
      checkingRef.current = false;
      setIsCheckingGhAuth(false);
      setIsOffline(true);
      return;
    }

    checkingRef.current = true;
    setIsCheckingGhAuth(true);
    try {
      const installed = await IsGHInstalled();
      if (request !== requestRef.current) return;
      setGhInstalled(installed);
      if (!installed) {
        setGhVersion('');
        setGhAuthStatus(null);
        setIsOffline(false);
        return;
      }

      const [version, status] = await Promise.all([GetGHVersion(), AuthStatus()]);
      if (request !== requestRef.current) return;
      setGhVersion(version);
      if (status?.errorCode === 'network_unavailable') {
        setIsOffline(true);
      } else if (status && (
        status.loggedIn || status.errorCode === 'auth_required' || (!status.errorCode && !status.error)
      )) {
        setGhAuthStatus(status as GitHubAuthStatus);
        setIsOffline(false);
      }
      // Unknown failures leave the last confirmed login and connectivity intact.
    } catch (error) {
      console.error('Failed to check GitHub status:', error);
    } finally {
      if (request === requestRef.current) {
        checkingRef.current = false;
        setIsCheckingGhAuth(false);
      }
    }
  }, []);

  const resetGitHubAuth = useCallback((): void => {
    // A status request started before logout must not restore the previous account.
    requestRef.current += 1;
    checkingRef.current = false;
    setIsCheckingGhAuth(false);
    setGhAuthStatus({ loggedIn: false, errorCode: 'auth_required' });
  }, []);

  useEffect(() => {
    const refresh = (): void => {
      if (!checkingRef.current) void checkGitHubAuth();
    };
    const handleOffline = (): void => {
      requestRef.current += 1;
      checkingRef.current = false;
      setIsCheckingGhAuth(false);
      setIsOffline(true);
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();
    const interval = window.setInterval(refresh, AUTH_CHECK_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      requestRef.current += 1;
      checkingRef.current = false;
    };
  }, [checkGitHubAuth]);

  return {
    ghInstalled, setGhInstalled, ghVersion, ghAuthStatus, isCheckingGhAuth,
    isOffline, checkGitHubAuth, resetGitHubAuth,
  };
}
