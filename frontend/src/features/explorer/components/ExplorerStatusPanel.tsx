/**
 * ExplorerStatusPanel - Unified status panel for explorer sidebar.
 * 
 * Consolidates: SidebarNoRepoPanel, SidebarSyncedPanel, SidebarPushPanel, SidebarMergePanel
 * into a single component with consistent visual structure.
 * 
 * Visual structure:
 * - Icon in colored circle
 * - Title
 * - Subtitle
 * - Optional action button
 */
import { memo, useState, useCallback, type CSSProperties, type ReactNode } from 'react';
import { 
  AlertTriangle, 
  CheckCircle2, 
  GitBranch,
  Merge,
  CloudUpload,
  CloudCheck,
  Cloud,
  Upload,
  Github,
  GitPullRequest,
  type LucideIcon,
} from 'lucide-react';
import { ICON_STYLES } from '../../../shared/utils/gitHelpers';
import { getFolderNameFromPath } from '../../../shared/utils/path';
import { MAIN_BRANCHES } from '../../../shared/constants';
import { 
  Button, 
} from '../../../shared/ui';
import PublishToCloudModal from '../../welcome/components/PublishToCloudModal';
import type { GitHubAuthStatus, GitHubOrganizationsResult } from '../../../context';

// ============================================================================
// Types
// ============================================================================

type StatusType = 'noRepo' | 'synced' | 'push' | 'featureBranch';

interface PanelConfig {
  Icon: LucideIcon;
  iconBg: string;
  iconColor: string;
}

interface PanelLayoutProps {
  type: StatusType;
  title: string;
  subtitle: ReactNode;
  children?: ReactNode;
}

interface ExplorerStatusPanelProps {
  status: StatusType;
  folderName?: string;
  branchName?: string;
  repoPath?: string;
  ahead?: number;
  hasUpstream?: boolean;
  hasRemote?: boolean;
  totalLocalCommits?: number;
  /** The opted-in update for this feature branch, when one is active. */
  review?: { state: string; message: string; error?: string; conflictCount: number };
  /** True when Developer Mode uses the explicit Save Changes update workflow. */
  updateWorkflowEnabled?: boolean;
  isUpdateBusy?: boolean;
  onInitialize?: () => void;
  onInstallRequiredPackages?: () => Promise<boolean>;
  onSync?: () => void;
  onConnectGitHub?: () => void;
  onPublishToGitHub?: (name: string, isPrivate: boolean, owner: string) => Promise<void>;
  onOpenCombineChanges?: () => void;
  onRetryUpdate?: () => void;
  onCreateChangeRequest?: () => void;
  /** True when the current synced feature branch may open a Change Request. */
  canCreateChangeRequest?: boolean;
  /** Reason Create Change Request is unavailable, shown on the disabled button. */
  changeRequestDisabledReason?: string;
  /** True while eligibility is still being determined. */
  isCheckingChangeRequestEligibility?: boolean;
  /** True while resolving whether a request already exists for the branch. */
  isResolvingChangeRequest?: boolean;
  onLoadOrganizations?: () => Promise<GitHubOrganizationsResult>;
  isLoading?: boolean;
  isSyncing?: boolean;
  isPublishing?: boolean;
  /** True when any mutating git operation is running anywhere in the app */
  operationInProgress?: boolean;
  ghInstalled?: boolean;
  gitInstalled?: boolean;
  lfsInstalled?: boolean;
  isInstallingPackages?: boolean;
  ghAuthStatus?: GitHubAuthStatus | null;
}

// ============================================================================
// Configuration
// ============================================================================

// Panel type configurations
const PANEL_CONFIGS: Record<StatusType, PanelConfig> = {
  noRepo: {
    Icon: AlertTriangle,
    iconBg: 'bg-yellow-500/10',
    iconColor: 'text-yellow-500',
  },
  synced: {
    Icon: CheckCircle2,
    iconBg: 'bg-green-500/10',
    iconColor: 'text-green-400',
  },
  push: {
    Icon: CloudUpload,
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
  },
  featureBranch: {
    Icon: CloudCheck,
    iconBg: 'bg-green-500/10',
    iconColor: 'text-green-400',
  },
};

// ============================================================================
// Components
// ============================================================================

/**
 * Base panel layout - shared visual structure for all status types
 */
function PanelLayout({ type, title, subtitle, children }: PanelLayoutProps): JSX.Element {
  const config = PANEL_CONFIGS[type];
  const { Icon, iconBg, iconColor } = config;

  return (
    <div className="p-4 text-center">
      <div className={`inline-flex items-center justify-center w-12 h-12 rounded-full ${iconBg} mb-3`}>
        <Icon style={ICON_STYLES.lg as CSSProperties} className={iconColor} />
      </div>
      <p className="text-theme-primary text-sm font-medium mb-1">{title}</p>
      <p className="text-theme-muted text-xs mb-4">{subtitle}</p>
      {children}
    </div>
  );
}

/**
 * ExplorerStatusPanel - Renders the appropriate status panel based on repo state.
 */
function ExplorerStatusPanel({
  status,
  folderName,
  branchName,
  repoPath,
  ahead = 0,
  hasUpstream = true,
  hasRemote = true,
  totalLocalCommits = 0,
  review,
  updateWorkflowEnabled = false,
  isUpdateBusy = false,
  onInitialize,
  onInstallRequiredPackages,
  onSync,
  onConnectGitHub,
  onPublishToGitHub,
  onOpenCombineChanges,
  onRetryUpdate,
  onCreateChangeRequest,
  canCreateChangeRequest = false,
  changeRequestDisabledReason,
  isCheckingChangeRequestEligibility = false,
  isResolvingChangeRequest = false,
  onLoadOrganizations,
  isLoading = false,
  isSyncing = false,
  isPublishing = false,
  operationInProgress = false,
  ghInstalled = false,
  gitInstalled = true,
  lfsInstalled = true,
  isInstallingPackages = false,
  ghAuthStatus = null,
}: ExplorerStatusPanelProps): JSX.Element {
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const needsTrackingPackages = !gitInstalled || !lfsInstalled;
  const canShowMergeAction = Boolean(branchName && !MAIN_BRANCHES.includes(branchName.toLowerCase()));

  const trackingButtonLabel = needsTrackingPackages
    ? 'Check supporting tools'
    : 'Start Tracking';

  const handleNoRepoAction = useCallback((): void => {
    if (needsTrackingPackages) {
      void onInstallRequiredPackages?.();
      return;
    }

    onInitialize?.();
  }, [needsTrackingPackages, onInstallRequiredPackages, onInitialize]);

  const handleOpenCombineChanges = useCallback((): void => {
    onOpenCombineChanges?.();
  }, [onOpenCombineChanges]);

  switch (status) {
    case 'noRepo':
      return (
        <PanelLayout
          type="noRepo"
          title="No Version Control"
          subtitle={<><span className="font-medium">{folderName}</span> is not tracked</>}
        >
          <Button 
            onClick={handleNoRepoAction}
            loading={isLoading || isInstallingPackages}
            disabled={operationInProgress}
            size="sm"
            className="w-full"
          >
            <GitBranch style={ICON_STYLES.sm as CSSProperties} />
            {isInstallingPackages ? 'Checking Tools...' : trackingButtonLabel}
          </Button>
        </PanelLayout>
      );

    case 'push': {
      const pendingCount = hasUpstream ? ahead : totalLocalCommits;
      
      // Case 1: Remote exists - show Push Changes / Sync button
      if (hasRemote) {
        return (
          <PanelLayout
            type="push"
            title={`${pendingCount} snapshot${pendingCount !== 1 ? 's' : ''} pending`}
            subtitle={hasUpstream ? 'Ready to sync' : 'Branch not published'}
          >
            <Button 
              onClick={onSync} 
              loading={isSyncing} 
              disabled={operationInProgress && !isSyncing}
              size="sm"
              className="w-full"
            >
              {hasUpstream ? (
                <Cloud style={ICON_STYLES.sm as CSSProperties} />
              ) : (
                <Upload style={ICON_STYLES.sm as CSSProperties} />
              )}
              {hasUpstream ? 'Push Changes' : 'Push Changes'}
            </Button>
          </PanelLayout>
        );
      }
      
      // Case 2: No remote + feature branch - prioritize merge flow
      if (canShowMergeAction && !updateWorkflowEnabled) {
        return (
          <PanelLayout
            type="featureBranch"
            title="Branch synced"
            subtitle={<><span>{branchName}</span> is up to date</>}
          >
            <Button
              onClick={handleOpenCombineChanges}
              disabled={operationInProgress}
              size="sm"
              className="w-full"
            >
              <Merge style={ICON_STYLES.sm as CSSProperties} />
              I am ready to merge
            </Button>
            <p className="text-theme-muted text-xs mt-2">
              Local only: publish later when you want backup or sharing.
            </p>
          </PanelLayout>
        );
      }

      // Case 3: No remote - show simple publish guidance + modal flow (same as setup banner)
      return (
        <>
          <div className="p-4 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-500/10 mb-3">
              <Github style={ICON_STYLES.lg as CSSProperties} className="text-blue-400" />
            </div>
            <p className="text-theme-primary text-sm font-medium mb-1">Ready to choose where to keep your work?</p>
            <p className="text-theme-muted text-xs mb-3">
              This branch has {pendingCount} snapshot{pendingCount !== 1 ? 's' : ''} saved on this computer only.
            </p>
            <div className="text-left rounded-lg border border-theme-default bg-theme-surface p-3 mb-4">
              <p className="text-theme-primary text-xs font-medium mb-1">Your options:</p>
              <p className="text-theme-muted text-xs mb-2">
                <span className="text-theme-primary font-medium">Option 1:</span> Publish to a cloud repository host (e.g.,GitHub) for backup and sharing.
              </p>
              <p className="text-theme-muted text-xs">
                <span className="text-theme-primary font-medium">Option 2:</span> Keep working locally on this computer. You can publish later with full change history.
              </p>
            </div>
            <Button 
              onClick={() => setIsPublishModalOpen(true)}
              disabled={operationInProgress}
              size="sm"
              variant="secondary"
              className="w-full"
            >
              <CloudUpload style={ICON_STYLES.sm as CSSProperties} />
              Publish to Cloud
            </Button>
            <p className="text-theme-muted text-xs mt-2">
              Share your progress with the team.
            </p>
          </div>

          <PublishToCloudModal
            open={isPublishModalOpen}
            onOpenChange={setIsPublishModalOpen}
            onPublishToGitHub={onPublishToGitHub}
            onConnectGitHub={onConnectGitHub}
            onLoadOrganizations={onLoadOrganizations}
            isPublishing={isPublishing}
            ghInstalled={ghInstalled}
            onInstallRequiredPackages={onInstallRequiredPackages}
            isInstallingPackages={isInstallingPackages}
            ghAuthStatus={ghAuthStatus}
            repoPath={repoPath}
          />
        </>
      );
    }

    case 'featureBranch': {
      const isChecking = review
        ? ['scheduled', 'fetching', 'starting', 'committing', 'sharing', 'cancelling'].includes(review.state)
        : false;
      const isUpdated = review?.state === 'updated';
      const needsDecisions = review?.state === 'needs-decisions';
      const isBlocked = review?.state === 'blocked';
      const isFailed = review?.state === 'failed';

      const title = isUpdated
        ? 'Your work is up to date'
        : needsDecisions
          ? 'Some files need a decision'
          : isBlocked || isFailed
            ? 'Update needs attention'
            : isChecking
              ? review?.state === 'sharing' ? 'Sharing updated work' : 'Checking for shared updates'
              : 'Branch synced';

      const actionLabel = isUpdated
        ? 'Share updated work'
        : needsDecisions
          ? 'Open Conflict Review'
          : isBlocked
            ? 'Check again'
            : isFailed
              ? 'Review update'
            : isChecking
              ? 'Working...'
              : 'I am ready to merge';

      const showUpdateAction = Boolean(review) || !updateWorkflowEnabled;
      const handleAction = isBlocked ? onRetryUpdate : handleOpenCombineChanges;

      return (
        <PanelLayout
          type="featureBranch"
          title={title}
          subtitle={<><span>{branchName}</span> is up to date</>}
        >
          {review && (
            <p className={`text-xs mb-3 text-left ${review.error ? 'text-red-400' : 'text-theme-muted'}`}>
              {review.error || review.message}
            </p>
          )}
          {showUpdateAction && (
            <Button
              onClick={handleAction}
              disabled={operationInProgress || isChecking || isUpdateBusy}
              loading={isChecking || isUpdateBusy}
              size="sm"
              variant="secondary"
              className="w-full"
            >
              <Merge style={ICON_STYLES.sm as CSSProperties} />
              {actionLabel}
            </Button>
          )}
          {onCreateChangeRequest && (
            <span
              className="mt-2 block"
              title={!canCreateChangeRequest ? changeRequestDisabledReason : undefined}
            >
              <Button
                onClick={onCreateChangeRequest}
                disabled={operationInProgress || !canCreateChangeRequest || isCheckingChangeRequestEligibility}
                loading={isResolvingChangeRequest}
                size="sm"
                className="w-full"
              >
                <GitPullRequest style={ICON_STYLES.sm as CSSProperties} />
                Create Change Request
              </Button>
            </span>
          )}
        </PanelLayout>
      );
    }

    case 'synced':
    default: {
      const displayName = repoPath ? getFolderNameFromPath(repoPath) : 'Repository';
      return (
        <PanelLayout
          type="synced"
          title="All caught up"
          subtitle={<>No changes in <span className="font-medium">{displayName}</span></>}
        />
      );
    }
  }
}

export default memo(ExplorerStatusPanel);
