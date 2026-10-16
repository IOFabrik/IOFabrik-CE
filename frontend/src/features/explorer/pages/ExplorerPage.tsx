/**
 * ExplorerPage - Main area showing tabs with file browser and opened files.
 * 
 * Features:
 * - Tabs bar at the top with file browser as pinned tab
 * - File browser shows when that tab is active
 * - File content shows when file tabs are active (using multi-viewer architecture)
 * - Diff tabs for L5X files show the domain-aware diff viewer
 * - When no folder is open: Shows welcome pages based on selected category
 * - Non-git / no-remote folders: Shows ProjectSetupBanner with state-aware CTA
 * - All open tabs are kept mounted (but hidden) to preserve viewer state/cache
 */
import { memo, useState, useCallback, useMemo } from 'react';
import { useRepo, useLayout } from '../../../context';
import { OpenFolderDialog } from '../../../../bindings/iofabrik/services/filedialogservice';
import { RecentProjectsPage, NewProjectPage, CloneProjectPage, OpenFolderPage } from '../../welcome/pages';
import GitHubDeviceFlowModal from '../../auth/components/GitHubDeviceFlowModal';
import { useGitHubDeviceFlow } from '../../auth/hooks/useGitHubDeviceFlow';
import SimpleFileBrowser from '../components/SimpleFileBrowser';
import ExplorerTabsBar from '../components/ExplorerTabsBar';
import ExplorerCommitTabContent from '../components/ExplorerCommitTabContent';
import ProjectSetupBanner from '../components/ProjectSetupBanner';
import { PROJECT_STATES, type ProjectState, type ExplorerTab } from '../../../shared/constants';
import { ViewerRenderer, getViewerForFile, getViewerById } from '../../../viewers/components/shared/ViewerRenderer';
import { DiffRenderer } from '../../../viewers/components/shared/DiffRenderer';
import {
  buildCommitDiffRequest,
  buildWorkingTreeDiffRequest,
} from '../../../viewers/registry/diff-request-adapters';
import { getFolderNameFromPath } from '../../../shared/utils/path';

function ExplorerPage(): JSX.Element {
  const {
    repoPath,
    operationInProgress,
    repoInfo,
    repoStatus,
    openFolder,
    startTracking,
    installRequiredPackages,
    publishToGitHub,
    loadUserOrganizations,
    refreshRemotes,
    hasRemote,
    isLoading,
    gitInstalled,
    lfsInstalled,
    isInstallingPackages,
    ghInstalled,
    ghAuthStatus,
  } = useRepo();
  const {
    activeExplorerTab,
    explorerTabs,
    selectedWelcomeCategory,
    newProjectPrefillPath,
    setNewProjectPrefillPath,
  } = useLayout();
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const {
    deviceFlow,
    startDeviceFlow,
    closeDeviceFlow,
    handleDeviceFlowOpenChange,
  } = useGitHubDeviceFlow();

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    setIsOpeningFolder(true);
    try {
      const result = await OpenFolderDialog();
      if (result.selected && result.path) {
        await openFolder(result.path);
      }
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
    setIsOpeningFolder(false);
  }, [openFolder]);

  // Derive project state for the setup banner (Phase 12.1, Phase 14 nested-repo check)
  const projectState = useMemo((): ProjectState | null => {
    if (!repoPath) return null;
    if (!repoInfo?.isRepo) {
      const fileCount = repoStatus?.changedFiles?.length || 0;
      return fileCount > 0
        ? PROJECT_STATES.HAS_FILES_UNTRACKED
        : PROJECT_STATES.EMPTY_UNTRACKED;
    }
    // Nested repo check: if the detected repo root differs from the opened path,
    // this folder is inside another repository — suppress setup CTA (Phase 14)
    if (repoInfo.path && repoInfo.path !== repoPath) {
      return PROJECT_STATES.NESTED_REPO;
    }
    if (!hasRemote) return PROJECT_STATES.TRACKED_NO_REMOTE;
    return PROJECT_STATES.TRACKED_WITH_REMOTE;
  }, [repoPath, repoInfo?.isRepo, repoInfo?.path, hasRemote, repoStatus?.changedFiles?.length]);

  // Handle publish to GitHub with form data from the banner
  const handlePublishFromBanner = useCallback(async (
    name: string,
    isPrivate: boolean,
    owner: string
  ): Promise<void> => {
    setIsPublishing(true);
    try {
      const result = await publishToGitHub(name, '', isPrivate, owner);
      if (result.success) {
        await refreshRemotes();
      }
    } finally {
      setIsPublishing(false);
    }
  }, [publishToGitHub, refreshRemotes]);

  // Handle GitHub connect from banner
  const handleConnectGitHub = useCallback(async (): Promise<void> => {
    await startDeviceFlow();
  }, [startDeviceFlow]);

  // Memoize file tabs - must be called before any conditional returns (Rules of Hooks)
  const fileTabs = useMemo(() => 
    explorerTabs.filter(tab => tab.type === 'file' && tab.filePath),
    [explorerTabs]
  );

  // Memoize diff tabs
  const diffTabs = useMemo(() =>
    explorerTabs.filter(tab => tab.type === 'diff' && tab.diffContext),
    [explorerTabs]
  );

  const commitTabs = useMemo(() =>
    explorerTabs.filter(tab => tab.type === 'commit' && tab.commitContext?.commitHash),
    [explorerTabs]
  );

  // Check if file browser is active
  const isFileBrowserActive = activeExplorerTab === 'file-browser';

  // Memoize rendered file tabs to avoid recreating elements on every render
  // This keeps viewer components mounted and their caches intact
  // Must be called before any conditional returns (Rules of Hooks)
  const renderedFileTabs = useMemo(() => {
    return fileTabs.map(tab => {
      const viewer = tab.viewerId 
        ? getViewerById(tab.viewerId)
        : getViewerForFile(tab.title);
      
      if (!viewer || !tab.filePath) return null;
      
      const isActive = tab.id === activeExplorerTab;
      
      return (
        <div 
          key={tab.id} 
          className="h-full"
          style={{ display: isActive ? 'block' : 'none' }}
        >
          <ViewerRenderer viewer={viewer} filePath={tab.filePath} />
        </div>
      );
    }).filter(Boolean) as JSX.Element[];
  }, [fileTabs, activeExplorerTab]);

  // Memoize rendered diff tabs
  const renderedDiffTabs = useMemo(() => {
    return diffTabs.map((tab: ExplorerTab) => {
      if (!tab.diffContext || !repoPath) return null;
      
      const isActive = tab.id === activeExplorerTab;
      const { diffContext } = tab;
      const filePath = diffContext.relativePath || tab.filePath || '';
      const mode = diffContext.type;
      const request = mode === 'commit'
        ? buildCommitDiffRequest({
          repoPath,
          filePath,
          commitHash: diffContext.commitHash ?? '',
          parentHash: diffContext.parentHash ?? null,
          oldPath: diffContext.oldPath,
          fileStatus: diffContext.status,
          showHeader: true,
        })
        : buildWorkingTreeDiffRequest({
          repoPath,
          filePath,
          absoluteFilePath: diffContext.absolutePath ?? tab.filePath ?? filePath,
          oldPath: diffContext.oldPath,
          fileStatus: diffContext.status,
          showHeader: true,
        });

      return (
        <div
          key={tab.id}
          className="h-full"
          style={{ display: isActive ? 'block' : 'none' }}
        >
          <DiffRenderer {...request} />
        </div>
      );
    }).filter(Boolean) as JSX.Element[];
  }, [diffTabs, activeExplorerTab, repoPath]);

  const renderedCommitTabs = useMemo(() => {
    return commitTabs.map((tab: ExplorerTab) => {
      const commitHash = tab.commitContext?.commitHash;
      if (!commitHash) return null;

      const isActive = tab.id === activeExplorerTab;

      return (
        <div
          key={tab.id}
          className="h-full"
          style={{ display: isActive ? 'block' : 'none' }}
        >
          <ExplorerCommitTabContent commitHash={commitHash} />
        </div>
      );
    }).filter(Boolean) as JSX.Element[];
  }, [commitTabs, activeExplorerTab]);

  // No folder open - show welcome page based on selected category
  if (!repoPath) {
    switch (selectedWelcomeCategory) {
      case 'new-project':
        return (
          <NewProjectPage
            prefillPath={newProjectPrefillPath}
            onPrefillApplied={() => setNewProjectPrefillPath('')}
          />
        );
      case 'clone-project':   return <CloneProjectPage />;
      case 'open-folder':     return <OpenFolderPage onOpenFolder={handleOpenFolder} isLoading={isOpeningFolder} />;
      case 'recent-projects':
      default:                return <RecentProjectsPage onOpenPath={openFolder} />;
    }
  }

  // Folder open - show tabs and content, with optional setup banner
  // Hide banner for fully-set-up projects and nested repos (Phase 14)
  const folderName = getFolderNameFromPath(repoPath) || '';
  const showBanner = projectState != null 
    && projectState !== PROJECT_STATES.TRACKED_WITH_REMOTE
    && projectState !== PROJECT_STATES.NESTED_REPO;

  return (
    <>
      <div className="flex flex-col h-full">
        <ExplorerTabsBar />

        {/* State-aware project setup banner (Phase 12.2 / 12.4) */}
        {showBanner && isFileBrowserActive && (
          <ProjectSetupBanner
            projectState={projectState}
            folderName={folderName}
            repoPath={repoPath}
            fileCount={repoStatus?.changedFiles?.length}
            onEnableVersionControl={startTracking}
            onInstallRequiredPackages={installRequiredPackages}
            onPublishToGitHub={handlePublishFromBanner}
            onConnectGitHub={handleConnectGitHub}
            onLoadOrganizations={loadUserOrganizations}
            isLoading={isLoading}
            operationInProgress={operationInProgress}
            gitInstalled={gitInstalled}
            lfsInstalled={lfsInstalled}
            isInstallingPackages={isInstallingPackages}
            isPublishing={isPublishing}
            ghInstalled={ghInstalled}
            ghAuthStatus={ghAuthStatus}
          />
        )}

        <div className="flex-1 min-h-0 overflow-hidden relative">
          {/* File browser - always mounted, shown when active */}
          <div 
            className="h-full"
            style={{ display: isFileBrowserActive ? 'block' : 'none' }}
          >
            <SimpleFileBrowser repoPath={repoPath} />
          </div>

          {/* All file tabs - mounted but hidden when not active */}
          {renderedFileTabs}

          {/* All diff tabs - mounted but hidden when not active */}
          {renderedDiffTabs}

          {/* Commit overview tabs - mounted but hidden when not active */}
          {renderedCommitTabs}
        </div>
      </div>

      <GitHubDeviceFlowModal
        open={deviceFlow.isOpen}
        userCode={deviceFlow.userCode}
        verificationUrl={deviceFlow.verificationUrl}
        onComplete={closeDeviceFlow}
        onOpenChange={handleDeviceFlowOpenChange}
      />
    </>
  );
}

export default memo(ExplorerPage);
