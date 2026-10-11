import { useEffect, useRef, type ReactNode } from 'react';
import { initAnalytics, trackAppLaunched, trackAppClosed } from '../../domain/analytics/analytics';
import { readMigratedStorage } from '../../shared/utils/migratedStorage';

const REPO_OPEN_SUCCESS_EVENT = 'iofabrik:repo-open-success';

const isFirstLaunch = !readMigratedStorage('iofabrik_has_launched', 'cz_has_launched');
if (isFirstLaunch) {
  localStorage.setItem('iofabrik_has_launched', 'true');
}

function getPlatform(): string {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('win')) return 'windows';
  if (userAgent.includes('mac')) return 'macos';
  if (userAgent.includes('linux')) return 'linux';
  return 'unknown';
}

interface AnalyticsProviderProps {
  children: ReactNode;
}

export default function AnalyticsProvider({ children }: AnalyticsProviderProps): JSX.Element {
  const appStartTime = useRef<number>(Date.now());
  const reposOpened = useRef<number>(0);

  useEffect(() => {
    initAnalytics();

    trackAppLaunched({
      platform: getPlatform(),
      isFirstLaunch,
    });

    const handleBeforeUnload = () => {
      const sessionDuration = Math.round((Date.now() - appStartTime.current) / 1000);
      trackAppClosed({
        sessionDurationSeconds: sessionDuration,
        reposOpened: reposOpened.current,
      });
    };

    const handleRepoOpenSuccess = () => {
      reposOpened.current += 1;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener(REPO_OPEN_SUCCESS_EVENT, handleRepoOpenSuccess);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener(REPO_OPEN_SUCCESS_EVENT, handleRepoOpenSuccess);
    };
  }, []);

  return <>{children}</>;
}
