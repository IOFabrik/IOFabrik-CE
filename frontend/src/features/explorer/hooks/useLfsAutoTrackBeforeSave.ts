import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GetTrackedPatterns, TrackPattern } from '../../../../bindings/iofabrik/services/lfsservice';
import { useRepo, type FileStatus } from '../../../context';
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

interface PendingSave {
  action: () => Promise<boolean>;
  onSuccess?: () => void;
}

export function useLfsAutoTrackBeforeSave({
  repoPath,
  changedFiles,
}: UseLfsAutoTrackBeforeSaveOptions): UseLfsAutoTrackBeforeSaveResult {
  const { ensureProjectDefaultBranch } = useRepo();
  const activeSession = useRef({ repoPath });
  if (activeSession.current.repoPath !== repoPath) activeSession.current = { repoPath };
  const mounted = useRef(true);
  const preparing = useRef(false);
  const applying = useRef(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [candidates, setCandidates] = useState<LFSAutoTrackCandidate[]>([]);
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = useState(false);

  const pendingSaveRef = useRef<PendingSave | null>(null);

  useEffect(() => {
    activeSession.current = { repoPath };
    const session = activeSession.current;
    mounted.current = true;
    setModalOpen(false);
    setCandidates([]);
    setSelectedFilePaths(new Set());
    return () => {
      mounted.current = false;
      if (activeSession.current === session) activeSession.current = { repoPath: undefined };
      pendingSaveRef.current = null;
    };
  }, [repoPath]);

  const runPendingSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (!pending) {
      return;
    }

    pendingSaveRef.current = null;

    // RepoContext validates the repository session through completion. A clean
    // status can unmount this panel during that refresh; successful follow-up
    // actions (conflict checks and remembered choices) must still run.
    const success = await pending.action();
    if (success) {
      pending.onSuccess?.();
    }
  }, []);

  const runBeforeSave = useCallback(async (saveAction: () => Promise<boolean>, onSuccess?: () => void): Promise<void> => {
    if (preparing.current || pendingSaveRef.current) return;
    preparing.current = true;
    try {
      const session = activeSession.current;
      if (!await ensureProjectDefaultBranch() || !mounted.current || session !== activeSession.current) return;
      pendingSaveRef.current = { action: saveAction, onSuccess };

      if (!repoPath) {
        await runPendingSave();
        return;
      }

      try {
        const trackedPatterns = await GetTrackedPatterns(repoPath).catch(() => []);
        if (!mounted.current || session !== activeSession.current) return;
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
    } finally {
      preparing.current = false;
    }
  }, [changedFiles, repoPath, runPendingSave, ensureProjectDefaultBranch]);

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
    pendingSaveRef.current = null;
  }, []);

  const confirmAndContinue = useCallback(async (): Promise<void> => {
    const pending = pendingSaveRef.current;
    if (applying.current || !pending) return;
    applying.current = true;
    try {
      const session = activeSession.current;
      if (!await ensureProjectDefaultBranch() || !mounted.current || session !== activeSession.current) return;
      // Cancel can run while readiness is pending. A later Save, even with the
      // same callback, needs its own confirmation before changing attributes.
      if (pending !== pendingSaveRef.current) return;
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
          if (!mounted.current || session !== activeSession.current || pending !== pendingSaveRef.current) return;
          const result = await TrackPattern(repoPath, pattern);
          if (!result.success) {
            toast.error(result.error || `Failed to track ${pattern}`);
            setIsApplying(false);
            return;
          }
        }
        if (!mounted.current || session !== activeSession.current || pending !== pendingSaveRef.current) return;

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
    } finally {
      applying.current = false;
    }
  }, [candidates, repoPath, runPendingSave, selectedFilePaths, ensureProjectDefaultBranch]);

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
