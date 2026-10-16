/**
 * BranchNameModal - Modal for entering a branch name when using "Branch and Save".
 * Used when committing from a protected branch.
 */
import { memo, useState, useCallback, useEffect, useRef, type KeyboardEvent, type CSSProperties } from 'react';
import { GitBranch } from 'lucide-react';
import { ICON_SIZES } from '../../shared/constants';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from '../../shared/ui';

// ============================================================================
// Types
// ============================================================================

interface BranchNameModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (branchName: string) => void;
  defaultBranchName?: string;
  isLoading?: boolean;
  currentBranch?: string;
}

// ============================================================================
// Styles
// ============================================================================

const iconStyle: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

// ============================================================================
// Component
// ============================================================================

function BranchNameModal({ 
  open, 
  onOpenChange, 
  onConfirm, 
  defaultBranchName = '',
  isLoading = false,
  currentBranch = '',
}: BranchNameModalProps): JSX.Element | null {
  const [branchName, setBranchName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens and focus input
  useEffect(() => {
    if (open) {
      setBranchName(defaultBranchName);
    }
  }, [open, defaultBranchName]);

  const handleConfirm = useCallback((): void => {
    if (!branchName.trim()) return;
    onConfirm(branchName.trim());
  }, [branchName, onConfirm]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && branchName.trim()) {
      handleConfirm();
    }
  }, [branchName, handleConfirm]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      initialFocusRef={inputRef}
    >
      <DialogContent
        size="sm"
        containerClassName="items-start pt-20"
        className="overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="border-b border-theme-default px-4 py-3">
          <div className="flex items-center gap-2">
            <GitBranch style={iconStyle} className="text-theme-secondary" />
            <DialogTitle id="branch-modal-title" className="flex-1 text-base font-medium">
              Create Branch & Save
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="p-4 space-y-3">
          <div>
            <label htmlFor="branch-name-input" className="mb-1 block text-xs text-theme-secondary">
              Branch name
            </label>
            <Input
              ref={inputRef}
              id="branch-name-input"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="feature/my-changes"
              disabled={isLoading}
            />
          </div>
          <p className="text-xs text-theme-muted">
            Creates a branch from <span className="text-theme-secondary">{currentBranch || 'the current snapshot'}</span>, moves changes there, and saves.
          </p>
        </div>

        <DialogFooter className="border-t border-theme-default px-4 py-3">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button 
            onClick={handleConfirm}
            disabled={!branchName.trim()}
            loading={isLoading}
          >
            Create & Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default memo(BranchNameModal);
