import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { Mail, User } from 'lucide-react';
import { useRepo } from '../../context';
import { ICON_SIZES } from '../../shared/constants';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
} from '../../shared/ui';

function getPromptCopy(reason: NonNullable<ReturnType<typeof useRepo>['gitIdentityPrompt']>['reason']): {
  title: string;
  description: string;
  actionLabel: string;
} {
  switch (reason) {
    case 'initial-commit':
      return {
        title: 'Add your name and email before the first save',
        description: 'IOFabrik can work without an account, but Git still needs a name and email to record who made the first saved revision for this project.',
        actionLabel: 'Save and continue',
      };
    case 'merge-complete':
      return {
        title: 'Add your name and email before finishing the merge',
        description: 'Git needs author details to record the merge commit. This is separate from your IOFabrik account.',
        actionLabel: 'Save and finish merge',
      };
    case 'branch-save':
      return {
        title: 'Add your name and email before saving to a new branch',
        description: 'Git needs author details to record who made the saved revision on the new branch. This is separate from your IOFabrik account.',
        actionLabel: 'Save and continue',
      };
    case 'save':
    default:
      return {
        title: 'Add your name and email before saving changes',
        description: 'Git needs author details to record who made each saved revision. This is separate from your IOFabrik account.',
        actionLabel: 'Save and continue',
      };
  }
}

function GitIdentityPromptModal(): JSX.Element | null {
  const {
    gitIdentityPrompt,
    submitGitIdentityPrompt,
    cancelGitIdentityPrompt,
  } = useRepo();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saveGlobally, setSaveGlobally] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!gitIdentityPrompt?.isOpen) {
      setIsSaving(false);
      return;
    }

    setName(gitIdentityPrompt.name);
    setEmail(gitIdentityPrompt.email);
    setSaveGlobally(false);
    setIsSaving(false);
  }, [gitIdentityPrompt]);

  const handleOpenChange = useCallback((open: boolean): void => {
    if (open || isSaving) {
      return;
    }

    cancelGitIdentityPrompt();
  }, [cancelGitIdentityPrompt, isSaving]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    setIsSaving(true);
    try {
      const success = await submitGitIdentityPrompt(name, email, saveGlobally);
      if (!success) {
        setIsSaving(false);
      }
    } catch (err) {
      console.error('Failed to save git identity:', err);
      setIsSaving(false);
    }
  }, [email, name, saveGlobally, submitGitIdentityPrompt]);

  if (!gitIdentityPrompt) {
    return null;
  }

  const copy = getPromptCopy(gitIdentityPrompt.reason);
  const isSubmitDisabled = isSaving || !name.trim() || !email.trim();

  return (
    <Dialog open={gitIdentityPrompt.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent size="md" className="overflow-hidden">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="git-identity-name" className="gap-2">
              <User size={ICON_SIZES.xs} />
              <span>Name used for saved changes</span>
            </Label>
            <Input
              id="git-identity-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              disabled={isSaving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="git-identity-email" className="gap-2">
              <Mail size={ICON_SIZES.xs} />
              <span>Email used in revision history</span>
            </Label>
            <Input
              id="git-identity-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              disabled={isSaving}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-theme-default bg-theme-surface px-4 py-3">
            <div>
              <p className="text-sm font-medium text-theme-primary">Use this for all projects on this device</p>
              <p className="mt-1 text-xs text-theme-muted">
                Leave this off to save the name and email only for the current project.
              </p>
            </div>
            <Switch checked={saveGlobally} onCheckedChange={setSaveGlobally} disabled={isSaving} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={cancelGitIdentityPrompt} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={isSubmitDisabled} loading={isSaving}>
            {copy.actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default memo(GitIdentityPromptModal);