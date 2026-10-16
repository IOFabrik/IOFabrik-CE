/** Windows application/title bar, independent of sidebar visibility and width. */
import { memo, useCallback, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, GitBranch, Menu, RefreshCw, Undo2 } from 'lucide-react';
import { useLayout, useRepo } from '../../context';
import { VIEWS } from '../../shared/constants';
import { useWindowSize } from '../../shared/hooks';
import {
  Button,
  UndoLastSaveDialog,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../shared/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../shared/ui/dropdown-menu';
import Combobox from '../../shared/ui/combobox';
import Wordmark from '../../shared/brand/Wordmark';
import { ICON_STYLES } from '../../shared/utils/gitHelpers';
import { isWindowsDesktop } from '../../shared/runtime/window';
import RepoSwitcher from '../../features/welcome/components/RepoSwitcher';
import BranchModal from './BranchModal';
import SwitchProjectModal from './SwitchProjectModal';
import WindowControls, {
  handleWindowTitleDoubleClick,
  windowControlProps,
  windowDragStyle,
} from './WindowControls';

function TopBar(): JSX.Element {
  const {
    repoPath,
    repoInfo,
    repoStatus,
    branches,
    closeRepo,
    commits,
    undoLastCommit,
    operationInProgress,
    isLoading,
    isSyncing,
    hasRemote,
    syncRepo,
    switchBranch,
    refreshBranches,
  } = useRepo();
  const { setActiveView, setSidebarCollapsed } = useLayout();
  const { isCompactTopBar } = useWindowSize();
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [switchProjectOpen, setSwitchProjectOpen] = useState(false);
  const isWindows = isWindowsDesktop();
  const isGitRepo = Boolean(repoPath && repoInfo?.isRepo);
  const busy = operationInProgress || isLoading || isSyncing;
  const branchOptions = useMemo(
    () => (branches?.local || []).map((branch) => ({ value: branch.name, label: branch.name })),
    [branches?.local]
  );
  const tracking = repoStatus?.hasUpstream ?? false;
  const incoming = tracking ? (repoStatus?.behind ?? 0) : null;
  const outgoing = tracking ? (repoStatus?.ahead ?? 0) : (repoStatus?.totalLocalCommits ?? 0);
  const syncDisabled = !isGitRepo || !hasRemote || busy;
  const undoDisabled = !isGitRepo || !commits?.length || busy;
  const syncDescription = !isGitRepo
    ? 'Open a tracked project to sync changes.'
    : !hasRemote
      ? 'Connect this project to a remote repository to sync changes.'
      : `Sync pulls shared updates and pushes saved work as needed. ${incoming === null ? 'Incoming count is unavailable until this branch tracks a remote branch.' : `${incoming} incoming saved changes, based on the last check.`} ${outgoing} outgoing saved changes. Counts describe saved snapshots, not uncommitted files.`;

  const handleSwitchProject = useCallback(async () => {
    if (busy) return;
    await closeRepo();
    setActiveView(VIEWS.EXPLORER);
    setSidebarCollapsed(false);
  }, [busy, closeRepo, setActiveView, setSidebarCollapsed]);
  const handleUndo = useCallback(async () => {
    await undoLastCommit();
  }, [undoLastCommit]);
  const handleSync = useCallback(() => {
    void syncRepo();
  }, [syncRepo]);
  const handleRefreshBranches = useCallback(() => {
    void refreshBranches();
  }, [refreshBranches]);
  const handleCreateBranch = useCallback(() => {
    setCreateBranchOpen(true);
  }, []);
  const handleOpenSwitchProject = useCallback(() => {
    setSwitchProjectOpen(true);
  }, []);
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (isWindows) handleWindowTitleDoubleClick(event);
    },
    [isWindows]
  );

  return (
    <>
      <header
        className="app-top-bar flex h-11 shrink-0 items-center gap-2 bg-theme-elevated px-2 text-sm leading-5 select-none"
        style={isWindows ? windowDragStyle : undefined}
        onDoubleClick={handleDoubleClick}
        data-testid="top-bar"
      >
        <Wordmark />
        <div {...windowControlProps} className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-sm leading-5 font-normal text-theme-secondary">Repository:</span>
          <RepoSwitcher onSwitchProjects={handleOpenSwitchProject} />
          <span className="ml-1 shrink-0 text-sm leading-5 font-normal text-theme-secondary">Branch:</span>
          <Combobox
            value={isGitRepo ? repoInfo?.branch || '' : ''}
            options={branchOptions}
            label="Switch branch"
            placeholder="Search branches..."
            disabled={!isGitRepo || busy}
            icon={<GitBranch style={ICON_STYLES.sm} className="shrink-0" />}
            onSelect={switchBranch}
            onOpen={handleRefreshBranches}
            action={{ label: 'Create branch', onSelect: handleCreateBranch }}
            className="w-44 max-w-[24vw]"
          />
        </div>
        <span
          role="separator"
          aria-orientation="vertical"
          className="mx-1 h-4 w-px shrink-0 bg-theme-muted"
        />
        <div {...windowControlProps} className="flex shrink-0 items-center gap-1">
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex"
                  tabIndex={syncDisabled ? 0 : undefined}
                  aria-label={syncDisabled ? syncDescription : undefined}
                >
                  <Button
                    variant="secondary"
                    onClick={handleSync}
                    disabled={syncDisabled}
                    loading={isSyncing}
                    aria-label={isSyncing ? 'Syncing changes' : 'Sync Changes'}
                    title={syncDescription}
                  >
                    {!isSyncing && <RefreshCw style={ICON_STYLES.sm} />}
                    <span>{isSyncing ? 'syncing...' : 'sync'}</span>
                    {incoming !== null && incoming > 0 ? (
                      <span
                        className="ml-1 inline-flex items-center gap-0.5 text-theme-muted"
                        aria-label={`${incoming} incoming saved changes`}
                      >
                        <ArrowDown style={ICON_STYLES.xs} />
                        {incoming}
                      </span>
                    ) : null}
                    {outgoing > 0 ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-theme-muted"
                        aria-label={`${outgoing} outgoing saved changes`}
                      >
                        <ArrowUp style={ICON_STYLES.xs} />
                        {outgoing}
                      </span>
                    ) : null}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{syncDescription}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {isCompactTopBar ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Application actions"
                  title="Application actions"
                >
                  <Menu style={ICON_STYLES.sm} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={undoDisabled} onSelect={() => setUndoOpen(true)}>
                  <Undo2 style={ICON_STYLES.sm} />
                  undo
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              variant="secondary"
              aria-label="Undo Last Save"
              title="Undo Last Save"
              disabled={undoDisabled}
              onClick={() => setUndoOpen(true)}
            >
              <Undo2 style={ICON_STYLES.sm} />
              <span>undo</span>
            </Button>
          )}
        </div>
        <div className="min-w-2 flex-1 self-stretch" data-testid="window-drag-space" />
        {isWindows ? (
          <div className="-mr-2 h-full">
            <WindowControls />
          </div>
        ) : null}
      </header>
      <BranchModal
        open={createBranchOpen}
        onOpenChange={setCreateBranchOpen}
        initialMode="create"
      />
      <UndoLastSaveDialog open={undoOpen} onOpenChange={setUndoOpen} onConfirm={handleUndo} />
      <SwitchProjectModal
        open={switchProjectOpen}
        onOpenChange={setSwitchProjectOpen}
        onConfirm={handleSwitchProject}
      />
    </>
  );
}

export default memo(TopBar);
