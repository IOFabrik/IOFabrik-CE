import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  GetProjectDefaultBranch,
  RefreshProjectDefaultBranch,
  SetProjectDefaultBranch,
  UseGitHubDefault,
} from '../../../../bindings/iofabrik/services/repositorysettingsservice';
import type { ProjectDefaultBranchResult } from '../../../../bindings/iofabrik/services/models';

export interface ProjectDefaultBranchPrompt {
  repoPath: string;
  choices: string[];
  effectiveBranch: string;
}

interface RepositorySession { path: string | null }
interface PendingSelection {
  session: RepositorySession;
  promise: Promise<string | null>;
  resolve: (branch: string | null) => void;
}

// State belongs to RepoContext. The session identity rejects late responses,
// including closing and reopening the same folder while a request is pending.
export function useProjectDefaultBranch(repoPath: string | null, sessionRef: MutableRefObject<RepositorySession>) {
  const [projectDefaultBranch, setProjectDefaultBranch] = useState<ProjectDefaultBranchResult | null>(null);
  const [projectDefaultBranchPrompt, setPrompt] = useState<ProjectDefaultBranchPrompt | null>(null);
  const [projectDefaultBranchError, setError] = useState('');
  const [isLoadingProjectDefaultBranch, setLoading] = useState(false);
  const [isSavingProjectDefaultBranch, setSaving] = useState(false);
  const pending = useRef<PendingSelection | null>(null);
  const loadingRequest = useRef(0);

  const cancelProjectDefaultBranchSelection = useCallback(() => {
    pending.current?.resolve(null);
    pending.current = null;
    setPrompt(null);
    setError('');
  }, []);

  const clearProjectDefaultBranch = useCallback(() => {
    loadingRequest.current += 1;
    cancelProjectDefaultBranchSelection();
    setProjectDefaultBranch(null);
    setLoading(false);
    setSaving(false);
  }, [cancelProjectDefaultBranchSelection]);

  useEffect(() => {
    clearProjectDefaultBranch();
    return () => { pending.current?.resolve(null); pending.current = null; };
  }, [repoPath, clearProjectDefaultBranch]);

  const refreshProjectDefaultBranch = useCallback(async (discover = false, pathOverride?: string): Promise<ProjectDefaultBranchResult | null> => {
    const session = sessionRef.current;
    const path = pathOverride || repoPath;
    if (!path || session.path !== path) return null;
    const request = ++loadingRequest.current;
    setLoading(true);
    try {
      const result = await (discover ? RefreshProjectDefaultBranch(path) : GetProjectDefaultBranch(path));
      if (session !== sessionRef.current) return null;
      // A newer refresh may own the displayed state, but this invocation still
      // returns its locally validated result to the waiting chooser/action.
      if (request === loadingRequest.current) setProjectDefaultBranch(result);
      return result;
    } catch {
      if (session === sessionRef.current && request === loadingRequest.current) {
        setProjectDefaultBranch(null);
        setError('The default branch could not be checked. Try refreshing the project.');
      }
      return null;
    } finally {
      if (session === sessionRef.current && request === loadingRequest.current) setLoading(false);
    }
  }, [repoPath, sessionRef]);

  const chooseProjectDefaultBranch = useCallback(async (): Promise<string | null> => {
    const session = sessionRef.current;
    if (!repoPath || session.path !== repoPath) return null;
    if (pending.current?.session === session) return pending.current.promise;
    const result = await refreshProjectDefaultBranch();
    if (!result || session !== sessionRef.current) return null;
    // Two entry points may have awaited the same local validation.
    if (pending.current?.session === session) return pending.current.promise;
    cancelProjectDefaultBranchSelection();
    let resolve!: (branch: string | null) => void;
    const promise = new Promise<string | null>(done => { resolve = done; });
    pending.current = { session, promise, resolve };
    setPrompt({ repoPath, choices: result.choices, effectiveBranch: result.effectiveBranch });
    return promise;
  }, [repoPath, sessionRef, refreshProjectDefaultBranch, cancelProjectDefaultBranchSelection]);

  const ensureProjectDefaultBranch = useCallback(async (): Promise<string | null> => {
    const result = await refreshProjectDefaultBranch();
    return result?.availability === 'ready' ? result.effectiveBranch : chooseProjectDefaultBranch();
  }, [refreshProjectDefaultBranch, chooseProjectDefaultBranch]);

  const submitProjectDefaultBranch = useCallback(async (branch: string): Promise<boolean> => {
    const selection = pending.current;
    if (!selection || selection.session !== sessionRef.current || !selection.session.path) return false;
    setSaving(true);
    setError('');
    try {
      const saved = await SetProjectDefaultBranch(selection.session.path, branch);
      if (selection !== pending.current || selection.session !== sessionRef.current) return false;
      if (!saved.success) {
        setError(saved.error || 'The default branch could not be saved. Try again.');
        return false;
      }
      const result = await refreshProjectDefaultBranch();
      if (selection !== pending.current || selection.session !== sessionRef.current) return false;
      if (result?.availability !== 'ready') {
        setError('The selected branch is unavailable. Refresh and choose another branch.');
        return false;
      }
      selection.resolve(result.effectiveBranch);
      pending.current = null;
      setPrompt(null);
      return true;
    } catch {
      if (selection === pending.current && selection.session === sessionRef.current) {
        setError('The default branch could not be saved. Try again.');
      }
      return false;
    } finally {
      if (selection.session === sessionRef.current) setSaving(false);
    }
  }, [sessionRef, refreshProjectDefaultBranch]);

  const useGitHubDefaultBranch = useCallback(async (): Promise<boolean> => {
    const session = sessionRef.current;
    if (!repoPath || session.path !== repoPath) return false;
    setSaving(true);
    setError('');
    try {
      const result = await UseGitHubDefault(repoPath);
      if (session !== sessionRef.current) return false;
      if (!result.success) setError(result.error || 'GitHub’s default is unavailable. Try refreshing.');
      await refreshProjectDefaultBranch();
      return result.success;
    } catch {
      if (session === sessionRef.current) setError('GitHub’s default is unavailable. Try refreshing.');
      return false;
    } finally {
      if (session === sessionRef.current) setSaving(false);
    }
  }, [repoPath, sessionRef, refreshProjectDefaultBranch]);

  return useMemo(() => ({
    projectDefaultBranch, projectDefaultBranchPrompt, projectDefaultBranchError,
    isLoadingProjectDefaultBranch, isSavingProjectDefaultBranch,
    refreshProjectDefaultBranch, chooseProjectDefaultBranch, ensureProjectDefaultBranch,
    submitProjectDefaultBranch, cancelProjectDefaultBranchSelection, useGitHubDefaultBranch,
    clearProjectDefaultBranch,
  }), [projectDefaultBranch, projectDefaultBranchPrompt, projectDefaultBranchError,
    isLoadingProjectDefaultBranch, isSavingProjectDefaultBranch,
    refreshProjectDefaultBranch, chooseProjectDefaultBranch, ensureProjectDefaultBranch,
    submitProjectDefaultBranch, cancelProjectDefaultBranchSelection, useGitHubDefaultBranch,
    clearProjectDefaultBranch]);
}
