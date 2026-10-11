import { memo, useEffect, useMemo, type CSSProperties } from 'react';
import {
  Check,
  CheckCircle2,
} from 'lucide-react';

import { ICON_SIZES } from '../../../../shared/constants';
import { Badge, Card, CardContent } from '../../../../shared/ui';
import type {
  ConflictedFile,
  ResolutionStrategy,
} from '../../../../domain/repo/context/RepoContext.types';
import type {
  ConflictRegionDecision,
  ConflictResolutionData,
  TextConflictDraft,
} from '../../types';
import ConflictResolverPane from './ConflictResolverPane';

const iconLg: CSSProperties = { width: ICON_SIZES.lg * 2, height: ICON_SIZES.lg * 2 };

export interface ConflictQueueFile {
  path: string;
  status: ConflictedFile['status'] | 'added-by-us' | 'added-by-them';
}

const CONFLICT_STATUS_LABELS: Record<ConflictQueueFile['status'], string> = {
  'both-modified': 'Both changed',
  'both-added': 'Both added',
  'both-deleted': 'Both deleted',
  'added-by-us': 'Only Current has this file',
  'added-by-them': 'Only Incoming has this file',
  'deleted-by-us': 'Deleted from your work',
  'deleted-by-them': 'Deleted from shared work',
};

interface ConflictQueueProps {
  conflictedFiles: ConflictQueueFile[];
  selectedConflictFile: string | null;
  fileResolutions: Record<string, ResolutionStrategy>;
  isResolvingConflict: boolean;
  sourceBranch: string;
  targetBranch: string;
  onSelectFile: (path: string | null) => void;
  onResolve: (filePath: string, strategy: ResolutionStrategy) => void | Promise<void>;
  resolutionData?: ConflictResolutionData;
  conflictDraft?: TextConflictDraft;
  isLoadingResolutionData?: boolean;
  resolutionLoadError?: string;
  resolutionApplyError?: string;
  onConflictDecision?: (regionId: string, decision: ConflictRegionDecision) => void;
  onResolveWithDecisions?: () => void | Promise<void>;
}

function ConflictQueue({
  conflictedFiles,
  selectedConflictFile,
  fileResolutions,
  isResolvingConflict,
  sourceBranch,
  targetBranch,
  onSelectFile,
  onResolve,
  resolutionData,
  conflictDraft,
  isLoadingResolutionData = false,
  resolutionLoadError,
  resolutionApplyError,
  onConflictDecision = () => undefined,
  onResolveWithDecisions = () => undefined,
}: ConflictQueueProps): JSX.Element {
  const unresolvedConflicts = useMemo(
    () => conflictedFiles.filter((file) => !fileResolutions[file.path]),
    [conflictedFiles, fileResolutions],
  );

  const selectedUnresolvedConflict = useMemo(
    () => unresolvedConflicts.find((file) => file.path === selectedConflictFile) || null,
    [selectedConflictFile, unresolvedConflicts],
  );

  const activeConflict = useMemo(
    () => selectedUnresolvedConflict || unresolvedConflicts[0] || null,
    [selectedUnresolvedConflict, unresolvedConflicts],
  );

  useEffect(() => {
    if (conflictedFiles.length === 0) {
      return;
    }

    if (unresolvedConflicts.length === 0) {
      if (selectedConflictFile !== null) {
        onSelectFile(null);
      }
      return;
    }

    if (activeConflict && activeConflict.path !== selectedConflictFile) {
      onSelectFile(activeConflict.path);
    }
  }, [
    activeConflict,
    conflictedFiles.length,
    onSelectFile,
    selectedConflictFile,
    unresolvedConflicts,
  ]);
  const activeDecisionIndex = activeConflict
    ? conflictedFiles.findIndex((file) => file.path === activeConflict.path) + 1
    : 0;

  if (!activeConflict) {
    return (
      <div className="h-full min-h-[28rem] flex items-center justify-center">
        <div className="text-center max-w-md">
          <CheckCircle2 style={iconLg} className="mx-auto mb-4 text-green-400" />
          <p className="text-theme-primary text-lg font-medium mb-2">All decisions are complete</p>
          <p className="text-theme-secondary text-sm">IOFabrik is updating your work now. Keep this project open.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)] h-full min-h-[28rem]">
      <Card className="min-h-0">
        <CardContent className="p-0 h-full flex flex-col">
          <div className="border-b border-theme-default px-4 py-3">
            <div className="flex items-center justify-between gap-3 mb-1">
              <p className="text-theme-primary text-sm font-medium">Decision queue</p>
              <Badge variant="warning">{unresolvedConflicts.length} waiting</Badge>
            </div>
            <p className="text-theme-secondary text-xs">{activeDecisionIndex} of {conflictedFiles.length} decisions</p>
          </div>

          <div className="flex-1 overflow-auto p-2 space-y-1">
            {conflictedFiles.map((file, index) => {
              const isCurrent = file.path === activeConflict.path;
              const isResolved = Boolean(fileResolutions[file.path]);
              const resolution = fileResolutions[file.path];

              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onSelectFile(file.path)}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                    isCurrent
                      ? 'border-blue-500/40 bg-blue-500/5'
                      : isResolved
                        ? 'border-green-500/20 bg-green-500/5'
                        : 'border-transparent hover:border-theme-default hover:bg-theme-muted/10'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-theme-primary text-sm break-all">{index + 1}. {file.path}</p>
                      <p className="mt-1 text-theme-muted text-xs">{CONFLICT_STATUS_LABELS[file.status]}</p>
                    </div>
                    <Badge variant={isCurrent ? 'info' : isResolved ? 'success' : 'outline'}>
                      {isCurrent ? 'Current' : isResolved ? 'Resolved' : 'Waiting'}
                    </Badge>
                  </div>
                  {resolution && (
                    <div className="mt-2 inline-flex items-center gap-1 text-xs text-theme-secondary">
                      <Check style={{ width: 12, height: 12 }} className="text-green-400" />
                      Keeping {resolution === 'mine' ? sourceBranch : targetBranch}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="min-h-0 min-w-0">
        <ConflictResolverPane
          file={activeConflict}
          data={resolutionData?.path === activeConflict.path ? resolutionData : undefined}
          draft={conflictDraft?.path === activeConflict.path ? conflictDraft : undefined}
          isLoading={isLoadingResolutionData}
          loadError={resolutionLoadError}
          applyError={resolutionApplyError}
          disabled={isResolvingConflict}
          onDecision={onConflictDecision}
          onApply={onResolveWithDecisions}
          onResolveWholeFile={(strategy) => onResolve(activeConflict.path, strategy)}
        />
      </div>
    </div>
  );
}

export default memo(ConflictQueue);