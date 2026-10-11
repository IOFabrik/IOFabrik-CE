/**
 * ViewerHeader - Common header bar for all file viewers.
 * 
 * Features:
 * - Displays the file path
 * - "Open in Default App" button to launch file with system default application
 * - Optional custom icon based on viewer type
 * - Optional extra content (e.g., image dimensions)
 * 
 * This component is rendered by ViewerRenderer to provide consistent
 * header UI across all viewers without code duplication.
 */
import { memo, useCallback, type ReactNode } from 'react';
import { FileText, ExternalLink, type LucideIcon } from 'lucide-react';
import { OpenFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import { toast } from 'sonner';
import { ICON_SIZES } from '../../../shared/constants';
import { Button } from '../../../shared/ui/button';

// ============================================================================
// Types
// ============================================================================

export interface ViewerHeaderProps {
  /** Absolute path to the file being viewed */
  filePath: string;
  /** Optional icon to display (defaults to FileText) */
  icon?: LucideIcon;
  /** Optional extra content to render before the button (e.g., dimensions) */
  extraContent?: ReactNode;
}

// ============================================================================
// ViewerHeader Component
// ============================================================================

/**
 * ViewerHeader - Renders the common header bar for file viewers.
 */
function ViewerHeaderInner({ 
  filePath, 
  icon: Icon = FileText,
  extraContent,
}: ViewerHeaderProps): JSX.Element {
  // Handle open in default app
  const handleOpenInDefaultApp = useCallback(async () => {
    try {
      const result = await OpenFile(filePath);
      if (!result.success) {
        toast.error(`Failed to open file: ${result.error}`);
      }
    } catch {
      toast.error('Failed to open file');
    }
  }, [filePath]);

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-viewer-header border-b border-theme-default text-sm text-theme-secondary">
      <Icon size={ICON_SIZES.sm} className="flex-shrink-0" />
      <span className="truncate flex-1">{filePath}</span>
      {extraContent}
      <Button
        variant="secondary"
        size="sm"
        onClick={handleOpenInDefaultApp}
        className="shrink-0 text-xs"
        title="Open in default application"
      >
        <ExternalLink size={ICON_SIZES.xs} />
        Open in Default App
      </Button>
    </div>
  );
}

export const ViewerHeader = memo(ViewerHeaderInner);
export default ViewerHeader;
