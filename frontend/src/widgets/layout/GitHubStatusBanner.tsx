import { memo, useCallback, useMemo } from 'react';
import { Github, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { useRepo } from '../../context';
import { ICON_SIZES } from '../../shared/constants';
import { Button } from '../../shared/ui/button';
import GitHubDeviceFlowModal from '../../features/auth/components/GitHubDeviceFlowModal';
import { useGitHubDeviceFlow } from '../../features/auth/hooks/useGitHubDeviceFlow';

function GitHubStatusBanner(): JSX.Element {
  const { ghAuthStatus, ghInstalled, isOffline } = useRepo();
  const onStartError = useCallback((message: string): void => { toast.error(message); }, []);
  const flowOptions = useMemo(() => ({ onStartError }), [onStartError]);
  const { deviceFlow, isStarting, startDeviceFlow, closeDeviceFlow, handleDeviceFlowOpenChange } = useGitHubDeviceFlow(flowOptions);
  const handleAuthenticate = useCallback((): void => { void startDeviceFlow(); }, [startDeviceFlow]);
  const needsAuthentication = ghInstalled && ghAuthStatus?.loggedIn === false;
  const message = isOffline
    ? "You're offline. Changes will be saved locally."
    : 'GitHub authentication required.';

  return (
    <>
      {(isOffline || needsAuthentication) && (
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-10 shrink-0 items-center justify-center gap-3 border-t border-amber-600 bg-amber-400 px-4 py-1.5 text-sm font-medium text-amber-950"
        >
          {isOffline
            ? <WifiOff size={ICON_SIZES.sm} className="shrink-0" aria-hidden="true" />
            : <Github size={ICON_SIZES.sm} className="shrink-0" aria-hidden="true" />}
          <span className="truncate" title={message}>{message}</span>
          {!isOffline && (
            <Button
              size="sm"
              className="shrink-0 bg-amber-950 text-amber-50 hover:bg-amber-900 focus-visible:ring-amber-950"
              onClick={handleAuthenticate}
              loading={isStarting}
              disabled={isStarting || deviceFlow.isOpen}
            >
              Authenticate with GitHub
            </Button>
          )}
        </div>
      )}
      <GitHubDeviceFlowModal
        open={deviceFlow.isOpen}
        userCode={deviceFlow.userCode}
        verificationUrl={deviceFlow.verificationUrl}
        onComplete={closeDeviceFlow}
        onOpenChange={handleDeviceFlowOpenChange}
      />
    </>
  );
}

export default memo(GitHubStatusBanner);
