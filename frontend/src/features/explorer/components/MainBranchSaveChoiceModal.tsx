import { memo } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui';

export type MainBranchSaveChoice = 'branch-and-save' | 'save-on-main';

interface MainBranchSaveChoiceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBranch: string;
  mainBranchChoice: MainBranchSaveChoice;
  onChoiceChange: (choice: MainBranchSaveChoice) => void;
  defaultBranchName: string;
  rememberChoiceForSession: boolean;
  onToggleRememberChoice: () => void;
  isCommitting: boolean;
  canConfirm: boolean;
  onConfirm: () => Promise<void>;
}

function MainBranchSaveChoiceModal({
  open,
  onOpenChange,
  currentBranch,
  mainBranchChoice,
  onChoiceChange,
  rememberChoiceForSession,
  onToggleRememberChoice,
  isCommitting,
  canConfirm,
  onConfirm,
}: MainBranchSaveChoiceModalProps): JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save on the default branch?</AlertDialogTitle>
          <AlertDialogDescription>
            You are currently on {currentBranch}. Choose how you want to save these changes.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="px-6 pb-4 space-y-3">
          <label className="flex items-start gap-2 p-2 rounded hover:bg-theme-elevated cursor-pointer">
            <input
              type="radio"
              name="main-branch-save-choice"
              checked={mainBranchChoice === 'branch-and-save'}
              onChange={() => onChoiceChange('branch-and-save')}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm text-theme-primary">(recommended) Branch and save</div>
              <div className="text-xs text-theme-muted">Keeps shared work stable while your team reviews and tests changes before merging.</div>
            </div>
          </label>

          <label className="flex items-start gap-2 p-2 rounded hover:bg-theme-elevated cursor-pointer">
            <input
              type="radio"
              name="main-branch-save-choice"
              checked={mainBranchChoice === 'save-on-main'}
              onChange={() => onChoiceChange('save-on-main')}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm text-theme-primary">Save on {currentBranch}</div>
              <div className="text-xs text-theme-muted">Saves directly to {currentBranch}. Risk: mistakes go straight to your team’s shared history and are harder to undo.</div>
            </div>
          </label>

          <label className="flex items-center gap-2 px-2 py-2 rounded border border-theme-default text-sm text-theme-muted hover:bg-theme-elevated cursor-pointer">
            <input
              type="checkbox"
              checked={rememberChoiceForSession}
              onChange={onToggleRememberChoice}
            />
            <span>Remember my choice for this session</span>
          </label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isCommitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="default"
            disabled={isCommitting || !canConfirm}
            onClick={onConfirm}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default memo(MainBranchSaveChoiceModal);
