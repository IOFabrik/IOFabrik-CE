/**
 * ConflictQueueContext - live queue of files that still need a conflict decision.
 *
 * The backend ConflictQueueService is the single source of truth: it pushes a
 * full snapshot on `conflictQueue:changed` whenever the repository's unmerged
 * set may have changed. This provider mirrors that snapshot and nothing else.
 *
 * It is intentionally independent of RepoContext's legacy `conflictedFiles`
 * state, which belongs to the conflict resolution workflow being deprecated.
 *
 * Behind Developer Mode the queue reads from the isolated review instead. That
 * source is the only thing that changes: every component below this provider
 * sees the same entries and never learns which source produced them.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ClearRepository,
  Refresh,
  SetRepository,
} from '../../../../bindings/iofabrik/services/conflictqueueservice';
import type {
  ConflictQueueEntry,
  ConflictQueueSnapshot,
} from '../../../../bindings/iofabrik/services/models';
import { useRepo } from '../../../context';
import { useIntegrationSession } from '../../integration';
import { onEvent } from '../../../shared/runtime/events';

interface ConflictQueueContextValue {
  /** Conflicted files for the open repository, sorted by path. */
  entries: ConflictQueueEntry[];
  /** Branch the entries were compared against when they are predicted. */
  targetBranch: string | null;
  /** Set when the last scan failed. `entries` then holds the last good result. */
  error: string | null;
  /** True when there is nothing needing a decision. */
  isEmpty: boolean;
  /** Force a rescan, e.g. after a file is resolved and staged. */
  refresh: () => Promise<void>;
}

const EMPTY_ENTRIES: ConflictQueueEntry[] = [];

/**
 * Without a provider the queue reads as empty, so conflict surfaces render
 * nothing rather than crashing the view that hosts them.
 */
const EMPTY_QUEUE: ConflictQueueContextValue = {
  entries: EMPTY_ENTRIES,
  targetBranch: null,
  error: null,
  isEmpty: true,
  refresh: async () => {},
};

const ConflictQueueContext = createContext<ConflictQueueContextValue>(EMPTY_QUEUE);

interface ConflictQueueProviderProps {
  children: ReactNode;
}

export function ConflictQueueProvider({ children }: ConflictQueueProviderProps): JSX.Element {
  const { repoPath, conflictedFiles } = useRepo();
  const integration = useIntegrationSession();
  const useSessionSource = integration.enabled;
  const [snapshot, setSnapshot] = useState<ConflictQueueSnapshot | null>(null);
  const latestGeneration = useRef(0);

  /**
   * Applies a snapshot if it is newer than the one already held. Generations
   * increase strictly, so this drops late or duplicated events without needing
   * to know which call or event produced them.
   */
  const applySnapshot = useCallback((incoming: ConflictQueueSnapshot | null): void => {
    if (!incoming || incoming.generation <= latestGeneration.current) {
      return;
    }
    latestGeneration.current = incoming.generation;
    setSnapshot(incoming);
  }, []);

  useEffect(() => {
    if (useSessionSource) {
      return;
    }

    const unsubscribe = onEvent('conflictQueue:changed', (event: { data: ConflictQueueSnapshot }) => {
      applySnapshot(event.data);
    });
    return () => unsubscribe();
  }, [useSessionSource, applySnapshot]);

  useEffect(() => {
    let cancelled = false;

    // Unbinding when the review takes over stops the repository queue doing
    // work nobody reads, including the prediction pass.
    const bind = async (): Promise<void> => {
      try {
        const result = repoPath && !useSessionSource
          ? await SetRepository(repoPath)
          : await ClearRepository();
        if (!cancelled) {
          applySnapshot(result);
        }
      } catch {
        // The backend keeps its last good state and any error worth showing
        // arrives on the snapshot, so a failed bind needs no local handling.
      }
    };

    void bind();
    return () => {
      cancelled = true;
    };
  }, [useSessionSource, repoPath, applySnapshot]);

  const refresh = useCallback(async (): Promise<void> => {
    if (useSessionSource) {
      await integration.refresh();
      return;
    }

    try {
      applySnapshot(await Refresh());
    } catch {
      // Same reasoning as bind(): errors arrive on the snapshot.
    }
  }, [useSessionSource, integration, applySnapshot]);

  /**
   * The conflict resolution workflow being deprecated stages resolutions
   * without publishing a repository mutation, so nothing would invalidate the
   * queue. Its own conflicted-file list shrinks as files are resolved, so we
   * treat that as the invalidation signal until that workflow is replaced.
   */
  const legacyConflictCount = conflictedFiles.length;
  useEffect(() => {
    if (useSessionSource || !repoPath) {
      return;
    }
    void refresh();
  }, [useSessionSource, legacyConflictCount, repoPath, refresh]);

  const value = useMemo<ConflictQueueContextValue>(() => {
    if (useSessionSource) {
      // The review reports only real unmerged files, so nothing predicted can
      // reach the resolver and there is no branch to attribute entries to.
      return {
        entries: integration.entries,
        targetBranch: null,
        error: integration.error,
        isEmpty: integration.entries.length === 0,
        refresh,
      };
    }

    // Guard against a snapshot for a repository we are no longer showing.
    const isCurrentRepo = Boolean(repoPath) && snapshot?.repoPath === repoPath;
    const entries = isCurrentRepo && snapshot ? snapshot.entries : EMPTY_ENTRIES;

    return {
      entries,
      targetBranch: isCurrentRepo && snapshot?.targetBranch ? snapshot.targetBranch : null,
      error: isCurrentRepo && snapshot?.error ? snapshot.error : null,
      isEmpty: entries.length === 0,
      refresh,
    };
  }, [useSessionSource, integration.entries, integration.error, repoPath, snapshot, refresh]);

  return <ConflictQueueContext.Provider value={value}>{children}</ConflictQueueContext.Provider>;
}

export function useConflictQueue(): ConflictQueueContextValue {
  return useContext(ConflictQueueContext);
}
