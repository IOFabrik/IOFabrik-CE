import { memo, useCallback, useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  AlertCircle,
  Check,
  Github,
  Loader2,
  LogOut,
} from 'lucide-react';
import { useRepo } from '../../../context';
import { ICON_SIZES } from '../../../shared/constants';
import BitbucketIcon from '../../../shared/icons/BitbucketIcon';
import GiteaIcon from '../../../shared/icons/GiteaIcon';
import GitLabIcon from '../../../shared/icons/GitLabIcon';
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui';
import GitHubDeviceFlowModal from '../../auth/components/GitHubDeviceFlowModal';
import { useGitHubDeviceFlow } from '../../auth/hooks/useGitHubDeviceFlow';

interface IntegrationRow {
  id: string;
  name: string;
  icon: ReactNode;
}

const UNAVAILABLE_INTEGRATIONS: IntegrationRow[] = [
  {
    id: 'gitlab',
    name: 'GitLab',
    icon: <GitLabIcon className="text-theme-secondary" style={{ width: ICON_SIZES.md, height: ICON_SIZES.md }} />,
  },
  {
    id: 'gitea',
    name: 'Gitea',
    icon: <GiteaIcon className="text-theme-secondary" style={{ width: ICON_SIZES.md, height: ICON_SIZES.md }} />,
  },
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    icon: <BitbucketIcon className="text-theme-secondary" style={{ width: ICON_SIZES.md, height: ICON_SIZES.md }} />,
  },
];

function IntegrationsSettings(): JSX.Element {
  const {
    ghInstalled,
    ghAuthStatus,
    installRequiredPackages,
    isCheckingGhAuth,
    isInstallingPackages,
    logoutGitHub,
  } = useRepo();
  const [error, setError] = useState<string | null>(null);
  const [isDisconnectingGitHub, setIsDisconnectingGitHub] = useState(false);
  const {
    deviceFlow,
    isStarting,
    startDeviceFlow,
    closeDeviceFlow,
    handleDeviceFlowOpenChange,
  } = useGitHubDeviceFlow({ onStartError: setError });

  const handleGitHubConnect = useCallback(async (): Promise<void> => {
    setError(null);
    await startDeviceFlow();
  }, [startDeviceFlow]);

  const handleGitHubDisconnect = useCallback(async (): Promise<void> => {
    setError(null);
    setIsDisconnectingGitHub(true);
    try {
      const result = await logoutGitHub();
      if (!result.success) {
        setError(result.error || 'Logout failed');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsDisconnectingGitHub(false);
    }
  }, [logoutGitHub]);

  const githubStatus = useMemo((): JSX.Element => {
    if (!ghInstalled) {
      return (
        <Badge variant="outline" className="border-amber-500/40 text-amber-400">
          GitHub CLI required
        </Badge>
      );
    }

    if (isCheckingGhAuth) {
      return (
        <span className="inline-flex items-center gap-2 text-sm text-theme-muted">
          <Loader2 size={ICON_SIZES.xs} className="animate-spin" />
          Checking connection
        </span>
      );
    }

    if (ghAuthStatus?.loggedIn) {
      return (
        <Badge variant="outline" className="w-fit border-green-500/40 text-green-400">
          Connected
        </Badge>
      );
    }

    return (
      <Badge variant="outline" className="w-fit border-theme-default text-theme-muted">
        Not connected
      </Badge>
    );
  }, [ghAuthStatus, ghInstalled, isCheckingGhAuth]);

  const githubAction = useMemo((): JSX.Element => {
    if (!ghInstalled) {
      return (
        <Button
          variant="secondary"
          size="sm"
          onClick={installRequiredPackages}
          loading={isInstallingPackages}
          disabled={isInstallingPackages}
        >
          <Github style={{ width: ICON_SIZES.sm, height: ICON_SIZES.sm }} />
          <span>{isInstallingPackages ? 'Checking...' : 'Check supporting tools'}</span>
        </Button>
      );
    }

    if (ghAuthStatus?.loggedIn) {
      return (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleGitHubDisconnect}
          disabled={isDisconnectingGitHub}
        >
          {isDisconnectingGitHub ? (
            <Loader2 size={ICON_SIZES.xs} className="animate-spin" />
          ) : (
            <LogOut style={{ width: ICON_SIZES.sm, height: ICON_SIZES.sm }} />
          )}
          <span>{isDisconnectingGitHub ? 'Disconnecting...' : 'Disconnect'}</span>
        </Button>
      );
    }

    return (
      <Button variant="secondary" size="sm" onClick={handleGitHubConnect} disabled={isStarting} loading={isStarting}>
        <Github style={{ width: ICON_SIZES.sm, height: ICON_SIZES.sm }} />
        <span>{isStarting ? 'Connecting...' : 'Connect'}</span>
      </Button>
    );
  }, [ghAuthStatus, ghInstalled, handleGitHubConnect, handleGitHubDisconnect, installRequiredPackages, isDisconnectingGitHub, isInstallingPackages, isStarting]);

  const integrations = useMemo<IntegrationRow[]>(() => ([
    {
      id: 'github',
      name: 'GitHub',
      icon: <Github size={ICON_SIZES.md} className="text-theme-secondary" />,
    },
    ...UNAVAILABLE_INTEGRATIONS,
  ]), []);

  return (
    <>
      <div className="rounded-lg border border-theme-default bg-theme-surface">
        <div className="border-b border-theme-default px-6 py-5">
          <h3 className="text-base font-medium text-theme-primary">Remote integrations</h3>
          <p className="mt-1 text-sm text-theme-muted">
            Connect external hosting providers separately from your IOFabrik account.
          </p>
        </div>

        {error && (
          <div className="border-b border-theme-default bg-red-500/10 px-6 py-4">
            <div className="flex items-center gap-3 text-red-400">
              <AlertCircle size={ICON_SIZES.md} className="shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          </div>
        )}

        <div className="px-6 py-5">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[42%]">Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {integrations.map((integration) => {
                const isGitHub = integration.id === 'github';

                return (
                  <TableRow key={integration.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="rounded-md border border-theme-default bg-theme-base/40 p-2">
                          {integration.icon}
                        </div>
                        <span className="font-medium text-theme-primary">{integration.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {isGitHub ? (
                        githubStatus
                      ) : (
                        <Badge variant="outline" className="border-theme-default text-theme-muted">
                          Unavailable
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        {isGitHub ? (
                          githubAction
                        ) : (
                          <Button variant="secondary" size="sm" disabled>
                            <span>Unavailable</span>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-theme-default bg-theme-surface px-6 py-4">
        <div className="flex items-start gap-3">
          <Check size={ICON_SIZES.md} className="mt-0.5 shrink-0 text-green-400" />
          <div>
            <h4 className="text-sm font-medium text-theme-primary">Local work stays separate</h4>
            <p className="mt-1 text-sm text-theme-muted">
              These integrations only affect remote hosting access. Local history, saves, and repository settings continue to work without them.
            </p>
          </div>
        </div>
      </div>

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

export default memo(IntegrationsSettings);
