/**
 * RecoveryBanner - Warning banner shown when repository is in an interrupted state.
 * 
 * Simplified design with 2 primary actions:
 * - Resolve: Navigate to Merge Changes view (or open Branch Modal for detached HEAD)
 * - Abort: Cancel the operation and return to clean state
 * 
 * Stuck states handled: locked, merge, rebase, cherry-pick, revert, bisect, am, detached
 */
import { memo, useCallback, useState, useMemo } from 'react';
import { AlertTriangle, Lock, X, ArrowRight, Loader2, GitBranch, type LucideIcon } from 'lucide-react';
import { ICON_SIZES, VIEWS } from '../constants';
import { useRepo, useLayout } from '../../context';
import { Button } from './button';
import BranchModal from '../../widgets/layout/BranchModal';
import { useIntegrationSession } from '../../features/integration';

const iconSm = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

interface StuckStateConfig {
  icon: LucideIcon;
  title: string;
  message: string;
  color: 'critical' | 'warning' | 'info';
  showResolve: boolean;
  abortLabel: string | null;
  showCreateBranch?: boolean;
}

// Simplified state configuration - 3 color schemes: critical, warning, info
const STUCK_STATE_CONFIG: Record<string, StuckStateConfig> = {
  locked: {
    icon: Lock,
    title: 'Repository Locked',
    message: 'A previous operation didn\'t complete cleanly.',
    color: 'critical',
    showResolve: false,
    abortLabel: 'Remove Lock',
  },
  merge: {
    icon: AlertTriangle,
    title: 'Merge in Progress',
    message: 'Resolve conflicts or abort to continue.',
    color: 'warning',
    showResolve: true,
    abortLabel: 'Abort',
  },
  rebase: {
    icon: AlertTriangle,
    title: 'Rebase in Progress',
    message: 'Abort to return to a clean state.',
    color: 'warning',
    showResolve: false,
    abortLabel: 'Abort Rebase',
  },
  'cherry-pick': {
    icon: AlertTriangle,
    title: 'Cherry-pick in Progress',
    message: 'Resolve conflicts or abort to continue.',
    color: 'warning',
    showResolve: true,
    abortLabel: 'Abort',
  },
  revert: {
    icon: AlertTriangle,
    title: 'Revert in Progress',
    message: 'Resolve conflicts or abort to continue.',
    color: 'warning',
    showResolve: true,
    abortLabel: 'Abort',
  },
  bisect: {
    icon: AlertTriangle,
    title: 'Bug Search Active',
    message: 'Complete the search or abort to resume normal work.',
    color: 'info',
    showResolve: false,
    abortLabel: 'End Search',
  },
  am: {
    icon: AlertTriangle,
    title: 'Patch Application in Progress',
    message: 'Resolve in Merge Changes or abort.',
    color: 'warning',
    showResolve: true,
    abortLabel: 'Abort',
  },
  detached: {
    icon: GitBranch,
    title: 'Not on Any Branch',
    message: 'Create a branch to save your work.',
    color: 'info',
    showResolve: false,
    abortLabel: null,
    showCreateBranch: true,
  },
};

interface ColorClasses {
  bg: string;
  border: string;
  text: string;
  textMuted: string;
}

// Simplified to 3 color schemes
const COLOR_CLASSES: Record<string, ColorClasses> = {
  critical: {
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    text: 'text-red-400',
    textMuted: 'text-red-400/80',
  },
  warning: {
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/30',
    text: 'text-orange-400',
    textMuted: 'text-orange-400/80',
  },
  info: {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    text: 'text-blue-400',
    textMuted: 'text-blue-400/80',
  },
};

function RecoveryBanner() {
  const { 
    mergeState, 
    operationInProgress,
    isResolvingConflict,
    abortCurrentOperation,
    removeAllStaleLocks,
  } = useRepo();
  const { setActiveView, setSidebarCollapsed, openExplorerMergeModal } = useLayout();
  const { session: integrationSession } = useIntegrationSession();
  const [isProcessing, setIsProcessing] = useState(false);
  const [branchModalOpen, setBranchModalOpen] = useState(false);

  // Determine which stuck state to show (priority order)
  const stuckType = useMemo(() => {
    if (!mergeState) return null;
    
    if (mergeState.stuckType) return mergeState.stuckType;
    
    // Fallback detection order
    if (mergeState.hasLockFile) return 'locked';
    if (mergeState.inMerge) return 'merge';
    if (mergeState.inRebase) return 'rebase';
    if (mergeState.inCherryPick) return 'cherry-pick';
    if (mergeState.inRevert) return 'revert';
    if (mergeState.inBisect) return 'bisect';
    if (mergeState.inAM) return 'am';
    if (mergeState.isDetached) return 'detached';
    
    return null;
  }, [mergeState]);

  const handleResolve = useCallback(() => {
    setActiveView(VIEWS.EXPLORER);
    setSidebarCollapsed(false);
    openExplorerMergeModal();
  }, [openExplorerMergeModal, setActiveView, setSidebarCollapsed]);

  const handleAbort = useCallback(async () => {
    setIsProcessing(true);
    try {
      if (stuckType === 'locked') {
        await removeAllStaleLocks();
      } else {
        await abortCurrentOperation();
      }
    } finally {
      setIsProcessing(false);
    }
  }, [stuckType, removeAllStaleLocks, abortCurrentOperation]);

  // Don't show if no stuck state or unrecognized state
  if (!stuckType) return null;

  // An owned session is the single resolution and cancellation authority for
  // its interrupted merge. Showing generic recovery as well would create two
  // competing destructive paths for the same index.
  if (stuckType === 'merge' && integrationSession?.state === 'needs-decisions') return null;

  const config = STUCK_STATE_CONFIG[stuckType];
  if (!config) return null;

  const colors = COLOR_CLASSES[config.color];
  const IconComponent = config.icon;

  return (
    <>
      <div className={`${colors.bg} border-b ${colors.border} px-4 py-2 flex items-center gap-3`}>
        <IconComponent style={iconSm} className={`${colors.text} shrink-0`} />
        
        <div className="flex-1 min-w-0">
          <p className={`${colors.text} text-sm font-medium`}>
            {config.title}
          </p>
          <p className={`${colors.textMuted} text-xs`}>
            {mergeState?.userMessage || config.message}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Resolve button - navigate to Merge Changes view */}
          {config.showResolve && (
            <Button
              onClick={handleResolve}
              disabled={operationInProgress}
              variant="outline"
              size="sm"
            >
              Resolve
              <ArrowRight style={iconSm} className="ml-1" />
            </Button>
          )}

          {/* Create Branch button - opens BranchModal for detached HEAD */}
          {config.showCreateBranch && (
            <Button
              onClick={() => setBranchModalOpen(true)}
              disabled={operationInProgress}
              variant="outline"
              size="sm"
            >
              <GitBranch style={iconSm} className="mr-1" />
              Create Branch
            </Button>
          )}
          
          {/* Abort button */}
          {config.abortLabel && (
            <Button
              onClick={handleAbort}
              variant="destructive"
              size="sm"
              disabled={isProcessing || isResolvingConflict || operationInProgress}
            >
              {isProcessing ? (
                <Loader2 style={iconSm} className="animate-spin mr-1" />
              ) : (
                <X style={iconSm} className="mr-1" />
              )}
              {config.abortLabel}
            </Button>
          )}
        </div>
      </div>

      {/* Branch Modal for detached HEAD */}
      <BranchModal 
        open={branchModalOpen} 
        onOpenChange={setBranchModalOpen} 
      />
    </>
  );
}

export default memo(RecoveryBanner);
