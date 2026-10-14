import { lazy, memo, Suspense } from 'react';
import { useLayout, useRepo } from '../../context';
import { Toaster, ProgressModal } from '../../shared/ui';
import RecoveryBanner from '../../shared/ui/RecoveryBanner';
import TopBar from './TopBar';
import ActivityBar from './ActivityBar';
import Sidebar from './Sidebar';
import MainArea from './MainArea';
import NonGitFolderPromptModal from './NonGitFolderPromptModal';
import AdditionalPackagesModal from './AdditionalPackagesModal';
import GitIdentityPromptModal from './GitIdentityPromptModal';
import ProjectDefaultBranchModal from './ProjectDefaultBranchModal';
import DefaultBranchSyncConfirmModal from './DefaultBranchSyncConfirmModal';

// Mounted only while open so the merge/conflict bundle (including the ladder
// visualizer) is fetched on demand and unrelated repo updates cannot re-render it.
const ExplorerMergeModal = lazy(() => import('../../features/merge/components/ExplorerMergeModal'));

/**
 * AppLayoutInner - Inner component that has access to RepoContext and LayoutContext.
 */
function AppLayoutInner(): JSX.Element {
  const { progressModal, handleProgressComplete } = useRepo();
  const { explorerMergeModalOpen, setExplorerMergeModalOpen } = useLayout();

  return (
    <div className="h-screen w-screen flex flex-col bg-theme-elevated text-theme-primary overflow-hidden">
      <TopBar />
      <RecoveryBanner />
      <Toaster />
      
      {/* Progress Modal for git operations */}
      <ProgressModal
        open={progressModal.isOpen}
        operationId={progressModal.operationId || ''}
        title={progressModal.title}
        onComplete={handleProgressComplete}
      />

      <NonGitFolderPromptModal />
      <AdditionalPackagesModal />
      <GitIdentityPromptModal />
      <DefaultBranchSyncConfirmModal />
      <ProjectDefaultBranchModal />
      {explorerMergeModalOpen && (
        <Suspense fallback={null}>
          <ExplorerMergeModal
            open={explorerMergeModalOpen}
            onOpenChange={setExplorerMergeModalOpen}
          />
        </Suspense>
      )}
      
      <div className="flex-1 flex overflow-hidden min-h-0 pb-2 pr-2 pt-1">
        <ActivityBar />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl bg-theme-surface" data-testid="workspace-container">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <MainArea />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * AppLayout - Root layout component for the application
 */
function AppLayout(): JSX.Element {
  return <AppLayoutInner />;
}

export default memo(AppLayout);
