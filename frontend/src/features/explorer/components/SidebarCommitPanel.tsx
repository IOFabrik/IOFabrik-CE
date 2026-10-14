/**
 * SidebarCommitPanel - Compact commit form for sidebar.
 * Shows commit message input, action buttons, and changed files list.
 * Clicking on changed files opens a diff tab.
 */
import { memo, useState, useCallback, useEffect } from 'react';
import { MAIN_BRANCHES, type ExplorerTab } from '../../../shared/constants';
import { useLayout, useRepo } from '../../../context';
import { Button } from '../../../shared/ui';
import AutoGrowTextarea from '../../../shared/ui/AutoGrowTextarea';
import ChangedFilesTable from './ChangedFilesTable';
import LFSAutoTrackModal from './LFSAutoTrackModal';
import RewindConfirmModal from '../../../widgets/layout/RewindConfirmModal';
import { GetUserProfile } from '../../../../bindings/iofabrik/services/settingsservice';
import type { FileStatus } from '../../../context';
import { useLfsAutoTrackBeforeSave } from '../hooks/useLfsAutoTrackBeforeSave';
import MainBranchSaveChoiceModal, { type MainBranchSaveChoice } from './MainBranchSaveChoiceModal';
import { useIntegrationSession } from '../../integration';

let rememberedMainBranchSaveChoice: MainBranchSaveChoice | null = null;

// ============================================================================
// Types
// ============================================================================

interface SidebarCommitPanelProps {
  changedFiles: FileStatus[];
  onCommit: (message: string, force?: boolean) => Promise<boolean>;
  onBranchAndCommit: (branchName: string, message: string) => Promise<boolean>;
  onRewind: () => Promise<boolean>;
  onDiscardFile: (filePath: string) => Promise<boolean>;
  currentBranch: string;
  repoPath?: string;
  isCommitting: boolean;
  isRewinding: boolean;
  operationInProgress?: boolean;
}

function SidebarCommitPanel({
  changedFiles,
  onCommit,
  onBranchAndCommit,
  onRewind,
  onDiscardFile,
  currentBranch,
  repoPath,
  isCommitting,
  isRewinding,
  operationInProgress = false,
}: SidebarCommitPanelProps): JSX.Element {
  const { openExplorerTab, openExplorerMergeModal } = useLayout();
  const { ghAuthStatus } = useRepo();
  const {
    enabled: updateWorkflowEnabled,
    isBusy: isUpdateBusy,
    isSaveBlocked,
    startUpdate,
    refresh: refreshUpdate,
  } = useIntegrationSession();
  const [message, setMessage] = useState('');
  const [checkForConflicts, setCheckForConflicts] = useState(false);
  const [showRewindModal, setShowRewindModal] = useState(false);
  const [showMainBranchChoiceModal, setShowMainBranchChoiceModal] = useState(false);
  const [mainBranchChoice, setMainBranchChoice] = useState<MainBranchSaveChoice>('branch-and-save');
  const [rememberChoiceForSession, setRememberChoiceForSession] = useState(false);
  const [isDiscardingFile, setIsDiscardingFile] = useState(false);
  const [defaultBranchName, setDefaultBranchName] = useState('');

  const {
    modalOpen: showAutoTrackModal,
    candidates: autoTrackCandidates,
    selectedFilePaths: selectedAutoTrackFiles,
    isApplying: isApplyingAutoTrack,
    runBeforeSave,
    toggleCandidate,
    toggleSelectAll,
    cancelModal,
    confirmAndContinue,
  } = useLfsAutoTrackBeforeSave({
    repoPath,
    changedFiles,
  });

  // Fetch user profile for default branch name
  useEffect(() => {
    const fetchDefaults = async (): Promise<void> => {
      try {
        const profile = await GetUserProfile(repoPath || '');
        const usernameSource = ghAuthStatus?.username || profile?.email || profile?.name || 'user';
        const sanitizedUsername = usernameSource
          .toLowerCase()
          .replace(/@.*/, '')
          .replace(/[^a-z0-9._-]/g, '-');
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const defaultName = `@${sanitizedUsername}-${yyyy}${mm}${dd}-${hh}${ss}`;
        setDefaultBranchName(defaultName);
      } catch {
        setDefaultBranchName(`@user-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-00-00`);
      }
    };
    fetchDefaults();
  }, [repoPath, ghAuthStatus?.username]);

  const executeSaveChoice = useCallback(async (choice: MainBranchSaveChoice): Promise<boolean> => {
    if (!message.trim()) return false;

    if (choice === 'branch-and-save') {
      return onBranchAndCommit(defaultBranchName, message);
    }

    return onCommit(message);
  }, [defaultBranchName, message, onBranchAndCommit, onCommit]);

  const handleSuccessfulFeatureSave = useCallback((shouldCheckForConflicts: boolean): void => {
    setMessage('');
    if (!updateWorkflowEnabled) {
      return;
    }
    if (!shouldCheckForConflicts) {
      void refreshUpdate();
      return;
    }

    void startUpdate().then((snapshot) => {
      if (snapshot?.state === 'needs-decisions') {
        openExplorerMergeModal();
      }
    });
  }, [openExplorerMergeModal, refreshUpdate, startUpdate, updateWorkflowEnabled]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!message.trim()) return;

    const isMainBranch = MAIN_BRANCHES.includes(currentBranch.toLowerCase());

    if (!isMainBranch) {
      const shouldCheckForConflicts = checkForConflicts;
      setCheckForConflicts(false);
      await runBeforeSave(
        () => onCommit(message),
        () => handleSuccessfulFeatureSave(shouldCheckForConflicts),
      );
      return;
    }

    if (rememberedMainBranchSaveChoice) {
      const rememberedChoice = rememberedMainBranchSaveChoice;
      await runBeforeSave(
        () => executeSaveChoice(rememberedChoice),
        () => setMessage(''),
      );
      return;
    }

    setMainBranchChoice('branch-and-save');
    setRememberChoiceForSession(false);
    setShowMainBranchChoiceModal(true);
  }, [checkForConflicts, currentBranch, handleSuccessfulFeatureSave, message, onCommit, runBeforeSave]);

  const handleConfirmMainBranchSaveChoice = useCallback(async (): Promise<void> => {
    await runBeforeSave(
      () => executeSaveChoice(mainBranchChoice),
      () => {
        if (rememberChoiceForSession) {
          rememberedMainBranchSaveChoice = mainBranchChoice;
        }
        setMessage('');
        setShowMainBranchChoiceModal(false);
      },
    );
  }, [executeSaveChoice, mainBranchChoice, rememberChoiceForSession, runBeforeSave]);

  const handleRewindConfirm = useCallback(async (): Promise<void> => {
    const success = await onRewind();
    if (success) {
      setShowRewindModal(false);
    }
  }, [onRewind]);

  const handleDiscardSingleFile = useCallback(async (file: FileStatus): Promise<void> => {
    if (isDiscardingFile || isCommitting || isRewinding) return;

    setIsDiscardingFile(true);
    try {
      await onDiscardFile(file.path);
    } finally {
      setIsDiscardingFile(false);
    }
  }, [isCommitting, isDiscardingFile, isRewinding, onDiscardFile]);

  /**
    * Open a diff tab for a changed file (text diff or specialized visual diff).
   * Creates an explorer tab showing working tree changes (HEAD vs current).
   */
  const handleOpenDiff = useCallback((file: FileStatus): void => {
    if (!repoPath) return;

    const absolutePath = repoPath + '/' + file.path;
    const fileName = file.path.split('/').pop() || file.path;

    const tab: ExplorerTab = {
      id: `diff-working-${file.path}`,
      title: `${fileName} (Working Changes)`,
      filePath: absolutePath,
      type: 'diff',
      diffContext: {
        type: 'working',
        relativePath: file.path,
        absolutePath,
        status: file.status,
      },
    };

    openExplorerTab(tab);
  }, [repoPath, openExplorerTab]);

  const isFeatureBranch = !MAIN_BRANCHES.includes(currentBranch.toLowerCase());
  const saveControlsDisabled = isCommitting || operationInProgress || isUpdateBusy || isSaveBlocked;

  return (
    <div className="flex min-h-0 flex-col h-full">
      {/* Header section */}
      <div className="shrink-0 p-3 space-y-2">
        <p className="text-theme-secondary text-sm leading-5">
          Careful! You have unsaved changes.
        </p>

        {/* Commit message */}
        <AutoGrowTextarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe changes..."
          aria-label="Describe changes"
          disabled={saveControlsDisabled}
          className="text-sm"
        />

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!message.trim() || isDiscardingFile || saveControlsDisabled}
            loading={isCommitting}
            size="sm"
            variant="default"
            className="flex-1"
          >
            Save Changes
          </Button>
        </div>
        {updateWorkflowEnabled && isFeatureBranch && (
          <label className="flex items-center gap-2 text-xs text-theme-secondary">
            <input
              type="checkbox"
              checked={checkForConflicts}
              onChange={(event) => setCheckForConflicts(event.target.checked)}
              disabled={saveControlsDisabled || showAutoTrackModal || isApplyingAutoTrack}
              className="h-4 w-4 rounded border-theme-default"
            />
            <span>Check for conflicts</span>
          </label>
        )}
      </div>

      {/* Changed files list */}
      <ChangedFilesTable
        files={changedFiles}
        repoPath={repoPath}
        onOpenDiff={handleOpenDiff}
        onDiscardFile={handleDiscardSingleFile}
        onDiscardAll={() => setShowRewindModal(true)}
        disabled={isDiscardingFile || isRewinding || saveControlsDisabled}
      />

      {/* Modals */}
      <RewindConfirmModal
        open={showRewindModal}
        onOpenChange={setShowRewindModal}
        onConfirm={handleRewindConfirm}
        isLoading={isRewinding}
      />

      <MainBranchSaveChoiceModal
        open={showMainBranchChoiceModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowMainBranchChoiceModal(false);
          }
        }}
        currentBranch={currentBranch}
        mainBranchChoice={mainBranchChoice}
        onChoiceChange={setMainBranchChoice}
        defaultBranchName={defaultBranchName}
        rememberChoiceForSession={rememberChoiceForSession}
        onToggleRememberChoice={() => setRememberChoiceForSession((prev) => !prev)}
        isCommitting={isCommitting}
        canConfirm={!!message.trim()}
        onConfirm={handleConfirmMainBranchSaveChoice}
      />

      <LFSAutoTrackModal
        open={showAutoTrackModal}
        candidates={autoTrackCandidates}
        selectedFilePaths={selectedAutoTrackFiles}
        isApplying={isApplyingAutoTrack}
        onOpenChange={(open) => {
          if (!open) {
            cancelModal();
          }
        }}
        onToggleFile={toggleCandidate}
        onToggleSelectAll={toggleSelectAll}
        onConfirm={confirmAndContinue}
      />
    </div>
  );
}

export default memo(SidebarCommitPanel);
