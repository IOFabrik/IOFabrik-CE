import { memo, useCallback, type CSSProperties } from 'react';
import { BookOpen, ExternalLink, Map, MessagesSquare, type LucideIcon } from 'lucide-react';
import { ICON_SIZES } from '../../shared/constants';
import { openExternalUrl } from '../../shared/runtime/browser';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui';

const DOCUMENTATION_URL = 'https://iofabrik.com/docs/';
const COMMUNITY_FORUM_URL = 'https://github.com/orgs/IOFabrik/discussions';
const iconStyle: CSSProperties = { width: ICON_SIZES.md, height: ICON_SIZES.md };
const externalLinkIconStyle: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

interface ResourcesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ResourceOptionProps {
  title: string;
  description: string;
  Icon: LucideIcon;
  onClick?: () => void;
  comingSoon?: boolean;
}

function ResourceOption({
  title,
  description,
  Icon,
  onClick,
  comingSoon = false,
}: ResourceOptionProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={comingSoon}
      className="group flex w-full items-center gap-3 rounded-md border border-theme-default bg-theme-elevated p-3 text-left transition-colors hover:bg-theme-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-theme-elevated"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 dark:text-blue-400">
        <Icon style={iconStyle} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-theme-primary">{title}</span>
          {comingSoon ? <Badge variant="warning">Coming Soon</Badge> : null}
        </span>
        <span className="mt-0.5 block text-xs text-theme-secondary">{description}</span>
      </span>
      {!comingSoon ? (
        <ExternalLink
          style={externalLinkIconStyle}
          className="shrink-0 text-theme-muted transition-colors group-hover:text-theme-primary"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}

function ResourcesModal({ open, onOpenChange }: ResourcesModalProps): JSX.Element {
  const handleOpenResource = useCallback((url: string): void => {
    void openExternalUrl(url);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="overflow-hidden">
        <DialogHeader className="border-b border-theme-default">
          <DialogTitle>Resources</DialogTitle>
          <DialogDescription>
            Learn more about IOFabrik or connect with the community.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 p-4">
          <ResourceOption
            title="Documentation"
            description="Browse guides and product documentation."
            Icon={BookOpen}
            onClick={() => handleOpenResource(DOCUMENTATION_URL)}
          />
          <ResourceOption
            title="Community Forum"
            description="Ask questions and share ideas with the community."
            Icon={MessagesSquare}
            onClick={() => handleOpenResource(COMMUNITY_FORUM_URL)}
          />
          <ResourceOption
            title="Guided tour"
            description="Take a quick tour of the IOFabrik workflow."
            Icon={Map}
            comingSoon
          />
        </div>

        <DialogFooter className="border-t border-theme-default px-4 py-3">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default memo(ResourcesModal);
