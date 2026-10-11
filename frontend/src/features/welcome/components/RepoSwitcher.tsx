/**
 * RepoSwitcher - Dropdown component for project actions and switching.
 */
import { memo, useState, useCallback, useEffect, type CSSProperties } from 'react';
import {
  FolderGit2,
  ChevronDown,
  FolderOpen,
  Globe,
  FolderSync,
  Settings,
  Check,
} from 'lucide-react';
import { ICON_SIZES, VIEWS } from '../../../shared/constants';
import { useLayout, useRepo } from '../../../context';
import { Button } from '../../../shared/ui';
import { Popover, PopoverTrigger, PopoverContent } from '../../../shared/ui/popover';
import { cn } from '../../../shared/utils/misc';
import { getFolderNameFromPath } from '../../../shared/utils/path';
import { RevealInFinder } from '../../../../bindings/iofabrik/services/filesystemservice';
import { GetRemoteURL } from '../../../../bindings/iofabrik/services/gitservice';
import { openExternalUrl } from '../../../shared/runtime/browser';
import { toast } from 'sonner';
import { loadMergedRecentFolders } from '../../../shared/utils/recentFolders';

// ============================================================================
// Styles
// ============================================================================

const iconStyle: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };
const IS_MAC_OS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const FILE_MANAGER_NAME = IS_MAC_OS ? 'Finder' : 'Explorer';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert git remote URL to a browser URL.
 */
function gitUrlToWebUrl(gitUrl: string): string {
  if (!gitUrl) return '';

  let webUrl = gitUrl.trim();

  if (webUrl.startsWith('git@')) {
    webUrl = webUrl.replace(/^git@/, 'https://').replace(/:([^/])/, '/$1');
  }

  if (webUrl.endsWith('.git')) {
    webUrl = webUrl.slice(0, -4);
  }

  return webUrl;
}

// ============================================================================
// Main Component
// ============================================================================

function RepoSwitcher({ onSwitchProjects }: { onSwitchProjects: () => void }): JSX.Element {
  const { repoPath, openFolder, operationInProgress, isLoading } = useRepo();
  const { setActiveView } = useLayout();

  const [isOpen, setIsOpen] = useState(false);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [opening, setOpening] = useState(false);
  const busy = operationInProgress || isLoading || opening;
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadingRecent(true);
    void loadMergedRecentFolders().then((folders) => {
      if (!cancelled) {
        setRecentFolders(folders);
        setLoadingRecent(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleOpenRecent = useCallback(
    async (folder: string) => {
      if (busy || folder === repoPath) return;
      setOpening(true);
      try {
        if (await openFolder(folder)) {
          setActiveView(VIEWS.EXPLORER);
          setIsOpen(false);
        }
      } catch {
        toast.error('This project could not be opened. Try opening its folder again.');
      } finally {
        setOpening(false);
      }
    },
    [busy, openFolder, repoPath, setActiveView]
  );

  // Derive repo display values
  const repoName = repoPath ? getFolderNameFromPath(repoPath) : 'No repository';

  const handleOpenInFileManager = useCallback(async () => {
    if (!repoPath) {
      toast.error('No folder is currently open');
      return;
    }

    try {
      const result = await RevealInFinder(repoPath);
      if (!result.success) {
        toast.error(result.error || `Failed to open in ${FILE_MANAGER_NAME}`);
      } else {
        setIsOpen(false);
      }
    } catch (error) {
      console.error('Failed to open in file manager:', error);
      toast.error(`Failed to open in ${FILE_MANAGER_NAME}`);
    }
  }, [repoPath]);

  const handleOpenInBrowser = useCallback(async () => {
    if (!repoPath) {
      toast.error('No folder is currently open');
      return;
    }

    try {
      const remoteUrl = await GetRemoteURL(repoPath);
      if (!remoteUrl) {
        toast.error('No remote repository configured');
        return;
      }

      const webUrl = gitUrlToWebUrl(remoteUrl);
      if (!webUrl) {
        toast.error('Could not parse remote URL');
        return;
      }

      const didOpen = await openExternalUrl(webUrl);
      if (!didOpen) {
        toast.error('Could not open remote URL safely');
        return;
      }

      setIsOpen(false);
    } catch (error) {
      console.error('Failed to open repository in browser:', error);
      toast.error('Failed to open repository in browser');
    }
  }, [repoPath]);

  const handleSwitchProjects = useCallback(() => {
    setIsOpen(false);
    onSwitchProjects();
  }, [onSwitchProjects]);

  const handleProjectSettings = useCallback(() => {
    if (!repoPath) {
      toast.error('No folder is currently open');
      return;
    }
    setActiveView(VIEWS.REPO_SETTINGS);
    setIsOpen(false);
  }, [repoPath, setActiveView]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          disabled={busy}
          aria-label="Switch project"
          className="w-44 max-w-[22vw] min-w-0 justify-start"
          title={repoPath || 'Open a folder'}
        >
          <FolderGit2 style={iconStyle} className="text-theme-muted shrink-0" />
          <span className="truncate text-theme-primary">{repoName}</span>
          <ChevronDown
            style={{ width: ICON_SIZES.sm, height: ICON_SIZES.sm }}
            className={cn(
              'ml-auto text-theme-muted shrink-0 transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={4} className="p-2" style={{ width: 320 }}>
        <div className="space-y-1">
          <p className="px-2 py-1 text-xs text-theme-muted">Recent projects</p>
          <div className="max-h-60 overflow-y-auto" aria-busy={loadingRecent}>
            {loadingRecent ? (
              <p className="px-2 py-2 text-sm text-theme-muted">Loading projects...</p>
            ) : recentFolders.length === 0 ? (
              <p className="px-2 py-2 text-sm text-theme-muted">No recent projects.</p>
            ) : (
              recentFolders.map((folder) => (
                <Button
                  key={folder}
                  variant="ghost"
                  className="h-auto w-full justify-start py-2 text-left"
                  disabled={busy || folder === repoPath}
                  onClick={() => void handleOpenRecent(folder)}
                  title={folder}
                >
                  <FolderGit2 style={iconStyle} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{getFolderNameFromPath(folder)}</span>
                  {folder === repoPath && <Check style={iconStyle} className="shrink-0" />}
                </Button>
              ))
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={handleSwitchProjects}
            className="w-full justify-start gap-2"
          >
            <FolderSync style={iconStyle} />
            Open another project
          </Button>
          {repoPath && (
            <div className="pt-2 space-y-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenInFileManager}
                className="w-full justify-start gap-2 text-xs"
              >
                <FolderOpen style={iconStyle} />
                Open in {FILE_MANAGER_NAME}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenInBrowser}
                className="w-full justify-start gap-2 text-xs"
              >
                <Globe style={iconStyle} />
                Open in Browser
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleProjectSettings}
                className="w-full justify-start gap-2 text-xs"
              >
                <Settings style={iconStyle} />
                Project Settings
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default memo(RepoSwitcher);
