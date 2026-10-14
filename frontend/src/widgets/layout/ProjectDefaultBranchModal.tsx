import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useRepo } from '../../context';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Label, Select,
} from '../../shared/ui';
import EmptyState from '../../shared/ui/EmptyState';

function ProjectDefaultBranchModal(): JSX.Element | null {
  const {
    projectDefaultBranchPrompt: prompt, projectDefaultBranchError,
    isSavingProjectDefaultBranch, submitProjectDefaultBranch, cancelProjectDefaultBranchSelection,
  } = useRepo();
  const [branch, setBranch] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setBranch(prompt?.effectiveBranch || '');
    setConfirming(false);
  }, [prompt]);
  const options = useMemo(() => (prompt?.choices || []).map(name => ({ value: name, label: name })), [prompt]);
  const handleClose = useCallback((open: boolean) => {
    if (!open && !isSavingProjectDefaultBranch) cancelProjectDefaultBranchSelection();
  }, [isSavingProjectDefaultBranch, cancelProjectDefaultBranchSelection]);
  const handleContinue = useCallback(() => setConfirming(true), []);
  const handleConfirm = useCallback(() => { void submitProjectDefaultBranch(branch); }, [branch, submitProjectDefaultBranch]);
  if (!prompt) return null;

  if (confirming) {
    return (
      <AlertDialog open onOpenChange={handleClose} closeOnEscape={!isSavingProjectDefaultBranch}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change default branch?</AlertDialogTitle>
            <AlertDialogDescription>Changing the default branch is a dangerous action. Are you sure you want to continue?</AlertDialogDescription>
          </AlertDialogHeader>
          {projectDefaultBranchError && <p role="alert" className="px-6 text-sm text-red-400">{projectDefaultBranchError}</p>}
          <AlertDialogFooter>
            <Button variant="secondary" disabled={isSavingProjectDefaultBranch} onClick={cancelProjectDefaultBranchSelection}>Cancel</Button>
            <Button variant="destructive" disabled={isSavingProjectDefaultBranch} onClick={handleConfirm}>
              {isSavingProjectDefaultBranch ? 'Saving...' : 'Confirm change'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose default branch</DialogTitle>
          <DialogDescription>Choose an available branch for this project&apos;s IOFabrik default.</DialogDescription>
        </DialogHeader>
        <div className="px-6 space-y-3">
          {options.length > 0 ? <>
            <Label>Default branch</Label>
            <Select value={branch} onValueChange={setBranch} options={options} placeholder="Choose a branch" />
          </> : <EmptyState customMessage="No available branches. Get the project's branches, then refresh and try again." />}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={cancelProjectDefaultBranchSelection}>Cancel</Button>
          <Button disabled={!branch || !prompt.choices.includes(branch)} onClick={handleContinue}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default memo(ProjectDefaultBranchModal);
