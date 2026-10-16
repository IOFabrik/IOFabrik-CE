/**
 * ProjectSetupBanner - State-aware banner shown in the main area when a project
 * needs setup (version control, remote publishing, etc.).
 *
 * Renders a status banner + single action row with context-aware CTAs.
 * Replaces any step-based language with state-driven messaging per Phase 12.
 *
 * Project states:
 * 1. Empty Folder, Not Tracked — "Enable Version Control"
 * 2. Has Files, Not Tracked — "Enable Version Control"
 * 3. Tracked, No Remote — "Publish to GitHub"
 * 4. Tracked + Remote — no banner (fully set up)
 * 5. Just Created — success banner (auto-dismisses)
 */
import { memo, useState, useCallback, useEffect } from 'react';
import {
  FolderOpen,
  GitBranch,
  CloudUpload,
  CheckCircle2,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import {
  PROJECT_STATES,
  PROJECT_STATE_CONFIGS,
  ICON_SIZES,
  type ProjectState,
} from '../../../shared/constants';
import { Button } from '../../../shared/ui';
import { cn } from '../../../shared/utils/misc';
import type { GitHubAuthStatus, GitHubOrganizationsResult } from '../../../context';
import PublishToCloudModal from '../../welcome/components/PublishToCloudModal';

// ============================================================================
// Types
// ============================================================================

interface ProjectSetupBannerProps {
  /** Derived project state */
  projectState: ProjectState;
  /** Folder name for display */
  folderName: string;
  /** Number of files in folder (for untracked states) */
  fileCount?: number;
  /** Callback to enable version control (git init + initial commit) */
  onEnableVersionControl?: () => Promise<boolean>;
  /** Callback to publish to GitHub */
  onPublishToGitHub?: (name: string, isPrivate: boolean, owner: string) => Promise<void>;
  /** Callback to start GitHub auth flow */
  onConnectGitHub?: () => void;
  /** Callback to load GitHub organizations */
  onLoadOrganizations?: () => Promise<GitHubOrganizationsResult>;
  /** Whether tracking/init is in progress */
  isLoading?: boolean;
  operationInProgress?: boolean;
  /** Whether publishing is in progress */
  isPublishing?: boolean;
  /** GitHub CLI installed? */
  ghInstalled?: boolean;
  /** GitHub auth status */
  ghAuthStatus?: GitHubAuthStatus | null;
  /** Git installed and available */
  gitInstalled?: boolean;
  /** Git LFS installed and available */
  lfsInstalled?: boolean;
  /** Package installation state */
  isInstallingPackages?: boolean;
  /** Callback to install required packages */
  onInstallRequiredPackages?: () => Promise<boolean>;
  /** Repo path (for deriving default repo name) */
  repoPath?: string;
}

// ============================================================================
// Icon/color configs per state
// ============================================================================

interface StateVisual {
  Icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  borderColor: string;
}

const STATE_VISUALS: Record<ProjectState, StateVisual> = {
  [PROJECT_STATES.EMPTY_UNTRACKED]: {
    Icon: FolderOpen,
    iconBg: 'bg-yellow-500/10',
    iconColor: 'text-yellow-400',
    borderColor: 'border-yellow-500/30',
  },
  [PROJECT_STATES.HAS_FILES_UNTRACKED]: {
    Icon: FolderOpen,
    iconBg: 'bg-yellow-500/10',
    iconColor: 'text-yellow-400',
    borderColor: 'border-yellow-500/30',
  },
  [PROJECT_STATES.TRACKED_NO_REMOTE]: {
    Icon: CloudUpload,
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
    borderColor: 'border-transparent',
  },
  [PROJECT_STATES.TRACKED_WITH_REMOTE]: {
    Icon: CheckCircle2,
    iconBg: 'bg-green-500/10',
    iconColor: 'text-green-400',
    borderColor: 'border-green-500/30',
  },
  [PROJECT_STATES.JUST_CREATED]: {
    Icon: CheckCircle2,
    iconBg: 'bg-green-500/10',
    iconColor: 'text-green-400',
    borderColor: 'border-green-500/30',
  },
  [PROJECT_STATES.NESTED_REPO]: {
    Icon: AlertTriangle,
    iconBg: 'bg-orange-500/10',
    iconColor: 'text-orange-400',
    borderColor: 'border-orange-500/30',
  },
};

// ============================================================================
// Component
// ============================================================================

function ProjectSetupBanner({
  projectState,
  fileCount,
  onEnableVersionControl,
  onPublishToGitHub,
  onConnectGitHub,
  onLoadOrganizations,
  isLoading = false,
  operationInProgress = false,
  isPublishing = false,
  ghInstalled = false,
  ghAuthStatus,
  gitInstalled = true,
  lfsInstalled = true,
  isInstallingPackages = false,
  onInstallRequiredPackages,
  repoPath,
}: ProjectSetupBannerProps): JSX.Element | null {
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Auto-dismiss "just created" banner after 8 seconds
  useEffect(() => {
    if (projectState === PROJECT_STATES.JUST_CREATED) {
      const timer = setTimeout(() => setDismissed(true), 8000);
      return () => clearTimeout(timer);
    }
    setDismissed(false);
  }, [projectState]);

  const handleEnableVC = useCallback(async () => {
    const needsPackages = !gitInstalled || !lfsInstalled;

    if (needsPackages && onInstallRequiredPackages) {
      await onInstallRequiredPackages();
      return;
    }

    if (onEnableVersionControl) {
      const success = await onEnableVersionControl();
      if (success) {
        setIsPublishModalOpen(false);
      }
    }
  }, [gitInstalled, lfsInstalled, onInstallRequiredPackages, onEnableVersionControl]);

  // Don't render for fully set up projects, nested repos, or dismissed banners
  if (projectState === PROJECT_STATES.TRACKED_WITH_REMOTE || projectState === PROJECT_STATES.NESTED_REPO || dismissed) {
    return null;
  }

  const config = PROJECT_STATE_CONFIGS[projectState];
  const visual = STATE_VISUALS[projectState];
  const { Icon, iconBg, iconColor, borderColor } = visual;

  // Build subtitle with context
  let subtitle = config.subtitle;
  if (projectState === PROJECT_STATES.HAS_FILES_UNTRACKED && fileCount != null) {
    subtitle = `${fileCount} file${fileCount !== 1 ? 's' : ''} found but not tracked by Git. Enable version control?`;
  }

  const isUntrackedState =
    projectState === PROJECT_STATES.EMPTY_UNTRACKED ||
    projectState === PROJECT_STATES.HAS_FILES_UNTRACKED;

  const isPublishState = projectState === PROJECT_STATES.TRACKED_NO_REMOTE;
  const showSubtitle = !isPublishState;
  const needsTrackingPackages = !gitInstalled || !lfsInstalled;

  let untrackedActionLabel = config.actionLabel;
  if (needsTrackingPackages) {
    if (!gitInstalled && !lfsInstalled) {
      untrackedActionLabel = 'Check supporting tools';
    } else if (!gitInstalled) {
      untrackedActionLabel = 'Check supporting tools';
    } else {
      untrackedActionLabel = 'Check supporting tools';
    }
  }

  return (
    <div
      className={cn(
        'mx-4 mt-3 rounded-lg border bg-theme-elevated/50 overflow-hidden transition-all',
        borderColor
      )}
    >
      {/* Banner header row */}
      <div className={cn('flex items-center gap-3 px-4', isPublishState ? 'py-2' : 'py-3')}>
        <div className={cn('flex items-center justify-center w-8 h-8 rounded-full shrink-0', iconBg)}>
          <Icon size={ICON_SIZES.sm} className={iconColor} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-theme-primary text-sm font-medium">{config.title}</p>
          {showSubtitle && <p className="text-theme-muted text-xs truncate">{subtitle}</p>}
        </div>

        {/* Primary CTA (compact, in the header row) */}
        {isUntrackedState && (
          <Button size="sm" disabled={operationInProgress} onClick={handleEnableVC} loading={isLoading || isInstallingPackages}>
            <GitBranch size={ICON_SIZES.xs} />
            {isInstallingPackages ? 'Checking Tools...' : untrackedActionLabel}
          </Button>
        )}

        {isPublishState && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setIsPublishModalOpen(true)}
              disabled={operationInProgress}
              variant="secondary"
            >
              <CloudUpload size={ICON_SIZES.xs} />
              Publish to Cloud
            </Button>
          </div>
        )}

        {projectState === PROJECT_STATES.JUST_CREATED && (
          <button
            onClick={() => setDismissed(true)}
            className="text-theme-muted hover:text-theme-secondary text-xs px-2"
          >
            Dismiss
          </button>
        )}
      </div>

      {isPublishState && (
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
      )}
    </div>
  );
}

export default memo(ProjectSetupBanner);
