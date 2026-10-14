import { memo, useCallback } from 'react';
import { useRepo } from '../../../context';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../shared/ui';
import LoadingState from '../../../shared/ui/LoadingState';

function ProjectDefaultBranchCard(): JSX.Element {
  const {
    projectDefaultBranch: selection, projectDefaultBranchError,
    isLoadingProjectDefaultBranch, isSavingProjectDefaultBranch,
    chooseProjectDefaultBranch, refreshProjectDefaultBranch, useGitHubDefaultBranch,
  } = useRepo();
  const handleChoose = useCallback(() => { void chooseProjectDefaultBranch(); }, [chooseProjectDefaultBranch]);
  const handleRefresh = useCallback(() => { void refreshProjectDefaultBranch(true); }, [refreshProjectDefaultBranch]);
  const handleAutomatic = useCallback(() => { void useGitHubDefaultBranch(); }, [useGitHubDefaultBranch]);
  const busy = isLoadingProjectDefaultBranch || isSavingProjectDefaultBranch;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Default Branch</CardTitle>
        <CardDescription>
          Choose this project&apos;s default branch for IOFabrik. This preference does not change GitHub&apos;s default or switch your active branch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoadingProjectDefaultBranch && <LoadingState message="Checking default branch..." />}
        <p className="text-sm text-theme-primary">
          Default branch: <strong>{selection?.availability === 'ready' ? selection.effectiveBranch : 'Selection needed'}</strong>
        </p>
        <p className="text-sm text-theme-secondary">
          Selection: {selection?.mode === 'manual' ? 'Manual' : 'Automatic'}
        </p>
        {selection?.lookupMessage && <p className="text-sm text-theme-secondary">{selection.lookupMessage}</p>}
        {projectDefaultBranchError && <p role="alert" className="text-sm text-red-400">{projectDefaultBranchError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={handleChoose} disabled={busy}>Choose default branch</Button>
          <Button variant="secondary" onClick={handleAutomatic} disabled={busy}>Use GitHub default</Button>
          <Button variant="ghost" onClick={handleRefresh} disabled={busy}>Refresh default branch</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default memo(ProjectDefaultBranchCard);
