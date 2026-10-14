/** IntegrationSessionContext mirrors the opted-in update for the open project. */
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
  CancelSession,
  GetSessionConflictResolutionData,
  GetSessionConflicts,
  ListSessions,
  ResolveSessionConflictWithContent,
  ResolveSessionConflictWithDecisions,
  ResolveSessionConflictWithSide,
  ShareSession,
  UpdateFeatureFromDestination,
} from '../../../../bindings/iofabrik/services/integrationsessionservice';
import type {
  ConflictQueueEntry,
  IntegrationSessionSnapshot,
  OperationResult,
  SessionConflictSnapshot,
} from '../../../../bindings/iofabrik/services/models';
import { useRepo } from '../../../context';
import { onEvent } from '../../../shared/runtime/events';
import {
  mapConflictResolutionData,
  toConflictDecisionPayload,
  type ConflictRegionDecision,
  type ConflictResolutionData,
} from '../../conflict/types';

/** States a review can still be acted on from. */
export const SESSION_NEEDS_DECISIONS = 'needs-decisions';

const FINISHED_STATES = new Set(['shared', 'completed', 'cancelled', 'obsolete']);
const SAVE_BLOCKING_STATES = new Set([
  'fetching',
  'starting',
  'needs-decisions',
  'committing',
  'sharing',
  'cancelling',
  'failed',
]);

function isVisibleSession(snapshot: IntegrationSessionSnapshot): boolean {
  if (!snapshot.sessionId || FINISHED_STATES.has(snapshot.state)) {
    return false;
  }
  return snapshot.state === 'failed' || snapshot.active;
}

interface IntegrationSessionContextValue {
  /** True when the session path is the active source of conflict decisions. */
  enabled: boolean;
  /** The review for the open project, or null when there isn't one. */
  session: IntegrationSessionSnapshot | null;
  /** Files this review is asking about. Empty unless it needs decisions. */
  entries: ConflictQueueEntry[];
  /** Set when the last scan failed. */
  error: string | null;
  /** True while a readiness action is running. */
  isBusy: boolean;
  /** True while saving would interfere with the active update. */
  isSaveBlocked: boolean;
  /** Fetch shared work and update the checked-out feature. */
  startUpdate: () => Promise<IntegrationSessionSnapshot | null>;
  /** Push the unchanged completed feature revision after confirmation. */
  shareUpdate: () => Promise<OperationResult | null>;
  /** Abort an interrupted update and restore the feature. */
  cancelUpdate: () => Promise<OperationResult | null>;
  /** Re-read the review and its files from the backend. */
  refresh: () => Promise<void>;
  /** Load one session file for the existing conflict visualizer. */
  loadConflictResolutionData: (filePath: string) => Promise<ConflictResolutionData | null>;
  /** Apply section-by-section choices to one session file. */
  resolveConflictWithDecisions: (
    filePath: string,
    token: string,
    decisions: Record<string, ConflictRegionDecision>,
  ) => Promise<OperationResult | null>;
  /** Apply fully composed content to one session file. */
  resolveConflictWithContent: (
    filePath: string,
    token: string,
    content: string,
  ) => Promise<OperationResult | null>;
  /** Keep one complete version of a session file. */
  resolveConflictWithSide: (filePath: string, side: string) => Promise<OperationResult | null>;
}

const EMPTY_ENTRIES: ConflictQueueEntry[] = [];

/**
 * Without a provider there is no review, so surfaces that read this render
 * nothing rather than crashing the view that hosts them.
 */
const NO_SESSION: IntegrationSessionContextValue = {
  enabled: false,
  session: null,
  entries: EMPTY_ENTRIES,
  error: null,
  isBusy: false,
  isSaveBlocked: false,
  startUpdate: async () => null,
  shareUpdate: async () => null,
  cancelUpdate: async () => null,
  refresh: async () => {},
  loadConflictResolutionData: async () => null,
  resolveConflictWithDecisions: async () => null,
  resolveConflictWithContent: async () => null,
  resolveConflictWithSide: async () => null,
};

const IntegrationSessionContext = createContext<IntegrationSessionContextValue>(NO_SESSION);

interface IntegrationSessionProviderProps {
  children: ReactNode;
}

export function IntegrationSessionProvider({ children }: IntegrationSessionProviderProps): JSX.Element {
  const { repoPath, refreshAll } = useRepo();
  const enabled = Boolean(repoPath);

  const [session, setSession] = useState<IntegrationSessionSnapshot | null>(null);
  const [conflicts, setConflicts] = useState<SessionConflictSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // Event handlers need the session identity as it is now, not as it was when
  // the handler was created.
  const sessionIdRef = useRef('');
  const scannedAtRef = useRef(0);
  const activeRepoPathRef = useRef('');
  const latestRepoPathRef = useRef(repoPath);
  const refreshGenerationRef = useRef(0);
  latestRepoPathRef.current = repoPath;

  const applySession = useCallback((
    incoming: IntegrationSessionSnapshot | null,
    ownerRepoPath = '',
  ): void => {
    const current = incoming && isVisibleSession(incoming) ? incoming : null;

    if (current?.sessionId !== sessionIdRef.current) {
      sessionIdRef.current = current?.sessionId ?? '';
      scannedAtRef.current = 0;
      setConflicts(null);
    }
    activeRepoPathRef.current = current ? ownerRepoPath : '';
    setSession(current);
  }, []);

  /**
   * Applies a scan if it belongs to the review we are showing and is newer than
   * the one already held, which drops late and duplicated events without
   * needing to know which call or event produced them.
   */
  const applyConflicts = useCallback((incoming: SessionConflictSnapshot | null): void => {
    if (!incoming?.sessionId || incoming.sessionId !== sessionIdRef.current) {
      return;
    }
    if (incoming.scannedAt <= scannedAtRef.current) {
      return;
    }
    scannedAtRef.current = incoming.scannedAt;
    setConflicts(incoming);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (latestRepoPathRef.current !== repoPath) {
      return;
    }
    const generation = ++refreshGenerationRef.current;
    if (!enabled || !repoPath) {
      applySession(null);
      return;
    }
    const requestedRepoPath = repoPath;
    if (activeRepoPathRef.current && activeRepoPathRef.current !== requestedRepoPath) {
      applySession(null);
    }

    try {
      const sessions = await ListSessions(repoPath);
      if (generation !== refreshGenerationRef.current || latestRepoPathRef.current !== requestedRepoPath) {
        return;
      }
      // The store lists oldest first, so the newest live review is the last one.
      const current = [...sessions].reverse().find(isVisibleSession) ?? null;
      applySession(current, requestedRepoPath);

      if (current?.state === SESSION_NEEDS_DECISIONS) {
        const incoming = await GetSessionConflicts(current.sessionId);
        if (generation === refreshGenerationRef.current && latestRepoPathRef.current === requestedRepoPath) {
          applyConflicts(incoming);
        }
      }
    } catch {
      // The backend holds the authoritative state and any error worth showing
      // arrives on a snapshot, so a failed read needs no local handling.
    }
  }, [enabled, repoPath, applySession, applyConflicts]);

  useEffect(() => {
    setIsBusy(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unsubscribe = onEvent(
      'integrationSession:changed',
      (event: { data: IntegrationSessionSnapshot }) => {
        if (latestRepoPathRef.current !== repoPath) {
          return;
        }
        // A snapshot for a review we don't know about means a new one was
        // prepared, so re-read rather than guessing it belongs to this project.
        if (
          activeRepoPathRef.current === repoPath
          && event.data?.sessionId
          && event.data.sessionId === sessionIdRef.current
        ) {
          applySession(event.data, repoPath);
          return;
        }
        void refresh();
      },
    );
    return () => unsubscribe();
  }, [enabled, repoPath, applySession, refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unsubscribe = onEvent(
      'integrationSession:conflicts',
      (event: { data: SessionConflictSnapshot }) => {
        if (latestRepoPathRef.current === repoPath) {
          applyConflicts(event.data);
        }
      },
    );
    return () => unsubscribe();
  }, [enabled, repoPath, applyConflicts]);

  const runSessionAction = useCallback(
    async (action: (sessionId: string) => Promise<OperationResult>): Promise<OperationResult | null> => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || activeRepoPathRef.current !== repoPath) {
        return null;
      }

      setIsBusy(true);
      try {
        return await action(sessionId);
      } catch {
        return null;
      } finally {
        if (latestRepoPathRef.current === repoPath) {
          setIsBusy(false);
        }
        await refresh();
      }
    },
    [repoPath, refresh],
  );

  const startUpdate = useCallback(async (): Promise<IntegrationSessionSnapshot | null> => {
    if (!enabled || !repoPath) {
      return null;
    }

    const generation = ++refreshGenerationRef.current;
    const requestedRepoPath = repoPath;
    setIsBusy(true);
    try {
      await UpdateFeatureFromDestination(repoPath);
      const sessions = await ListSessions(repoPath);
      if (generation !== refreshGenerationRef.current || latestRepoPathRef.current !== requestedRepoPath) {
        return null;
      }
      const updated = [...sessions].reverse().find(isVisibleSession) ?? null;
      if (!updated) {
        return null;
      }

      applySession(updated, requestedRepoPath);
      if (updated.state === SESSION_NEEDS_DECISIONS) {
        const incoming = await GetSessionConflicts(updated.sessionId);
        if (generation === refreshGenerationRef.current && latestRepoPathRef.current === requestedRepoPath) {
          applyConflicts(incoming);
        }
      }
      return updated;
    } catch {
      return null;
    } finally {
      if (latestRepoPathRef.current === requestedRepoPath) {
        setIsBusy(false);
      }
    }
  }, [enabled, repoPath, applySession, applyConflicts]);

  const shareUpdate = useCallback(async (): Promise<OperationResult | null> => {
    const result = await runSessionAction(ShareSession);
    if (result?.success && latestRepoPathRef.current === repoPath) {
      await refreshAll();
    }
    return result;
  }, [repoPath, refreshAll, runSessionAction]);

  const cancelUpdate = useCallback(
    () => runSessionAction(CancelSession),
    [runSessionAction],
  );

  const loadConflictResolutionData = useCallback(async (
    filePath: string,
  ): Promise<ConflictResolutionData | null> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !filePath) {
      return null;
    }

    try {
      return mapConflictResolutionData(await GetSessionConflictResolutionData(sessionId, filePath));
    } catch {
      return null;
    }
  }, []);

  const resolveConflictWithDecisions = useCallback((
    filePath: string,
    token: string,
    decisions: Record<string, ConflictRegionDecision>,
  ): Promise<OperationResult | null> => runSessionAction((sessionId) => (
    ResolveSessionConflictWithDecisions(
      sessionId,
      filePath,
      token,
      toConflictDecisionPayload(decisions),
    )
  )), [runSessionAction]);

  const resolveConflictWithContent = useCallback((
    filePath: string,
    token: string,
    content: string,
  ): Promise<OperationResult | null> => runSessionAction((sessionId) => (
    ResolveSessionConflictWithContent(sessionId, filePath, token, content)
  )), [runSessionAction]);

  const resolveConflictWithSide = useCallback((
    filePath: string,
    side: string,
  ): Promise<OperationResult | null> => runSessionAction((sessionId) => (
    ResolveSessionConflictWithSide(sessionId, filePath, side)
  )), [runSessionAction]);

  const value = useMemo<IntegrationSessionContextValue>(() => {
    const needsDecisions = session?.state === SESSION_NEEDS_DECISIONS;

    return {
      enabled,
      session,
      entries: needsDecisions && conflicts ? conflicts.entries : EMPTY_ENTRIES,
      error: conflicts?.error ? conflicts.error : null,
      isBusy,
      isSaveBlocked: Boolean(session?.state && SAVE_BLOCKING_STATES.has(session.state)),
      startUpdate,
      shareUpdate,
      cancelUpdate,
      refresh,
      loadConflictResolutionData,
      resolveConflictWithDecisions,
      resolveConflictWithContent,
      resolveConflictWithSide,
    };
  }, [
    enabled,
    session,
    conflicts,
    isBusy,
    startUpdate,
    shareUpdate,
    cancelUpdate,
    refresh,
    loadConflictResolutionData,
    resolveConflictWithDecisions,
    resolveConflictWithContent,
    resolveConflictWithSide,
  ]);

  return (
    <IntegrationSessionContext.Provider value={value}>
      {children}
    </IntegrationSessionContext.Provider>
  );
}

export function useIntegrationSession(): IntegrationSessionContextValue {
  return useContext(IntegrationSessionContext);
}
