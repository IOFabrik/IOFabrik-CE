import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GetTrackedPatterns, TrackPattern } from '../../../../bindings/iofabrik/services/lfsservice';
import type { FileStatus } from '../../../context';
import { getLFSAutoTrackCandidates, type LFSAutoTrackCandidate } from '../../../domain/repo/services/lfs-auto-track';

interface UseLfsAutoTrackBeforeSaveOptions {
  repoPath?: string;
  changedFiles: FileStatus[];
}

interface UseLfsAutoTrackBeforeSaveResult {
  modalOpen: boolean;
  candidates: LFSAutoTrackCandidate[];
  selectedFilePaths: Set<string>;
  isApplying: boolean;
  runBeforeSave: (saveAction: () => Promise<boolean>, onSuccess?: () => void) => Promise<void>;
  toggleCandidate: (filePath: string) => void;
  toggleSelectAll: () => void;
  cancelModal: () => void;
  confirmAndContinue: () => Promise<void>;
}

export function useLfsAutoTrackBeforeSave({
  repoPath,
  changedFiles,
}: UseLfsAutoTrackBeforeSaveOptions): UseLfsAutoTrackBeforeSaveResult {
  const [modalOpen, setModalOpen] = useState(false);
  const [candidates, setCandidates] = useState<LFSAutoTrackCandidate[]>([]);
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = useState(false);

  const pendingSaveActionRef = useRef<(() => Promise<boolean>) | null>(null);
  const pendingOnSuccessRef = useRef<(() => void) | null>(null);

  const runPendingSave = useCallback(async () => {
    const action = pendingSaveActionRef.current;
    if (!action) {
      return;
    }

    const success = await action();
    if (success) {
      pendingOnSuccessRef.current?.();
    }

    pendingSaveActionRef.current = null;
    pendingOnSuccessRef.current = null;
  }, []);

  const runBeforeSave = useCallback(async (saveAction: () => Promise<boolean>, onSuccess?: () => void): Promise<void> => {
    pendingSaveActionRef.current = saveAction;
    pendingOnSuccessRef.current = onSuccess ?? null;

    if (!repoPath) {
      await runPendingSave();
      return;
    }

    try {
      const trackedPatterns = await GetTrackedPatterns(repoPath).catch(() => []);
      const autoTrackCandidates = getLFSAutoTrackCandidates(changedFiles, trackedPatterns || []);

      if (autoTrackCandidates.length === 0) {
        await runPendingSave();
        return;
      }

      setCandidates(autoTrackCandidates);
      setSelectedFilePaths(new Set(autoTrackCandidates.map(c => c.filePath)));
      setModalOpen(true);
    } catch (err) {
      console.warn('Failed to prepare LFS auto-track candidates:', err);
      await runPendingSave();
    }
  }, [changedFiles, repoPath, runPendingSave]);

  const toggleCandidate = useCallback((filePath: string): void => {
    setSelectedFilePaths(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((): void => {
    setSelectedFilePaths(prev => {
      if (prev.size === candidates.length) {
        return new Set();
      }
      return new Set(candidates.map(c => c.filePath));
    });
  }, [candidates]);

  const cancelModal = useCallback((): void => {
    setModalOpen(false);
    setCandidates([]);
    setSelectedFilePaths(new Set());
    pendingSaveActionRef.current = null;
    pendingOnSuccessRef.current = null;
  }, []);

  const confirmAndContinue = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      setModalOpen(false);
      await runPendingSave();
      return;
    }

    setIsApplying(true);
    try {
      const selectedCandidates = candidates.filter(c => selectedFilePaths.has(c.filePath));
      const uniquePatterns = Array.from(new Set(selectedCandidates.map(c => c.pattern)));

      for (const pattern of uniquePatterns) {
        const result = await TrackPattern(repoPath, pattern);
        if (!result.success) {
          toast.error(result.error || `Failed to track ${pattern}`);
          setIsApplying(false);
          return;
        }
      }

      if (uniquePatterns.length > 0) {
        toast.success(`Tracked ${uniquePatterns.length} LFS pattern${uniquePatterns.length === 1 ? '' : 's'}`);
      }

      setModalOpen(false);
      setCandidates([]);
      setSelectedFilePaths(new Set());
      await runPendingSave();
    } finally {
      setIsApplying(false);
    }
  }, [candidates, repoPath, runPendingSave, selectedFilePaths]);

  return {
    modalOpen,
    candidates,
    selectedFilePaths,
    isApplying,
    runBeforeSave,
    toggleCandidate,
    toggleSelectAll,
    cancelModal,
    confirmAndContinue,
  };
}
