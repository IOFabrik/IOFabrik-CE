import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  Files,
  GitBranch,
  Hourglass,
  Loader2,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import { ICON_SIZES } from '../../../shared/constants';
import { useLayout } from '../../../context';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '../../../shared/ui';
import {
  useMergeFlowController,
  type MergeOutcomeState,
} from '../hooks/useMergeFlowController';
import type {
  ConflictRegionDecision,
  ConflictResolutionData,
  TextConflictDraft,
} from '../../conflict';
import { ConflictQueue } from '../../conflict';
import MergeFinishModal from './MergeFinishModal';
import { useIntegrationSession } from '../../integration';
import { MergeReviewFileList } from './modal/MergeReviewPane';
import MergeReviewPreview from './modal/MergeReviewPreview';
import TargetBranchDrawer, { type TargetBranchOption } from './modal/TargetBranchDrawer';
import { getMergeReviewSelectedFilePath } from './modal/mergeReviewShared';

const iconSm: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };
const PREPARING_STATUS_MIN_DURATION_MS = 600;

interface ExplorerMergeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PreflightStatusModel {
  tone: 'neutral' | 'warning';
  label: string;
  detail: string;
}

function isPreflightResultState(state: MergeOutcomeState): boolean {
  return state === 'ready' || state === 'review' || state === 'needs-decisions' || state === 'up-to-date';
}

function getDefaultMergeMessage(sourceBranch: string, targetBranch: string, isSquashMerge: boolean): string {
  return isSquashMerge
    ? `Squash merge ${sourceBranch} into ${targetBranch}`
    : `Merge ${sourceBranch} into ${targetBranch}`;
}

function buildOutcomeBadge(state: MergeOutcomeState): { label: string; variant: 'info' | 'success' | 'warning' | 'outline' } {
  switch (state) {
    case 'ready':
      return { label: 'Ready now', variant: 'success' };
    case 'needs-decisions':
    case 'resolving':
      return { label: 'Needs decisions', variant: 'warning' };
    case 'resolving-preparing':
      return { label: 'Preparing conflict list', variant: 'info' };
    case 'complete':
      return { label: 'Ready to finish', variant: 'info' };
    case 'up-to-date':
      return { label: 'Already synced', variant: 'outline' };
    case 'success':
      return { label: 'Merge complete', variant: 'success' };
    case 'setup':
      return { label: 'Choose destination', variant: 'outline' };
    case 'preparing':
    default:
      return { label: 'Preparing merge', variant: 'outline' };
  }
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getConflictStatusLabel(status?: string): string {
  switch (status) {
    case 'potential-conflict':
      return 'Needs a choice';
    case 'both-modified':
      return 'Both changed';
    case 'both-added':
      return 'Both added';
    case 'both-deleted':
      return 'Both deleted';
    case 'deleted-by-us':
      return 'Deleted on your branch';
    case 'deleted-by-them':
      return 'Deleted on destination';
    default:
      return 'No conflict';
  }
}

function buildPreflightStatusModel({
  outcomeState,
  currentBranch,
  effectiveSource,
  effectiveTarget,
  isDestinationReady,
  mergeReviewFileCount,
  conflictedFileCount,
}: {
  outcomeState: MergeOutcomeState;
  currentBranch: string;
  effectiveSource: string;
  effectiveTarget: string;
  isDestinationReady: boolean;
  mergeReviewFileCount: number;
  conflictedFileCount: number;
}): PreflightStatusModel {
  const taskName = !isDestinationReady
    ? 'waiting for destination'
    : effectiveSource === currentBranch
      ? `checking ${currentBranch} against ${effectiveTarget}`
      : `checking ${effectiveSource} against ${effectiveTarget}`;

  switch (outcomeState) {
    case 'setup':
      return {
        tone: 'neutral',
        label: 'processing',
        detail: taskName,
      };
    case 'preparing':
      return {
        tone: 'neutral',
        label: 'processing',
        detail: taskName,
      };
    case 'ready':
      return {
        tone: 'neutral',
        label: 'summary',
        detail: `No conflicts found. ${effectiveSource} can merge into ${effectiveTarget}.`,
      };
    case 'review':
      return {
        tone: 'neutral',
        label: 'summary',
        detail: `No conflicts found. ${formatCountLabel(mergeReviewFileCount, 'file is ready', 'files are ready')} for review.`,
      };
    case 'needs-decisions':
      return {
        tone: 'warning',
        label: 'summary',
        detail: `${formatCountLabel(conflictedFileCount, 'file needs a choice', 'files need choices')} before the merge can continue.`,
      };
    case 'up-to-date':
      return {
        tone: 'neutral',
        label: 'summary',
        detail: `${effectiveTarget} already contains the changes from ${effectiveSource}.`,
      };
    default:
      return {
        tone: 'neutral',
        label: 'processing',
        detail: taskName,
      };
  }
}

function getPreflightToneClasses(tone: PreflightStatusModel['tone']): string {
  switch (tone) {
    case 'warning':
      return 'text-amber-500';
    case 'neutral':
    default:
      return 'text-theme-muted';
  }
}

function createTextConflictDraft(data: ConflictResolutionData): TextConflictDraft | undefined {
  if (!data.resolutionToken) {
    return undefined;
  }

  return {
    path: data.path,
    resolutionToken: data.resolutionToken,
    decisions: Object.fromEntries(
      data.regions.map((region) => [region.id, { mode: 'unresolved' } satisfies ConflictRegionDecision]),
    ),
  };
}

function LegacyExplorerMergeModal({ open, onOpenChange }: ExplorerMergeModalProps): JSX.Element {
  const {
    repoPath,
    conflictedFiles,
    isCheckingConflicts,
    conflictCheckResult,
    mergeReviewFiles,
    isLoadingMergeReviewFiles,
    selectedConflictFile,
    setSelectedConflictFile,
    fileResolutions,
    isResolvingConflict,
    loadConflictResolutionData,
    resolveConflictWithDecisions,
    isSquashMerge,
    currentBranch,
    availableBranches,
    targetBranch,
    setTargetBranch,
    handleTargetBranchChange,
    error,
    showSuccess,
    selectedReviewFiles,
    reviewFilePath,
    reviewDiff,
    isLoadingReviewDiff,
    isDeletingMergedBranch,
    isCompletingMerge,
    effectiveTarget,
    effectiveSource,
    branchToCleanUp,
    canDeleteMergedBranch,
    hasActiveMerge: hasActiveMergeFromController,
    defaultMergeMessage: defaultMergeMessageFromController,
    mergeOutcomeState,
    handleCheck,
    handleStartMerge,
    handleToggleReviewFile,
    handleToggleAllReviewFiles,
    handleReviewFile,
    handleResolve,
    handleAbort,
    handleComplete,
    handleDismiss,
    handleDeleteMergedBranch,
  } = useMergeFlowController({ enabled: open });

  const [message, setMessage] = useState('');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [isAbandoningMerge, setIsAbandoningMerge] = useState(false);
  const [isReviewDrawerOpen, setIsReviewDrawerOpen] = useState(false);
  const [viewingDiffForFile, setViewingDiffForFile] = useState<string | null>(null);
  const [resolutionDataByPath, setResolutionDataByPath] = useState<Record<string, ConflictResolutionData>>({});
  const [conflictDrafts, setConflictDrafts] = useState<Record<string, TextConflictDraft>>({});
  const [resolutionLoadingByPath, setResolutionLoadingByPath] = useState<Record<string, boolean>>({});
  const [resolutionLoadErrors, setResolutionLoadErrors] = useState<Record<string, string>>({});
  const [resolutionApplyErrors, setResolutionApplyErrors] = useState<Record<string, string>>({});
  const hasAutoAnalyzedRef = useRef(false);
  const resolutionLoadGenerationRef = useRef(0);
  const preparingShownAtRef = useRef<number | null>(null);
  const displayedOutcomeTimerRef = useRef<number | null>(null);
  const reviewDrawerRef = useRef<HTMLDivElement | null>(null);
  const hasActiveMerge = hasActiveMergeFromController ?? (Boolean(conflictCheckResult?.mergeStarted) && !showSuccess && !conflictCheckResult?.autoCompleted);
  const defaultMergeMessage = defaultMergeMessageFromController ?? getDefaultMergeMessage(
    effectiveSource,
    effectiveTarget,
    conflictCheckResult?.isSquashMerge ?? isSquashMerge,
  );

  useEffect(() => {
    setMessage(defaultMergeMessage);
  }, [defaultMergeMessage]);

  useEffect(() => {
    if (!open) {
      hasAutoAnalyzedRef.current = false;
      return;
    }

    if (!targetBranch && effectiveTarget && effectiveTarget !== currentBranch) {
      setTargetBranch(effectiveTarget);
    }
  }, [open, targetBranch, effectiveTarget, currentBranch, setTargetBranch]);

  useEffect(() => {
    if (!open || hasAutoAnalyzedRef.current || !targetBranch) {
      return;
    }

    hasAutoAnalyzedRef.current = true;
    void handleCheck();
  }, [open, targetBranch, handleCheck]);

  const outcomeState = mergeOutcomeState ?? useMemo<MergeOutcomeState>(() => {
    if (isCheckingConflicts && !conflictCheckResult) {
      return 'preparing';
    }

    if (showSuccess || conflictCheckResult?.autoCompleted) {
      return 'success';
    }

    if (conflictCheckResult?.success && conflictCheckResult.alreadyUpToDate) {
      return 'up-to-date';
    }

    if (conflictCheckResult?.success && conflictCheckResult.mergeStarted) {
      if (conflictCheckResult.liveMergePhase === 'ready-to-complete') {
        return 'complete';
      }

      if (conflictCheckResult.liveMergePhase === 'resolving') {
        return 'resolving';
      }

      return 'resolving-preparing';
    }

    if (conflictCheckResult?.success && conflictCheckResult.hasConflicts) {
      return 'needs-decisions';
    }

    if (conflictCheckResult?.success && mergeReviewFiles.length > 0) {
      return 'review';
    }

    if (conflictCheckResult?.success) {
      return 'ready';
    }

    if (!targetBranch || targetBranch === currentBranch) {
      return 'setup';
    }

    return 'preparing';
  }, [
    conflictCheckResult,
    currentBranch,
    isCheckingConflicts,
    mergeReviewFiles.length,
    showSuccess,
    targetBranch,
  ]);
  const [displayedOutcomeState, setDisplayedOutcomeState] = useState<MergeOutcomeState>(outcomeState);

  useEffect(() => {
    if (open) {
      return;
    }

    resolutionLoadGenerationRef.current += 1;
    setResolutionDataByPath({});
    setConflictDrafts({});
    setResolutionLoadingByPath({});
    setResolutionLoadErrors({});
    setResolutionApplyErrors({});
  }, [open]);

  useEffect(() => {
    if (!open || outcomeState !== 'resolving' || !selectedConflictFile) {
      return;
    }

    if (
      resolutionDataByPath[selectedConflictFile]
      || resolutionLoadingByPath[selectedConflictFile]
      || resolutionLoadErrors[selectedConflictFile]
    ) {
      return;
    }

    const filePath = selectedConflictFile;
    const loadGeneration = resolutionLoadGenerationRef.current;
    setResolutionLoadingByPath((current) => ({ ...current, [filePath]: true }));

    void loadConflictResolutionData(filePath).then((data) => {
      if (loadGeneration !== resolutionLoadGenerationRef.current) {
        return;
      }

      if (!data) {
        setResolutionLoadErrors((current) => ({
          ...current,
          [filePath]: 'Error loading the file viewer. Choose the complete file to continue.',
        }));
        return;
      }

      setResolutionDataByPath((current) => ({ ...current, [filePath]: data }));

      if (data.eligible) {
        const nextDraft = createTextConflictDraft(data);
        if (nextDraft) {
          setConflictDrafts((current) => {
            const existingDraft = current[filePath];
            if (existingDraft?.resolutionToken === nextDraft.resolutionToken) {
              return current;
            }
            return { ...current, [filePath]: nextDraft };
          });
        }
      }
    }).finally(() => {
      if (loadGeneration === resolutionLoadGenerationRef.current) {
        setResolutionLoadingByPath((current) => ({ ...current, [filePath]: false }));
      }
    });
  }, [
    loadConflictResolutionData,
    open,
    outcomeState,
    resolutionDataByPath,
    resolutionLoadErrors,
    resolutionLoadingByPath,
    selectedConflictFile,
  ]);

  const handleConflictDecision = useCallback((
    regionId: string,
    decision: ConflictRegionDecision,
  ): void => {
    if (!selectedConflictFile) {
      return;
    }

    setConflictDrafts((current) => {
      const draft = current[selectedConflictFile];
      if (!draft) {
        return current;
      }

      return {
        ...current,
        [selectedConflictFile]: {
          ...draft,
          decisions: { ...draft.decisions, [regionId]: decision },
        },
      };
    });
    setResolutionApplyErrors((current) => ({ ...current, [selectedConflictFile]: '' }));
  }, [selectedConflictFile]);

  const handleResolveWithDecisions = useCallback(async (): Promise<void> => {
    if (!selectedConflictFile) {
      return;
    }

    const filePath = selectedConflictFile;
    const draft = conflictDrafts[filePath];
    if (!draft) {
      return;
    }

    setResolutionApplyErrors((current) => ({ ...current, [filePath]: '' }));
    const success = await resolveConflictWithDecisions(filePath, draft.resolutionToken, draft.decisions);

    if (!success) {
      setResolutionApplyErrors((current) => ({
        ...current,
        [filePath]: "We couldn't resolve this file.\nReview your choice and select Resolve File to try again.",
      }));
      return;
    }

    setResolutionDataByPath((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
    setConflictDrafts((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
    setResolutionApplyErrors((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
    setSelectedConflictFile(null);
  }, [
    conflictDrafts,
    resolveConflictWithDecisions,
    selectedConflictFile,
    setSelectedConflictFile,
  ]);

  useEffect(() => {
    return () => {
      if (displayedOutcomeTimerRef.current !== null) {
        window.clearTimeout(displayedOutcomeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (displayedOutcomeTimerRef.current !== null) {
      window.clearTimeout(displayedOutcomeTimerRef.current);
      displayedOutcomeTimerRef.current = null;
    }

    if (!open) {
      preparingShownAtRef.current = null;
      setDisplayedOutcomeState(outcomeState);
      return;
    }

    if (outcomeState === 'preparing') {
      if (preparingShownAtRef.current === null) {
        preparingShownAtRef.current = Date.now();
      }

      setDisplayedOutcomeState('preparing');
      return;
    }

    if (preparingShownAtRef.current !== null && isPreflightResultState(outcomeState)) {
      const elapsed = Date.now() - preparingShownAtRef.current;
      const remaining = PREPARING_STATUS_MIN_DURATION_MS - elapsed;

      if (remaining > 0) {
        displayedOutcomeTimerRef.current = window.setTimeout(() => {
          preparingShownAtRef.current = null;
          displayedOutcomeTimerRef.current = null;
          setDisplayedOutcomeState(outcomeState);
        }, remaining);
        return;
      }
    }

    preparingShownAtRef.current = null;
    setDisplayedOutcomeState(outcomeState);
  }, [open, outcomeState]);

  useEffect(() => {
    if (!open || displayedOutcomeState !== 'review') {
      setIsReviewDrawerOpen(false);
    }
  }, [displayedOutcomeState, open]);

  useEffect(() => {
    if (!open) {
      setViewingDiffForFile(null);
    }
  }, [open]);

  useEffect(() => {
    setViewingDiffForFile(null);
  }, [displayedOutcomeState]);

  useEffect(() => {
    if (!isReviewDrawerOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (isReviewDrawerOpen && !reviewDrawerRef.current?.contains(event.target as Node)) {
        setIsReviewDrawerOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsReviewDrawerOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isReviewDrawerOpen]);

  const badge = buildOutcomeBadge(displayedOutcomeState);
  const shouldShowInlinePreflight = useMemo(
    () => (
      open
      && !hasActiveMerge
      && !showSuccess
      && (
        displayedOutcomeState === 'setup'
        || displayedOutcomeState === 'preparing'
        || isPreflightResultState(displayedOutcomeState)
      )
    ),
    [displayedOutcomeState, hasActiveMerge, open, showSuccess],
  );
  const isReviewState = displayedOutcomeState === 'review';
  const isViewingDiff = viewingDiffForFile !== null;
  const showReviewFileNav = isReviewState && isViewingDiff;
  const activeReviewPath = useMemo(
    () => getMergeReviewSelectedFilePath(reviewFilePath, reviewDiff) || mergeReviewFiles[0]?.path || '',
    [mergeReviewFiles, reviewDiff, reviewFilePath],
  );
  const currentReviewIndex = useMemo(
    () => mergeReviewFiles.findIndex((file) => file.path === activeReviewPath),
    [activeReviewPath, mergeReviewFiles],
  );
  const hasPreviousReviewFile = currentReviewIndex > 0;
  const hasNextReviewFile = currentReviewIndex >= 0 && currentReviewIndex < mergeReviewFiles.length - 1;
  const selectedConflict = useMemo(
    () => conflictedFiles.find((file) => file.path === selectedConflictFile) || conflictedFiles[0] || null,
    [conflictedFiles, selectedConflictFile],
  );
  const conflictStatusByPath = useMemo(
    () => new Map(conflictedFiles.map((file) => [file.path, file.status])),
    [conflictedFiles],
  );
  const needsDecisionFiles = useMemo(
    () => (
      mergeReviewFiles.length > 0
        ? mergeReviewFiles
        : conflictedFiles.map((file) => ({ path: file.path }))
    ),
    [conflictedFiles, mergeReviewFiles],
  );
  const allNeedsDecisionFilesSelected = useMemo(
    () => needsDecisionFiles.length > 0 && selectedReviewFiles.length === needsDecisionFiles.length,
    [needsDecisionFiles.length, selectedReviewFiles.length],
  );
  const allMergeReviewFilesSelected = useMemo(
    () => mergeReviewFiles.length > 0 && selectedReviewFiles.length === mergeReviewFiles.length,
    [mergeReviewFiles.length, selectedReviewFiles.length],
  );
  const isDestinationReady = Boolean(targetBranch) && targetBranch !== currentBranch;
  const preflightStatusModel = useMemo(
    () => (shouldShowInlinePreflight
      ? buildPreflightStatusModel({
        outcomeState: displayedOutcomeState,
        currentBranch,
        effectiveSource,
        effectiveTarget,
        isDestinationReady,
        mergeReviewFileCount: mergeReviewFiles.length,
        conflictedFileCount: conflictedFiles.length,
      })
      : null),
    [
      conflictedFiles.length,
      currentBranch,
      effectiveSource,
      effectiveTarget,
      isDestinationReady,
      mergeReviewFiles.length,
      displayedOutcomeState,
      shouldShowInlinePreflight,
    ],
  );

  const requestClose = useCallback((): void => {
    if (hasActiveMerge) {
      setShowCloseConfirm(true);
      return;
    }

    handleDismiss();
    onOpenChange(false);
  }, [handleDismiss, hasActiveMerge, onOpenChange]);

  const confirmClose = useCallback(async (): Promise<void> => {
    setIsAbandoningMerge(true);
    try {
      const aborted = await handleAbort();
      if (aborted) {
        handleDismiss();
        onOpenChange(false);
        setShowCloseConfirm(false);
      }
    } finally {
      setIsAbandoningMerge(false);
    }
  }, [handleAbort, handleDismiss, onOpenChange]);

  const handleOpenStateChange = useCallback((nextOpen: boolean): void => {
    if (!nextOpen) {
      requestClose();
    }
  }, [requestClose]);

  const handleRetryAnalysis = useCallback((): void => {
    void handleCheck();
  }, [handleCheck]);

  const handleMergeNow = useCallback((): void => {
    void handleStartMerge();
  }, [handleStartMerge]);

  const handleDeleteBranchAndClose = useCallback((): void => {
    void (async () => {
      const deleted = await handleDeleteMergedBranch();
      if (deleted) {
        onOpenChange(false);
      }
    })();
  }, [handleDeleteMergedBranch, onOpenChange]);

  const handleFinishMerge = useCallback((): void => {
    void handleComplete(message);
  }, [handleComplete, message]);

  const handleStepReviewFile = useCallback((direction: -1 | 1): void => {
    const nextIndex = currentReviewIndex + direction;
    const nextFile = mergeReviewFiles[nextIndex];

    if (!nextFile) {
      return;
    }

    void handleReviewFile(nextFile.path);
  }, [currentReviewIndex, handleReviewFile, mergeReviewFiles]);

  const handleReviewSelection = useCallback((filePath: string): void => {
    setIsReviewDrawerOpen(false);
    void handleReviewFile(filePath);
  }, [handleReviewFile]);

  const handleViewChanges = useCallback((filePath: string): void => {
    setViewingDiffForFile(filePath);
    void handleReviewFile(filePath);
  }, [handleReviewFile]);

  const handleBackToFileList = useCallback((): void => {
    setViewingDiffForFile(null);
  }, []);

  const handleTargetBranchSelection = useCallback((nextTargetBranch: string): void => {
    if (!nextTargetBranch || nextTargetBranch === effectiveTarget) {
      return;
    }

    hasAutoAnalyzedRef.current = false;
    setIsReviewDrawerOpen(false);
    handleTargetBranchChange(nextTargetBranch);
  }, [effectiveTarget, handleTargetBranchChange]);

  const targetBranchOptions = useMemo<TargetBranchOption[]>(
    () => [{ name: currentBranch, isCurrent: true }, ...availableBranches],
    [availableBranches, currentBranch],
  );

  const isTargetBranchLocked = hasActiveMerge || displayedOutcomeState === 'complete' || displayedOutcomeState === 'success';

  let footerNote = 'Note: Check this step, then continue when you are ready.';

  let title = 'Preparing merge';
  let description = 'Checking whether your work can be merged safely.';

  switch (displayedOutcomeState) {
    case 'setup':
      title = 'Choose where to merge';
      description = 'Pick the destination branch before checking the merge path.';
      footerNote = 'Note: Choose where these changes should go.';
      break;
    case 'ready':
      title = 'Ready to merge';
      description = 'Everything looks good. Your changes can be merged safely.';
      footerNote = 'Note: Everything looks good. You can merge now.';
      break;
    case 'review':
      title = 'Merge review';
      description = '';
      footerNote = 'Note: Choose the files you want and preview them if needed.';
      break;
    case 'needs-decisions':
      title = 'Needs decisions';
      description = 'Choose the files to bring over first. IOFabrik will only ask you to resolve conflicts for the files you keep selected.';
      footerNote = 'Note: Files marked Needs a choice will enter the guided conflict step.';
      break;
    case 'resolving':
      title = 'Resolve files';
      description = 'Choose which version to keep for each file, one file at a time.';
      footerNote = 'Note: Pick the version you want to keep for this file.';
      break;
    case 'resolving-preparing':
      title = 'Preparing conflict list';
      description = 'The merge has started. IOFabrik is confirming which files still need a choice.';
      footerNote = 'Note: IOFabrik is getting the list of files that need a choice.';
      break;
    case 'complete':
      title = 'Finish merge';
      description = 'Your merge is prepared. Add a message, then finish when you are ready.';
      footerNote = 'Note: Add a short message, then finish the merge.';
      break;
    case 'up-to-date':
      title = 'Already up to date';
      description = `${effectiveTarget} already contains these changes.`;
      footerNote = 'Note: There is nothing new to merge.';
      break;
    case 'success':
      title = 'Merge complete';
      description = 'Your changes have been merged successfully.';
      footerNote = 'Note: The merge is done.';
      break;
    default:
      footerNote = 'Note: IOFabrik is getting things ready.';
      break;
  }

  return (
    <>
      <AlertDialog open={open} onOpenChange={handleOpenStateChange}>
        <AlertDialogContent size="6xl" className="h-[min(92vh,860px)] p-0 flex flex-col overflow-hidden">
          <div className="border-b border-theme-default px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AlertDialogTitle className={isReviewState ? 'text-xl' : 'text-2xl'}>{title}</AlertDialogTitle>
                  {!isReviewState && (
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                  <div className="inline-flex min-w-0 items-center gap-2 text-theme-secondary">
                    <GitBranch style={iconSm} className="text-blue-400 shrink-0" />
                    <span className="truncate font-medium text-theme-primary">{effectiveSource}</span>
                    <span className="text-xs text-theme-muted">(Current branch)</span>
                  </div>

                  <ArrowRight style={iconSm} className="text-theme-muted shrink-0" />

                  <TargetBranchDrawer
                    disabled={isTargetBranchLocked}
                    onSelect={handleTargetBranchSelection}
                    options={targetBranchOptions}
                    selectedBranch={effectiveTarget}
                    variant="header"
                  />
                </div>

                {!isReviewState && description && <AlertDialogDescription className="mt-3">{description}</AlertDialogDescription>}
              </div>
              <Button variant="ghost" size="icon" onClick={requestClose} aria-label="Close merge modal">
                <X style={iconSm} />
              </Button>
            </div>

            {isReviewState ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-theme-secondary">
                  <span className="font-medium text-theme-secondary">{formatCountLabel(mergeReviewFiles.length, 'file changed', 'files changed')}</span>
                  <span className="text-theme-muted">|</span>
                  <span className="font-medium text-theme-secondary">{formatCountLabel(selectedReviewFiles.length, 'file to merge', 'files to merge')}</span>
                  <span className="text-theme-muted">|</span>
                  <span className="text-theme-secondary">No conflicts</span>
                </div>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {showReviewFileNav ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleStepReviewFile(-1)}
                        disabled={!hasPreviousReviewFile || isLoadingReviewDiff}
                        aria-label="Previous file"
                        className="h-9 w-9 px-0 border-theme-default text-theme-primary"
                      >
                        <ChevronLeft className="h-4.5 w-4.5 stroke-[2.5]" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleStepReviewFile(1)}
                        disabled={!hasNextReviewFile || isLoadingReviewDiff}
                        aria-label="Next file"
                        className="h-9 w-9 px-0 border-theme-default text-theme-primary"
                      >
                        <ChevronRight className="h-4.5 w-4.5 stroke-[2.5]" />
                      </Button>

                      <div ref={reviewDrawerRef} className="relative">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setIsReviewDrawerOpen((current) => !current)}
                          aria-expanded={isReviewDrawerOpen}
                          aria-controls="merge-review-selected-files"
                          className="h-9 border-theme-default text-theme-primary"
                        >
                          <Files style={iconSm} />
                          Selected files
                          <Badge variant="outline">{mergeReviewFiles.length}</Badge>
                        </Button>

                        {isReviewDrawerOpen && (
                          <div
                            id="merge-review-selected-files"
                            className="absolute right-0 top-full z-20 mt-2 w-[min(24rem,calc(100vw-4rem))] overflow-hidden rounded-xl border border-theme-default bg-theme-surface shadow-xl"
                          >
                            <MergeReviewFileList
                              mergeReviewFiles={mergeReviewFiles}
                              selectedReviewFiles={selectedReviewFiles}
                              reviewFilePath={activeReviewPath}
                              isLoadingMergeReviewFiles={isLoadingMergeReviewFiles}
                              onToggleReviewFile={handleToggleReviewFile}
                              onToggleAllReviewFiles={handleToggleAllReviewFiles}
                              onReviewFile={handleReviewSelection}
                            />
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className={isViewingDiff ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 min-h-0 overflow-hidden px-5 py-4'}>
            {error && (
              <div className={isViewingDiff ? 'mx-5 mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300' : 'mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300'}>
                {error}
              </div>
            )}

            {preflightStatusModel && !isViewingDiff && (
              <Card className="mb-4 border-none bg-transparent shadow-none">
                <CardContent className="px-0 py-0">
                  <div className={`flex items-center gap-2 text-sm ${getPreflightToneClasses(preflightStatusModel.tone)}`}>
                    {preflightStatusModel.label === 'processing' ? (
                      <Hourglass className="h-4 w-4 shrink-0" />
                    ) : null}
                    <span className="shrink-0 lowercase">{preflightStatusModel.label}</span>
                    <span className="shrink-0">:</span>
                    <span className="min-w-0 truncate">{preflightStatusModel.detail}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {displayedOutcomeState === 'setup' && (
              <div className="max-w-xl mx-auto">
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <div>
                      <p className="text-theme-primary text-base font-medium mb-1">Choose a destination branch</p>
                      <p className="text-theme-secondary text-sm">The merge check needs to know which branch should receive your changes.</p>
                    </div>
                    <TargetBranchDrawer
                      onSelect={handleTargetBranchSelection}
                      options={targetBranchOptions}
                      selectedBranch={targetBranch}
                      variant="panel"
                    />
                    <div className="rounded-lg border border-theme-default bg-theme-surface/40 px-4 py-3">
                      <div>
                        <p className="text-theme-primary text-sm font-medium">Save style</p>
                        <p className="text-theme-secondary text-xs">
                          {isSquashMerge
                            ? 'IOFabrik will combine these changes into one save by default.'
                            : 'This merge is using the repository default merge style.'}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {(displayedOutcomeState === 'ready' || displayedOutcomeState === 'review') && (
              isViewingDiff ? (
                <div className="h-full flex flex-col px-5 py-4">
                  <div className="flex items-center gap-2 pb-3 border-b border-theme-default mb-3">
                    <Button variant="outline" size="sm" onClick={handleBackToFileList}>
                      <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                      Back to files
                    </Button>
                    <span className="text-sm text-theme-primary font-medium truncate">{viewingDiffForFile}</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <MergeReviewPreview
                      repoPath={repoPath}
                      reviewFilePath={reviewFilePath}
                      reviewDiff={reviewDiff}
                      isLoadingReviewDiff={isLoadingReviewDiff}
                    />
                  </div>
                </div>
              ) : mergeReviewFiles.length > 0 ? (
                <div className="h-full min-h-0 flex flex-col overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-theme-default bg-theme-surface/30">
                    <div className="h-full overflow-auto">
                      <Table>
                      <TableHeader className="bg-theme-elevated">
                        <TableRow className="hover:bg-theme-elevated">
                          <TableHead className="w-14">
                            <input
                              type="checkbox"
                              checked={allMergeReviewFilesSelected}
                              onChange={handleToggleAllReviewFiles}
                              aria-label="Select all files for merge"
                              className="rounded border-theme-default bg-theme-base"
                            />
                          </TableHead>
                          <TableHead>File name</TableHead>
                          <TableHead className="w-44">View changes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {isLoadingMergeReviewFiles ? (
                          <TableRow>
                            <TableCell colSpan={3} className="py-8 text-center text-theme-muted">
                              <span className="inline-flex items-center gap-2">
                                <Loader2 style={iconSm} className="animate-spin" />
                                Loading files...
                              </span>
                            </TableCell>
                          </TableRow>
                        ) : mergeReviewFiles.map((file) => {
                          const isSelected = selectedReviewFiles.includes(file.path);

                          return (
                            <TableRow key={file.path} data-state={isSelected ? 'selected' : undefined}>
                              <TableCell>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => handleToggleReviewFile(file.path)}
                                  aria-label={`Select ${file.path} for merge`}
                                  className="rounded border-theme-default bg-theme-base"
                                />
                              </TableCell>
                              <TableCell className="break-all">{file.path}</TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleViewChanges(file.path)}
                                  className="gap-1.5"
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                  View changes
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    </div>
                  </div>
                </div>
              ) : null
            )}

            {displayedOutcomeState === 'needs-decisions' && (
              isViewingDiff ? (
                <div className="h-full flex flex-col px-5 py-4">
                  <div className="flex items-center gap-2 pb-3 border-b border-theme-default mb-3">
                    <Button variant="outline" size="sm" onClick={handleBackToFileList}>
                      <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                      Back to files
                    </Button>
                    <span className="text-sm text-theme-primary font-medium truncate">{viewingDiffForFile}</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <MergeReviewPreview
                      repoPath={repoPath}
                      reviewFilePath={reviewFilePath}
                      reviewDiff={reviewDiff}
                      isLoadingReviewDiff={isLoadingReviewDiff}
                    />
                  </div>
                </div>
              ) : (
              <div className="h-full min-h-0 flex flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-theme-default bg-theme-surface/30">
                  <div className="h-full overflow-auto">
                    <Table>
                    <TableHeader className="bg-theme-elevated">
                      <TableRow className="hover:bg-theme-elevated">
                        <TableHead className="w-14">
                          <input
                            type="checkbox"
                            checked={allNeedsDecisionFilesSelected}
                            onChange={handleToggleAllReviewFiles}
                            aria-label="Select all files for merge"
                            className="rounded border-theme-default bg-theme-base"
                          />
                        </TableHead>
                        <TableHead>File name</TableHead>
                        <TableHead className="w-48">Conflict status</TableHead>
                        <TableHead className="w-44">View changes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoadingMergeReviewFiles ? (
                        <TableRow>
                          <TableCell colSpan={4} className="py-8 text-center text-theme-muted">
                            <span className="inline-flex items-center gap-2">
                              <Loader2 style={iconSm} className="animate-spin" />
                              Loading files...
                            </span>
                          </TableCell>
                        </TableRow>
                      ) : needsDecisionFiles.length > 0 ? (
                        needsDecisionFiles.map((file) => {
                          const isSelected = selectedReviewFiles.includes(file.path);
                          const conflictStatus = conflictStatusByPath.get(file.path);

                          return (
                            <TableRow key={file.path} data-state={isSelected ? 'selected' : undefined}>
                              <TableCell>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => handleToggleReviewFile(file.path)}
                                  aria-label={`Select ${file.path} for merge`}
                                  className="rounded border-theme-default bg-theme-base"
                                />
                              </TableCell>
                              <TableCell className="break-all">{file.path}</TableCell>
                              <TableCell className="text-theme-secondary">{getConflictStatusLabel(conflictStatus)}</TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleViewChanges(file.path)}
                                  className="gap-1.5"
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                  View changes
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableRow>
                          <TableCell colSpan={4} className="py-8 text-center text-theme-muted">
                            No files available for this merge.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  </div>
                </div>
              </div>
              )
            )}

            {displayedOutcomeState === 'resolving' && (
              <ConflictQueue
                conflictedFiles={conflictedFiles}
                selectedConflictFile={selectedConflictFile}
                fileResolutions={fileResolutions}
                isResolvingConflict={isResolvingConflict}
                sourceBranch={effectiveSource}
                targetBranch={effectiveTarget}
                onSelectFile={setSelectedConflictFile}
                onResolve={handleResolve}
                resolutionData={selectedConflictFile ? resolutionDataByPath[selectedConflictFile] : undefined}
                conflictDraft={selectedConflictFile ? conflictDrafts[selectedConflictFile] : undefined}
                isLoadingResolutionData={selectedConflictFile
                  ? Boolean(resolutionLoadingByPath[selectedConflictFile])
                  : false}
                resolutionLoadError={selectedConflictFile
                  ? resolutionLoadErrors[selectedConflictFile]
                  : undefined}
                resolutionApplyError={selectedConflictFile
                  ? resolutionApplyErrors[selectedConflictFile]
                  : undefined}
                onConflictDecision={handleConflictDecision}
                onResolveWithDecisions={handleResolveWithDecisions}
              />
            )}

            {displayedOutcomeState === 'complete' && (
              <div className="max-w-3xl mx-auto space-y-4">
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <div>
                      <p className="text-theme-muted text-xs uppercase tracking-wide mb-2">Merge message</p>
                      <Textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} />
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {displayedOutcomeState === 'success' && (
              <div className="max-w-3xl mx-auto space-y-4">
                {canDeleteMergedBranch && (
                  <Card>
                    <CardContent className="p-6 flex items-start justify-between gap-4 flex-col md:flex-row md:items-center">
                      <div>
                        <p className="text-theme-primary text-base font-medium mb-1">Clean up merged branch</p>
                        <p className="text-theme-secondary text-sm">Delete {branchToCleanUp} now to reduce confusion the next time someone saves changes.</p>
                      </div>
                      <Button onClick={handleDeleteBranchAndClose} disabled={isDeletingMergedBranch}>
                        {isDeletingMergedBranch ? <Loader2 style={iconSm} className="animate-spin mr-2" /> : <Trash2 style={iconSm} className="mr-2" />}
                        Delete {branchToCleanUp}
                      </Button>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </div>

          <AlertDialogFooter className="border-t border-theme-default bg-theme-surface/60 px-5 py-3 justify-between">
            <div className="text-xs text-theme-muted">
              {displayedOutcomeState === 'resolving' && selectedConflict
                ? `Note: Choose what to keep for ${selectedConflict.path}.`
                : footerNote}
            </div>
            <div className="flex gap-2">
              {(displayedOutcomeState === 'setup' || displayedOutcomeState === 'ready' || displayedOutcomeState === 'review' || displayedOutcomeState === 'needs-decisions' || displayedOutcomeState === 'complete' || displayedOutcomeState === 'resolving' || displayedOutcomeState === 'resolving-preparing') && (
                <Button variant="outline" onClick={requestClose} disabled={isResolvingConflict || isCompletingMerge}>
                  Cancel
                </Button>
              )}

              {displayedOutcomeState === 'setup' && (
                <Button onClick={handleRetryAnalysis} disabled={!targetBranch || targetBranch === currentBranch}>
                  <Search style={iconSm} className="mr-2" />
                  Check merge
                </Button>
              )}

              {displayedOutcomeState === 'ready' && (
                <Button onClick={handleMergeNow}>
                  <Check style={iconSm} className="mr-2" />
                  Merge now
                </Button>
              )}

              {displayedOutcomeState === 'review' && (
                <Button onClick={handleMergeNow} disabled={selectedReviewFiles.length === 0}>
                  <Check style={iconSm} className="mr-2" />
                  Merge now
                </Button>
              )}

              {displayedOutcomeState === 'needs-decisions' && (
                <Button onClick={handleMergeNow} disabled={selectedReviewFiles.length === 0}>
                  <ChevronRight style={iconSm} className="mr-2" />
                  Start guided merge for selected files
                </Button>
              )}

              {displayedOutcomeState === 'complete' && (
                <Button onClick={handleFinishMerge} disabled={isCompletingMerge || !message.trim()}>
                  {isCompletingMerge ? <Loader2 style={iconSm} className="animate-spin mr-2" /> : <Check style={iconSm} className="mr-2" />}
                  Save my choices and finish
                </Button>
              )}

              {displayedOutcomeState === 'up-to-date' && (
                <Button onClick={requestClose}>Close</Button>
              )}

              {displayedOutcomeState === 'success' && (
                <Button onClick={requestClose}>Done</Button>
              )}
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave merge?</AlertDialogTitle>
            <AlertDialogDescription>
              A merge is already in progress. Leaving this modal will stop the merge and discard any unfinished conflict decisions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isAbandoningMerge}>Stay here</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmClose()} disabled={isAbandoningMerge}>
              {isAbandoningMerge ? <Loader2 style={iconSm} className="animate-spin mr-2" /> : null}
              Leave merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// The two flows are kept as separate components rather than branches inside
// one: Phase 5 deletes the legacy one whole.
function ExplorerMergeModal({ open, onOpenChange }: ExplorerMergeModalProps): JSX.Element {
  const { developerModeEnabled } = useLayout();
  const { session } = useIntegrationSession();

  return developerModeEnabled || session
    ? <MergeFinishModal open={open} onOpenChange={onOpenChange} />
    : <LegacyExplorerMergeModal open={open} onOpenChange={onOpenChange} />;
}

export default memo(ExplorerMergeModal);
