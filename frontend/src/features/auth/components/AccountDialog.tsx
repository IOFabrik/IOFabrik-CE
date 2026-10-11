import { memo, useEffect, type JSX } from 'react';
import { useAuth } from '../../../context';
import { Dialog, DialogContent } from '../../../shared/ui';
import LoginView from './LoginView';

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function AccountDialog({ open, onOpenChange }: AccountDialogProps): JSX.Element {
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (open && isAuthenticated) {
      onOpenChange(false);
    }
  }, [isAuthenticated, onOpenChange, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="max-w-md overflow-visible border-none bg-transparent p-0 shadow-none">
        <LoginView
          variant="embedded"
          title="Sign in to IOFabrik"
          description="Use your IOFabrik account for optional cloud features. Local Git work stays available without signing in."
        />
      </DialogContent>
    </Dialog>
  );
}

export default memo(AccountDialog);