import { memo, useCallback, useEffect, useState } from 'react';
import { DiffCommitFileRaw, ShowCommit } from '../../../../bindings/iofabrik/services/gitservice';
import { useRepo, type CommitDetail, type FileDiff } from '../../../context';
import LoadingState from '../../../shared/ui/LoadingState';
import CommitOverviewPanel from '../../history/components/CommitOverviewPanel';

interface ExplorerCommitTabContentProps {
  commitHash: string;
}

function ExplorerCommitTabContent({ commitHash }: ExplorerCommitTabContentProps): JSX.Element {
  const {
    repoPath,
    graphCommits,
    branches,
    repoStatus,
    repoInfo,
    revertCommit,
  } = useRepo();
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [currentDiff, setCurrentDiff] = useState<FileDiff | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadCommit = async (): Promise<void> => {
      if (!repoPath || !commitHash) {
        setCommit(null);
        setLoadError('No repository open');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setLoadError(null);
      setSelectedFilePath(null);
      setCurrentDiff(null);

      try {
        const detail = await ShowCommit(repoPath, commitHash);
        if (cancelled) {
          return;
        }

        if (detail.hasError) {
          setCommit(null);
          setLoadError(detail.error || 'Failed to load commit');
          return;
        }

        setCommit(detail as CommitDetail);
      } catch (err) {
        if (cancelled) {
          return;
        }

        const error = err as Error;
        setCommit(null);
        setLoadError(error.message || 'Failed to load commit');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadCommit();

    return () => {
      cancelled = true;
    };
  }, [repoPath, commitHash]);

  const handleSelectFile = useCallback(async (filePath: string): Promise<void> => {
    if (!repoPath || !commit) {
      return;
    }

    setIsDiffLoading(true);
    setSelectedFilePath(filePath);

    try {
      const diff = await DiffCommitFileRaw(repoPath, commit.hash, filePath);
      setCurrentDiff(diff as FileDiff);
    } catch (err) {
      const error = err as Error;
      setCurrentDiff({ hasError: true, error: error.message || 'Failed to load diff' } as FileDiff);
    } finally {
      setIsDiffLoading(false);
    }
  }, [repoPath, commit]);

  const handleBackToCommit = useCallback((): void => {
    setSelectedFilePath(null);
    setCurrentDiff(null);
  }, []);

  if (isLoading) {
    return <LoadingState />;
  }

  if (!commit || loadError) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center">
        <div>
          <p className="text-theme-primary text-sm font-medium">Unable to load snapshot</p>
          <p className="text-theme-muted text-sm mt-1">{loadError || 'This commit is no longer available.'}</p>
        </div>
      </div>
    );
  }

  return (
    <CommitOverviewPanel
      repoPath={repoPath}
      commit={commit}
      graphCommits={graphCommits}
      branches={branches}
      repoStatus={repoStatus}
      repoInfo={repoInfo}
      selectedFilePath={selectedFilePath}
      currentDiff={currentDiff}
      isDiffLoading={isDiffLoading}
      onSelectFile={handleSelectFile}
      onBackToCommit={handleBackToCommit}
      onRestoreCommit={revertCommit}
    />
  );
}

export default memo(ExplorerCommitTabContent);