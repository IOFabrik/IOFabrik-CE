import { useEffect } from 'react';
import { useAuth } from '../context';
import { AppLayout } from '../widgets/layout';
import Spinner from '../shared/ui/Spinner';
import { useLoginTheme } from '../shared/hooks/useLoginTheme';
import { AnalyticsProvider, AuthProvider, RepoProvider } from './providers';
import { ConflictQueueProvider } from '../features/conflict';
import { IntegrationSessionProvider } from '../features/integration';
import { LayoutProvider } from '../context';

function App(): JSX.Element {
  return (
    <AuthProvider>
      <AnalyticsProvider>
        <AuthGate />
      </AnalyticsProvider>
    </AuthProvider>
  );
}

export default App;

function AuthGate(): JSX.Element {
  const { isLoading } = useAuth();

  // Apply theme before LayoutProvider is available (pre-auth screens)
  useLoginTheme();

  useEffect(() => {
    if (isLoading) {
      return;
    }

    document.documentElement.dataset.czAppReady = 'true';
    window.dispatchEvent(new CustomEvent('iofabrik:app-shell-ready'));
  }, [isLoading]);

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-theme-base text-theme-primary">
        <div className="flex items-center gap-2 text-sm text-theme-muted">
          <Spinner size={16} />
          <span>Loading session…</span>
        </div>
      </div>
    );
  }

  // LayoutProvider sits above the conflict providers because the queue reads
  // Developer Mode from it to choose its source.
  return (
    <RepoProvider>
      <LayoutProvider>
        <IntegrationSessionProvider>
          <ConflictQueueProvider>
            <AppLayout />
          </ConflictQueueProvider>
        </IntegrationSessionProvider>
      </LayoutProvider>
    </RepoProvider>
  );
}
