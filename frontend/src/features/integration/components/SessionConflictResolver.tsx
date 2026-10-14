import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ConflictKind,
  type ConflictQueueEntry,
} from '../../../../bindings/iofabrik/services/models';
import type { ResolutionStrategy } from '../../../domain/repo/context/RepoContext.types';
import ConflictQueue, {
  type ConflictQueueFile,
} from '../../conflict/components/modal/ConflictQueue';
import type {
  ConflictRegionDecision,
  ConflictResolutionData,
  TextConflictDraft,
} from '../../conflict/types';
import { useIntegrationSession } from '../context/IntegrationSessionContext';

function toConflictedFile(entry: ConflictQueueEntry): ConflictQueueFile {
  switch (entry.kind) {
    case ConflictKind.ConflictKindBothAdded:
    case ConflictKind.ConflictKindAddedByUs:
    case ConflictKind.ConflictKindAddedByThem:
    case ConflictKind.ConflictKindDeletedByUs:
    case ConflictKind.ConflictKindDeletedByThem:
    case ConflictKind.ConflictKindBothDeleted:
    case ConflictKind.ConflictKindBothModified:
      return { path: entry.path, status: entry.kind };
    default:
      return { path: entry.path, status: 'both-modified' };
  }
}

function createDraft(data: ConflictResolutionData): TextConflictDraft | undefined {
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

function SessionConflictResolver(): JSX.Element {
  const {
    session,
    entries,
    isBusy,
    loadConflictResolutionData,
    resolveConflictWithDecisions,
    resolveConflictWithSide,
  } = useIntegrationSession();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [resolutionData, setResolutionData] = useState<ConflictResolutionData>();
  const [draft, setDraft] = useState<TextConflictDraft>();
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [applyError, setApplyError] = useState('');
  const loadGenerationRef = useRef(0);

  const conflictedFiles = useMemo(() => entries.map(toConflictedFile), [entries]);

  useEffect(() => {
    loadGenerationRef.current += 1;
    setSelectedPath(entries[0]?.path ?? null);
    setResolutionData(undefined);
    setDraft(undefined);
    setLoadError('');
    setApplyError('');
  }, [session?.sessionId]); // entries belong to the captured session at this transition.

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const loadGeneration = ++loadGenerationRef.current;
    setIsLoading(true);
    setResolutionData(undefined);
    setDraft(undefined);
    setLoadError('');
    setApplyError('');

    void loadConflictResolutionData(selectedPath).then((data) => {
      if (loadGeneration !== loadGenerationRef.current) {
        return;
      }
      if (!data) {
        setLoadError('The file details could not be loaded.\nRefresh the review and try again.');
        return;
      }
      setResolutionData(data);
      setDraft(data.eligible ? createDraft(data) : undefined);
    }).finally(() => {
      if (loadGeneration === loadGenerationRef.current) {
        setIsLoading(false);
      }
    });
  }, [selectedPath, loadConflictResolutionData]);

  const handleDecision = useCallback((
    regionId: string,
    decision: ConflictRegionDecision,
  ): void => {
    setDraft((current) => current
      ? { ...current, decisions: { ...current.decisions, [regionId]: decision } }
      : current);
    setApplyError('');
  }, []);

  const clearResolvedFile = useCallback((): void => {
    loadGenerationRef.current += 1;
    setSelectedPath(null);
    setResolutionData(undefined);
    setDraft(undefined);
    setApplyError('');
  }, []);

  const handleResolveWithDecisions = useCallback(async (): Promise<void> => {
    if (!selectedPath || !draft) {
      return;
    }

    setApplyError('');
    const result = await resolveConflictWithDecisions(
      selectedPath,
      draft.resolutionToken,
      draft.decisions,
    );
    if (!result?.success) {
      setApplyError(result?.error || result?.message
        || 'The choices could not be applied.\nReview them and try again.');
      return;
    }
    clearResolvedFile();
  }, [selectedPath, draft, resolveConflictWithDecisions, clearResolvedFile]);

  const handleResolveWholeFile = useCallback(async (
    filePath: string,
    strategy: ResolutionStrategy,
  ): Promise<void> => {
    setApplyError('');
    const result = await resolveConflictWithSide(filePath, strategy);
    if (!result?.success) {
      setApplyError(result?.error || result?.message
        || 'The file choice could not be applied.\nChoose a version and try again.');
      return;
    }
    clearResolvedFile();
  }, [resolveConflictWithSide, clearResolvedFile]);

  return (
    <ConflictQueue
      conflictedFiles={conflictedFiles}
      selectedConflictFile={selectedPath}
      fileResolutions={{}}
      isResolvingConflict={isBusy}
      sourceBranch={session?.sourceBranch ?? 'Current'}
      targetBranch={session?.targetBranch ?? 'Incoming'}
      onSelectFile={setSelectedPath}
      onResolve={handleResolveWholeFile}
      resolutionData={resolutionData}
      conflictDraft={draft}
      isLoadingResolutionData={isLoading}
      resolutionLoadError={loadError || undefined}
      resolutionApplyError={applyError || undefined}
      onConflictDecision={handleDecision}
      onResolveWithDecisions={handleResolveWithDecisions}
    />
  );
}

export default SessionConflictResolver;