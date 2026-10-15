/**
 * SimpleFileBrowser - A lightweight file browser component.
 * 
 * Features:
 * - Double-click folders to navigate into them
 * - Breadcrumb navigation for quick jumping
 * - Grid/List view toggle
 * - Hidden files toggle
 * - Git status badges
 * - Virtualized table view for performance
 * - Uses Lucide icons (no external file browser dependencies)
 */
import { memo, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Folder,
  File,
  FileText,
  FileCode,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  FileSearch,
  ChevronRight,
  Grid3X3,
  List,
  Eye,
  EyeOff,
  RefreshCw,
  Home,
  X,
  ExternalLink,
  Clipboard,
  Trash2,
  Download,
  Share2,
  FolderOpen,
  Link,
  Copy,
  Info,
  Cloud,
  Box,
  Lock,
  MoreHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { 
  ListDirectoryWithOptions, 
  OpenFile,
  RevealInFinder,
  CopyToClipboard,
  MoveToTrash,
} from '../../../../bindings/iofabrik/services/filesystemservice';
import { GetRemoteURL } from '../../../../bindings/iofabrik/services/gitservice';
import { GetGitUser, LFSLsFiles, LFSLock, LFSLocks, LFSUnlock } from '../../../../bindings/iofabrik/services/lfsservice';
import { FileEntry } from '../../../../bindings/iofabrik/services/models';
import { useRepo, useLayout } from '../../../context';
import { useWindowSize } from '../../../shared/hooks';
import { openExternalUrl } from '../../../shared/runtime/browser';
import { toast } from 'sonner';
import { onEvent } from '../../../shared/runtime/events';
import { ICON_SIZES, type ExplorerTab } from '../../../shared/constants';
import { getViewerForFile } from '../../../viewers/registry/viewer-registry';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../../../shared/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../shared/ui/dropdown-menu';

/**
 * Helper to reveal a path in the system file manager (Finder on macOS, Explorer on Windows)
 */
async function revealInFileManager(path: string): Promise<boolean> {
  try {
    const result = await RevealInFinder(path);
    if (!result.success) {
      toast.error(result.error || `Failed to reveal in ${FILE_MANAGER_NAME}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('RevealInFinder error:', err);
    toast.error(`Failed to reveal in ${FILE_MANAGER_NAME}`);
    return false;
  }
}

/**
 * Convert a git remote URL to a web-browseable URL
 * Handles SSH (git@github.com:user/repo.git) and HTTPS formats
 */
function gitUrlToWebUrl(gitUrl: string): string {
  if (!gitUrl) return '';
  
  let webUrl = gitUrl.trim();
  
  // Handle SSH format: git@github.com:user/repo.git -> https://github.com/user/repo
  if (webUrl.startsWith('git@')) {
    webUrl = webUrl
      .replace(/^git@/, 'https://')
      .replace(/:([^/])/, '/$1'); // Replace first : with /
  }
  
  // Remove .git suffix if present
  if (webUrl.endsWith('.git')) {
    webUrl = webUrl.slice(0, -4);
  }
  
  return webUrl;
}

/**
 * Helper to copy text to clipboard with consistent error handling
 */
async function copyTextToClipboard(text: string, successMessage = 'Copied to clipboard'): Promise<boolean> {
  try {
    const result = await CopyToClipboard(text);
    if (result.success) {
      toast.success(successMessage);
      return true;
    } else {
      toast.error(result.error || 'Failed to copy to clipboard');
      return false;
    }
  } catch (err) {
    console.error('CopyToClipboard error:', err);
    toast.error('Failed to copy to clipboard');
    return false;
  }
}

// Git status color classes - used for text and icons
const GIT_STATUS_COLORS: Record<string, string> = {
  added: 'text-green-500',
  modified: 'text-yellow-500',
  deleted: 'text-red-500',
  renamed: 'text-blue-500',
  untracked: 'text-gray-500',
};

// Git status single-letter labels
const GIT_STATUS_LABELS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

const IS_MAC_OS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// Platform-specific file manager name
const FILE_MANAGER_NAME = IS_MAC_OS ? 'Finder' : 'Explorer';

// Responsive list-column breakpoints (aligned with TopBar compact behavior).
const LIST_COLUMN_BREAKPOINTS = {
  hideModified: 1400,
  hideSize: 1180,
} as const;

const TOOLBAR_BREAKPOINTS = {
  compactLabels: 1360,
  overflowSecondaryActions: 1120,
} as const;

const DETAILS_PANEL_BREAKPOINT = 1360;

interface ListColumnVisibility {
  showSize: boolean;
  showModified: boolean;
}

// File extension to icon mapping
const EXTENSION_ICONS: Record<string, LucideIcon> = {
  // Code files
  js: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  py: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  css: FileCode,
  scss: FileCode,
  html: FileCode,
  xml: FileCode,
  json: FileCode,
  yaml: FileCode,
  yml: FileCode,
  toml: FileCode,
  // Text files
  md: FileText,
  txt: FileText,
  log: FileText,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  // Video
  mp4: FileVideo,
  mov: FileVideo,
  avi: FileVideo,
  mkv: FileVideo,
  webm: FileVideo,
  // Audio
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  flac: FileAudio,
  // Archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  rar: FileArchive,
  '7z': FileArchive,
  // Spreadsheets
  csv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
};

interface RepoStatus {
  changedFiles?: Array<{
    path: string;
    status: string;
  }>;
}

/**
 * Get the appropriate icon for a file based on extension
 */
function getFileIcon(fileName: string, isDirectory: boolean): LucideIcon {
  if (isDirectory) return Folder;
  
  const ext = fileName.split('.').pop()?.toLowerCase();
  return (ext && EXTENSION_ICONS[ext]) || File;
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function getPathBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function getPathParent(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (separatorIndex <= 0) return '';
  return trimmed.slice(0, separatorIndex);
}

function getRelativePathFromRoot(path: string | null | undefined, rootPath: string | null | undefined): string {
  if (!path || !rootPath) return '';

  const normalizedPath = normalizePathSeparators(path);
  const normalizedRoot = normalizePathSeparators(rootPath).replace(/\/+$/, '');

  if (normalizedPath === normalizedRoot) return '';
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return '';
}

/**
 * Build git status map for current directory
 */
function buildGitStatusMap(repoStatus: RepoStatus | null, currentPath: string | null, repoPath: string | null): Record<string, string> {
  const statusMap: Record<string, string> = {};
  if (!repoStatus?.changedFiles || !repoPath) return statusMap;
  
  const relativeCurrentPath = getRelativePathFromRoot(currentPath, repoPath);
  
  for (const file of repoStatus.changedFiles) {
    const filePath = file.path;
    const fileDir = filePath.includes('/') 
      ? filePath.substring(0, filePath.lastIndexOf('/'))
      : '';
    
    if (fileDir === relativeCurrentPath) {
      const fileName = filePath.split('/').pop();
      if (fileName) {
        statusMap[fileName] = file.status;
      }
    } else if (filePath.startsWith(relativeCurrentPath ? relativeCurrentPath + '/' : '')) {
      const remainingPath = relativeCurrentPath 
        ? filePath.slice(relativeCurrentPath.length + 1)
        : filePath;
      const folderName = remainingPath.split('/')[0];
      if (folderName && !statusMap[folderName]) {
        statusMap[folderName] = 'modified';
      }
    }
  }
  
  return statusMap;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format date for display
 */
function formatDate(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const currentYear = new Date().getFullYear();
  return date.toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric',
    year: date.getFullYear() !== currentYear ? 'numeric' : undefined
  });
}

interface BreadcrumbsProps {
  currentPath: string | null;
  rootPath: string | null;
  onNavigate: (path: string) => void;
}

/**
 * Truncate text in the middle (macOS style)
 * Shows beginning and end of text with ellipsis in the middle
 */
function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  
  const ellipsis = '…';
  const charsToShow = maxLength - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  
  return text.substring(0, frontChars) + ellipsis + text.substring(text.length - backChars);
}

/**
 * Breadcrumb component for folder navigation
 */
function Breadcrumbs({ currentPath, rootPath, onNavigate }: BreadcrumbsProps) {
  const parts = useMemo(() => {
    if (!currentPath || !rootPath) return [];
    
    const segments: Array<{ path: string; name: string }> = [];
    let path = currentPath;
    
    while (path && path.length >= rootPath.length) {
      const name = getPathBaseName(path) || path;
      segments.unshift({ path, name });
      
      if (path === rootPath) break;
      
      const parentPath = getPathParent(path);
      if (parentPath === path || !parentPath) break;
      path = parentPath;
    }
    
    return segments;
  }, [currentPath, rootPath]);

  if (parts.length === 0) return null;

  return (
    <nav className="flex items-center gap-1 px-4 py-3 bg-viewer-header overflow-x-auto">
      <button
        onClick={() => rootPath && onNavigate(rootPath)}
        className="p-1.5 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors shrink-0"
        title="Go to root"
      >
        <Home className="w-5 h-5" />
      </button>
      
      {parts.map((part, index) => (
        <div key={part.path} className="flex items-center shrink-0">
          {index !== 0 && <ChevronRight className="w-5 h-5 text-theme-muted" />}
          <button
            onClick={() => onNavigate(part.path)}
            className={`px-2 py-1.5 rounded text-base transition-colors ${
              index === parts.length - 1
                ? 'text-theme-primary font-semibold'
                : 'text-theme-muted hover:text-theme-secondary hover:bg-fb-hover'
            }`}
            title={part.name}
          >
            {truncateMiddle(part.name, 20)}
          </button>
        </div>
      ))}
    </nav>
  );
}

interface ToolbarProps {
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  showHidden: boolean;
  onShowHiddenChange: () => void;
  onRefresh: () => void;
  onSync: () => Promise<void>;
  isSyncing: boolean;
  currentPath: string | null;
  repoPath: string | null;
}

/**
 * Toolbar with view toggle and actions
 */
function Toolbar({
  viewMode,
  onViewModeChange,
  showHidden,
  onShowHiddenChange,
  onRefresh,
  onSync,
  isSyncing,
  currentPath,
  repoPath,
}: ToolbarProps) {
  const { width } = useWindowSize();

  const showButtonLabels = width >= TOOLBAR_BREAKPOINTS.compactLabels;
  const showSecondaryActionsInline = width >= TOOLBAR_BREAKPOINTS.overflowSecondaryActions;

  const handleOpenInFileManager = useCallback(async () => {
    if (!currentPath) return;
    await revealInFileManager(currentPath);
  }, [currentPath]);

  const handleCopyLink = useCallback(async () => {
    if (!currentPath || !repoPath) {
      toast.error('No repository path available');
      return;
    }
    
    try {
      // Get the remote URL from git
      const remoteUrl = await GetRemoteURL(repoPath);
      if (!remoteUrl) {
        toast.error('No remote repository configured');
        return;
      }
      
      // Convert git URL to web URL
      const webBaseUrl = gitUrlToWebUrl(remoteUrl);
      if (!webBaseUrl) {
        toast.error('Could not parse remote URL');
        return;
      }
      
      // Calculate relative path from repo root
      const relativePath = getRelativePathFromRoot(currentPath, repoPath);
      
      // URL-encode the path segments to handle special characters:
      // - Spaces → %20
      // - # → %23 (hash/anchor)
      // - ? → %3F (query string)
      // - & → %26 (query params)
      // - + → %2B (plus sign)
      // - % → %25 (percent sign itself)
      // - Special chars like !, @, $, etc.
      // We encode each path segment separately to preserve the / separators
      const encodedPath = relativePath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
      
      // Construct the full web URL (e.g., https://github.com/user/repo/tree/main/path/to/folder)
      // Note: We use /tree/main as a common default, but this could be enhanced to detect the actual branch
      const fullUrl = encodedPath
        ? `${webBaseUrl}/tree/main${encodedPath}`
        : webBaseUrl;
      
      await copyTextToClipboard(fullUrl, 'Remote link copied to clipboard');
    } catch (err) {
      console.error('Failed to get remote URL:', err);
      toast.error('Failed to get remote repository URL');
    }
  }, [currentPath, repoPath]);

  const handleViewInCloud = useCallback(async () => {
    if (!repoPath) {
      toast.error('No repository path available');
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
      }
    } catch (err) {
      console.error('Failed to open remote repository URL:', err);
      toast.error('Failed to open remote repository URL');
    }
  }, [repoPath]);

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 bg-fb-toolbar">
      <div className="flex items-center gap-1 min-w-0">
        <button
          onClick={handleOpenInFileManager}
          className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors text-sm leading-5 shrink-0"
          title={`Open in ${FILE_MANAGER_NAME}`}
          disabled={!currentPath}
        >
          <FolderOpen className="w-4 h-4" />
          {showButtonLabels && <span>Open in {FILE_MANAGER_NAME}</span>}
        </button>
        <button
          onClick={onRefresh}
          className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors text-sm leading-5 shrink-0"
          title="Reload"
        >
          <RefreshCw className="w-4 h-4" />
          {showButtonLabels && <span>Reload</span>}
        </button>
        <button
          onClick={onShowHiddenChange}
          className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-fb-hover rounded transition-colors text-sm leading-5 shrink-0 ${
            showHidden ? 'text-theme-primary' : 'text-theme-muted hover:text-theme-secondary'
          }`}
          title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
        >
          {showHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
          {showButtonLabels && <span>{showHidden ? 'Hide Hidden' : 'Show Hidden'}</span>}
        </button>

        {showSecondaryActionsInline ? (
          <>
            <div className="w-px h-4 bg-theme-muted mx-1 shrink-0" />
            <button
              onClick={handleCopyLink}
              className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors text-sm leading-5 shrink-0"
              title="Copy remote repository link"
              disabled={!currentPath || !repoPath}
            >
              <Link className="w-4 h-4" />
              {showButtonLabels && <span>Copy Link</span>}
            </button>
            <button
              onClick={handleViewInCloud}
              className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors text-sm leading-5 shrink-0"
              title="View in Cloud"
              disabled={!repoPath}
            >
              <Cloud className="w-4 h-4" />
              {showButtonLabels && <span>View in Cloud</span>}
            </button>
            <button
              onClick={() => void onSync()}
              className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors text-sm leading-5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent shrink-0"
              title="Sync with Cloud"
              disabled={!repoPath || isSyncing}
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              {showButtonLabels && <span>{isSyncing ? 'Syncing...' : 'Sync'}</span>}
            </button>
          </>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center justify-center h-8 w-8 p-0 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors shrink-0"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onClick={handleCopyLink} disabled={!currentPath || !repoPath}>
                <Link className="mr-2 h-4 w-4" />
                Copy Link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleViewInCloud} disabled={!repoPath}>
                <Cloud className="mr-2 h-4 w-4" />
                View in Cloud
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void onSync()} disabled={!repoPath || isSyncing}>
                <RefreshCw className={`mr-2 h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Syncing...' : 'Sync'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      
      <div className="flex items-center gap-1 bg-fb-surface rounded p-0.5 shrink-0">
        <button
          onClick={() => onViewModeChange('grid')}
          className={`p-1.5 rounded transition-colors ${
            viewMode === 'grid' 
              ? 'bg-fb-base text-theme-primary shadow-sm' 
              : 'text-theme-muted hover:text-theme-secondary'
          }`}
          title="Grid view"
        >
          <Grid3X3 className="w-4 h-4" />
        </button>
        <button
          onClick={() => onViewModeChange('list')}
          className={`p-1.5 rounded transition-colors ${
            viewMode === 'list' 
              ? 'bg-fb-base text-theme-primary shadow-sm' 
              : 'text-theme-muted hover:text-theme-secondary'
          }`}
          title="List view"
        >
          <List className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

const GeneratePreviewMenuItem = memo(function GeneratePreviewMenuItem({ fileName, onGenerate }: { fileName: string; onGenerate: () => void }) {
  const { operationInProgress } = useRepo();
  // Menu content mounts on open, so eligibility uses the current file's basename.
  const parts = fileName.split('.');
  const eligible = parts.length === 2 && parts[0].length > 0 && parts[1].toLowerCase() === 'acd';

  return (
    <ContextMenuItem disabled={!eligible || operationInProgress} onSelect={onGenerate}>
      <FileSearch size={ICON_SIZES.sm} className="mr-2" />
      <span>Generate preview</span>
    </ContextMenuItem>
  );
});

interface FileItemGridProps {
  file: FileEntry;
  gitStatus?: string;
  isLfs?: boolean;
  lockOwner?: string;
  isOwnLock?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
  onDoubleClick: () => void;
  onPreview?: () => void;
  onContextAction?: (action: FileContextAction, file: FileEntry) => void;
}

/**
 * File item component for grid view
 */
function FileItemGrid({ file, gitStatus, isLfs, lockOwner, isOwnLock, isSelected, onSelect, onDoubleClick, onPreview, onContextAction }: FileItemGridProps) {
  const Icon = getFileIcon(file.name, file.isDirectory);
  // Only apply git status color to files, not folders
  const statusColor = (gitStatus && !file.isDirectory) ? GIT_STATUS_COLORS[gitStatus] : '';

  const hasViewer = useMemo(() => {
    if (file.isDirectory) return false;
    const viewer = getViewerForFile(file.name);
    return viewer && viewer.id !== 'unsupported';
  }, [file.name, file.isDirectory]);

  const isLocked = !!lockOwner;

  const lockDisabled = file.isDirectory || !isLfs || isLocked;
  const unlockDisabled = file.isDirectory || !isLfs || !isLocked || !isOwnLock;
  const forceUnlockDisabled = file.isDirectory || !isLfs || !isLocked || !!isOwnLock;
  
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onSelect}
          onDoubleClick={onDoubleClick}
          className={`flex flex-col items-center gap-2 p-3 rounded-lg transition-colors group w-full border border-transparent ${
            isSelected ? 'bg-fb-selected border-fb-selected' : 'hover:bg-fb-hover'
          }`}
          title={file.name}
        >
          <div className="relative text-theme-muted">
            <Icon className={`w-10 h-10 ${file.isDirectory ? 'fill-current' : ''}`} />
            {gitStatus && (
              <div className={`absolute -top-1 -right-1 w-3 h-3 rounded-full ${
                gitStatus === 'added' ? 'bg-green-500' :
                gitStatus === 'modified' ? 'bg-yellow-500' :
                gitStatus === 'deleted' ? 'bg-red-500' :
                'bg-gray-500'
              }`} />
            )}
            {isLfs && !file.isDirectory && (
              <div className="absolute -bottom-1 -right-1 bg-fb-surface rounded-full p-0.5" title="LFS tracked">
                <Box className="w-3 h-3 text-theme-muted" />
              </div>
            )}
          </div>
          <span
            className={`text-xs text-center truncate w-full flex items-center justify-center gap-1 ${statusColor || 'text-theme-primary'}`}
            title={isLocked ? `Locked by ${lockOwner}` : file.name}
          >
            <span className="truncate">{file.name}</span>
            {isLocked && !file.isDirectory && (
              <Lock className={`w-3 h-3 shrink-0 ${isOwnLock ? 'text-blue-400' : 'text-amber-400'}`} />
            )}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => onContextAction?.('open', file)}>
          <ExternalLink className="mr-2 h-4 w-4" />
          <span>Open</span>
          <ContextMenuShortcut>⏎</ContextMenuShortcut>
        </ContextMenuItem>
        {!file.isDirectory && hasViewer && (
          <ContextMenuItem onClick={() => onPreview?.()}>
            <Eye className="mr-2 h-4 w-4" />
            <span>Preview</span>
            <ContextMenuShortcut>␣</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {!file.isDirectory && <GeneratePreviewMenuItem fileName={file.name} onGenerate={() => onContextAction?.('generate-preview', file)} />}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={lockDisabled}
          onClick={() => onContextAction?.('lfs-lock', file)}
        >
          <Lock className="mr-2 h-4 w-4" />
          <span>Lock File (LFS)</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={unlockDisabled}
          onClick={() => onContextAction?.('lfs-unlock', file)}
        >
          <Lock className="mr-2 h-4 w-4" />
          <span>Unlock File (LFS)</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={forceUnlockDisabled}
          onClick={() => onContextAction?.('lfs-unlock-force', file)}
        >
          <Lock className="mr-2 h-4 w-4" />
          <span>Force Unlock (LFS)</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onContextAction?.('reveal-in-finder', file)}>
          <FolderOpen className="mr-2 h-4 w-4" />
          <span>{IS_MAC_OS ? 'Reveal in Finder' : 'Reveal in Explorer'}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onContextAction?.('copy-path', file)}>
          <Clipboard className="mr-2 h-4 w-4" />
          <span>Copy Path</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onContextAction?.('copy-name', file)}>
          <Copy className="mr-2 h-4 w-4" />
          <span>Copy Name</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onContextAction?.('share', file)}>
          <Share2 className="mr-2 h-4 w-4" />
          <span>Share...</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onContextAction?.('move-to-trash', file)}>
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Move to Trash</span>
          <ContextMenuShortcut>{IS_MAC_OS ? '⌘⌫' : 'Del'}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onContextAction?.('get-info', file)}>
          <Info className="mr-2 h-4 w-4" />
          <span>Get Info</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface FileItemListProps {
  file: FileEntry;
  gitStatus?: string;
  isLfs?: boolean;
  lockOwner?: string;
  isOwnLock?: boolean;
  columnVisibility?: ListColumnVisibility;
  onDoubleClick: () => void;
  isSelected?: boolean;
  onSelect?: () => void;
  onPreview?: () => void;
  onContextAction?: (action: FileContextAction, file: FileEntry) => void;
}

// Context menu action types
type FileContextAction = 
  | 'open'
  | 'preview'
  | 'generate-preview'
  | 'lfs-lock'
  | 'lfs-unlock'
  | 'lfs-unlock-force'
  | 'reveal-in-finder'
  | 'copy-path'
  | 'copy-name'
  | 'move-to-trash'
  | 'share'
  | 'get-info';

/**
 * Git status icon component
 */
const GitStatusIcon = memo(function GitStatusIcon({ status }: { status?: string }) {
  if (!status) return <div className="w-4 h-4" />; // Empty spacer
  
  const colorClass = GIT_STATUS_COLORS[status] || 'text-gray-500';
  const statusLabel = GIT_STATUS_LABELS[status] || '?';
  
  return (
    <span className={`text-xs font-semibold w-4 h-4 flex items-center justify-center ${colorClass}`} title={status}>
      {statusLabel}
    </span>
  );
});

/**
 * File item component for table view (used in virtualized list)
 */
const FileTableRow = memo(function FileTableRow({ file, gitStatus, isLfs, lockOwner, isOwnLock, columnVisibility = { showSize: true, showModified: true }, onDoubleClick, isSelected, onSelect, onPreview, onContextAction }: FileItemListProps) {
  const Icon = getFileIcon(file.name, file.isDirectory);
  const statusColor = (gitStatus && !file.isDirectory) ? GIT_STATUS_COLORS[gitStatus] : '';
  
  const handleShareClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onContextAction?.('share', file);
  }, [file, onContextAction]);

  const handlePreviewClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onPreview?.();
  }, [onPreview]);
  
  // Check if this file has a viewer available (for preview button)
  const hasViewer = useMemo(() => {
    if (file.isDirectory) return false;
    const viewer = getViewerForFile(file.name);
    return viewer && viewer.id !== 'unsupported';
  }, [file.name, file.isDirectory]);

  const isLocked = !!lockOwner;

  const lockDisabled = file.isDirectory || !isLfs || isLocked;
  const unlockDisabled = file.isDirectory || !isLfs || !isLocked || !isOwnLock;
  const forceUnlockDisabled = file.isDirectory || !isLfs || !isLocked || !!isOwnLock;
  
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          onClick={onSelect}
          onDoubleClick={onDoubleClick}
          className={`flex items-center h-9 px-3 cursor-pointer border-b border-theme-muted transition-colors group ${
            isSelected 
              ? 'bg-fb-selected border-l-2 border-l-blue-500' 
              : 'hover:bg-fb-hover border-l-2 border-l-transparent'
          }`}
        >
          {/* Git Status Column */}
          <div className="w-6 shrink-0 flex items-center justify-center" role="cell">
            <GitStatusIcon status={!file.isDirectory ? gitStatus : undefined} />
          </div>

          {/* LFS Column */}
          <div className="w-6 shrink-0 flex items-center justify-center" role="cell" title={isLfs ? 'LFS tracked' : undefined}>
            {isLfs && (
              <Box className="w-3.5 h-3.5 text-theme-muted" />
            )}
          </div>
          
          {/* Type Icon Column */}
          <div className="w-8 shrink-0 flex items-center justify-center" role="cell">
            <Icon className={`w-4 h-4 text-theme-muted ${file.isDirectory ? 'fill-current' : ''}`} />
          </div>
          
          {/* Name Column */}
          <div className="flex-1 min-w-0 pr-2 flex items-center" role="cell">
            <span className={`text-sm truncate flex-1 ${statusColor || 'text-theme-primary'}`}>
              {file.name}
            </span>
            {isLocked && !file.isDirectory && (
              <span
                className={`ml-2 flex items-center gap-1 text-xs ${isOwnLock ? 'text-blue-400' : 'text-amber-400'}`}
                title={`Locked by ${lockOwner}`}
              >
                <Lock className="w-3.5 h-3.5" />
              </span>
            )}
            {/* Preview button - primary style, visible on hover */}
            {hasViewer && (
              <button
                onClick={handlePreviewClick}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 bg-blue-600 hover:bg-blue-500 text-white transition-all shrink-0 text-xs font-medium"
                title="Preview"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Preview</span>
              </button>
            )}
            {/* Share button - visible on hover */}
            <button
              onClick={handleShareClick}
              className="flex items-center gap-1 px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-fb-hover text-theme-muted hover:text-theme-primary transition-all shrink-0 text-xs ml-1"
              title="Share"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>Share</span>
            </button>
          </div>
          
          {columnVisibility.showSize && (
            <div className="w-20 shrink-0 text-right pr-4" role="cell">
              <span className="text-xs text-theme-muted">
                {!file.isDirectory ? formatFileSize(file.size) : '—'}
              </span>
            </div>
          )}

          {columnVisibility.showModified && (
            <div className="w-24 shrink-0 text-right" role="cell">
              <span className="text-xs text-theme-muted">
                {formatDate(file.modTime)}
              </span>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => onContextAction?.('open', file)}>
          <ExternalLink className="mr-2 h-4 w-4" />
          <span>Open</span>
           <ContextMenuShortcut>⏎</ContextMenuShortcut>
        </ContextMenuItem>
        {!file.isDirectory && (() => {
          const viewer = getViewerForFile(file.name);
          return viewer && viewer.id !== 'unsupported';
        })() && (
          <ContextMenuItem onClick={() => onContextAction?.('preview', file)}>
            <Eye className="mr-2 h-4 w-4" />
            <span>Preview</span>
            <ContextMenuShortcut>␣</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {!file.isDirectory && <GeneratePreviewMenuItem fileName={file.name} onGenerate={() => onContextAction?.('generate-preview', file)} />}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={lockDisabled}
          onClick={() => onContextAction?.('lfs-lock', file)}
        >
          <Lock className="mr-2 h-4 w-4" />
          <span>Lock File (LFS)</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={unlockDisabled}
          onClick={() => onContextAction?.('lfs-unlock', file)}
        >
          <Lock className="mr-2 h-4 w-4" />
          <span>Unlock File (LFS)</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={forceUnlockDisabled}
          onClick={() => onContextAction?.('lfs-unlock-force', file)}
        >
          <Lock className="mr-2 h-4 w-4" />
          <span>Force Unlock (LFS)</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onContextAction?.('reveal-in-finder', file)}>
          <FolderOpen className="mr-2 h-4 w-4" />
          <span>{IS_MAC_OS ? 'Reveal in Finder' : 'Reveal in Explorer'}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onContextAction?.('copy-path', file)}>
          <Clipboard className="mr-2 h-4 w-4" />
          <span>Copy Path</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onContextAction?.('copy-name', file)}>
          <Copy className="mr-2 h-4 w-4" />
          <span>Copy Name</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onContextAction?.('share', file)}>
          <Share2 className="mr-2 h-4 w-4" />
          <span>Share...</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onContextAction?.('move-to-trash', file)}>
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Move to Trash</span>
          <ContextMenuShortcut>{IS_MAC_OS ? '⌘⌫' : 'Del'}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onContextAction?.('get-info', file)}>
          <Info className="mr-2 h-4 w-4" />
          <span>Get Info</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * Table header for list view
 */
const FileTableHeader = memo(function FileTableHeader({ columnVisibility }: { columnVisibility: ListColumnVisibility }) {
  return (
    <div 
      role="row" 
      className="flex items-center h-8 px-3 bg-fb-base border-b border-theme-default text-xs text-theme-muted font-bold sticky top-0 z-10"
    >
      {/* Git Status Column - no header text */}
      <div className="w-6 shrink-0" role="columnheader" aria-label="Git status" />

      {/* LFS Column - no header text */}
      <div className="w-6 shrink-0" role="columnheader" aria-label="LFS" />
      
      {/* Type Icon Column - no header text */}
      <div className="w-8 shrink-0" role="columnheader" aria-label="Type" />
      
      {/* Name Column */}
      <div className="flex-1 min-w-0 pr-4" role="columnheader">
        Name
      </div>
      
      {columnVisibility.showSize && (
        <div className="w-20 shrink-0 text-right pr-4" role="columnheader">
          Size
        </div>
      )}

      {columnVisibility.showModified && (
        <div className="w-24 shrink-0 text-right" role="columnheader">
          Modified
        </div>
      )}
    </div>
  );
});

/**
 * Empty state when directory is empty
 */
function EmptyDirectory() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center">
        <Folder className="w-12 h-12 text-theme-muted fill-current mx-auto mb-3" />
        <p className="text-theme-muted text-sm">This folder is empty</p>
      </div>
    </div>
  );
}

/**
 * Loading state
 */
function LoadingStateInternal() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center">
        <RefreshCw className="w-8 h-8 text-theme-muted mx-auto mb-3 animate-spin" />
        <p className="text-theme-muted text-sm">Loading...</p>
      </div>
    </div>
  );
}

interface FileDetailsSidebarProps {
  file: FileEntry | null;
  gitStatus?: string;
  isLfs?: boolean;
  lockOwner?: string;
  isOwnLock?: boolean;
  onClose: () => void;
  onPreview?: (file: FileEntry) => void;
  onOpenInApp?: (file: FileEntry) => void;
  onMoveToTrash?: (file: FileEntry) => void;
  onLockLfs?: (file: FileEntry) => void;
  onUnlockLfs?: (file: FileEntry, force: boolean) => void;
}

/**
 * Right sidebar showing file details and actions
 */
const FileDetailsSidebar = memo(function FileDetailsSidebar({ file, gitStatus, isLfs, lockOwner, isOwnLock, onClose, onPreview, onOpenInApp, onMoveToTrash, onLockLfs, onUnlockLfs }: FileDetailsSidebarProps) {
  const Icon = file ? getFileIcon(file.name, file.isDirectory) : File;
  const statusColor = gitStatus ? GIT_STATUS_COLORS[gitStatus] : '';
  const statusLabel = gitStatus ? GIT_STATUS_LABELS[gitStatus] : '';

  // Check if this file has a viewer available
  const hasViewer = useMemo(() => {
    if (!file || file.isDirectory) return false;
    const viewer = getViewerForFile(file.name);
    return viewer && viewer.id !== 'unsupported';
  }, [file]);

  const handleRevealInFileManager = useCallback(async () => {
    if (!file) return;
    await revealInFileManager(file.path);
  }, [file]);

  const handleCopyPath = useCallback(async () => {
    if (!file) return;
    await copyTextToClipboard(file.path, 'Path copied to clipboard');
  }, [file]);

  const handlePreview = useCallback(() => {
    if (!file) return;
    onPreview?.(file);
  }, [file, onPreview]);

  const handleOpenInApp = useCallback(() => {
    if (!file) return;
    onOpenInApp?.(file);
  }, [file, onOpenInApp]);

  const handleMoveToTrash = useCallback(() => {
    if (!file) return;
    onMoveToTrash?.(file);
  }, [file, onMoveToTrash]);

  const isLocked = !!lockOwner;
  const lockDisabled = !isLfs || !!file?.isDirectory || isLocked;
  const unlockDisabled = !isLfs || !!file?.isDirectory || !isLocked || !isOwnLock;
  const forceUnlockDisabled = !isLfs || !!file?.isDirectory || !isLocked || !!isOwnLock;
  const handleLockLfs = useCallback(() => {
    if (!file) return;
    onLockLfs?.(file);
  }, [file, onLockLfs]);

  const handleUnlock = useCallback((force: boolean) => {
    if (!file) return;
    onUnlockLfs?.(file, force);
  }, [file, onUnlockLfs]);

  if (!file) return null;

  return (
    <div className="w-72 shrink-0 bg-fb-sidebar border-l border-theme-default flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-default">
        <h3 className="text-sm font-semibold text-theme-primary truncate">Details</h3>
        <button
          onClick={onClose}
          className="p-1 hover:bg-fb-hover rounded text-theme-muted hover:text-theme-primary transition-colors"
          title="Close details"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* File Info */}
      <div className="flex-1 overflow-auto p-4">
        {/* Icon and Name */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="mb-3 text-theme-muted">
            <Icon className={`w-16 h-16 ${file.isDirectory ? 'fill-current' : ''}`} />
          </div>
          <h4 className={`text-sm font-medium break-all ${statusColor || 'text-theme-primary'}`}>
            {file.name}
          </h4>
          {gitStatus && (
            <span className={`text-xs mt-1 ${GIT_STATUS_COLORS[gitStatus]}`}>
              {statusLabel} - {gitStatus.charAt(0).toUpperCase() + gitStatus.slice(1)}
            </span>
          )}
          {isLfs && (
            <span className="flex items-center gap-1 text-xs mt-1 text-blue-400">
              <Box className="w-3 h-3" /> LFS Tracked
            </span>
          )}
          {isLocked && (
            <span className={`flex items-center gap-1 text-xs mt-1 ${isOwnLock ? 'text-blue-400' : 'text-amber-400'}`}>
              <Lock className="w-3 h-3" /> Locked by {lockOwner}
            </span>
          )}
        </div>

        {/* File Properties */}
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-theme-muted">Type</span>
            <span className="text-theme-primary">
              {file.isDirectory ? 'Folder' : file.name.split('.').pop()?.toUpperCase() || 'File'}
            </span>
          </div>
          {!file.isDirectory && file.size !== undefined && (
            <div className="flex justify-between">
              <span className="text-theme-muted">Size</span>
              <span className="text-theme-primary">{formatFileSize(file.size)}</span>
            </div>
          )}
          {file.modTime && (
            <div className="flex justify-between">
              <span className="text-theme-muted">Modified</span>
              <span className="text-theme-primary">{formatDate(file.modTime)}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 pt-4 border-t border-theme-muted">
          <h5 className="text-xs font-medium text-theme-muted mb-3 uppercase tracking-wider">Actions</h5>
          <div className="space-y-1">
            {/* Preview - primary style */}
            {hasViewer && (
              <button
                className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                onClick={handlePreview}
              >
                <Eye className="w-4 h-4" />
                <span>Preview</span>
              </button>
            )}
            {/* Open in Default App */}
            {!file.isDirectory && (
              <button
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-theme-primary hover:bg-fb-hover rounded transition-colors"
                onClick={handleOpenInApp}
              >
                <ExternalLink className="w-4 h-4" />
                <span>Open in Default App</span>
              </button>
            )}
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-theme-primary hover:bg-fb-hover rounded transition-colors"
              onClick={handleRevealInFileManager}
            >
              <FolderOpen className="w-4 h-4" />
              <span>Reveal in {FILE_MANAGER_NAME}</span>
            </button>
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-theme-primary hover:bg-fb-hover rounded transition-colors"
              onClick={handleCopyPath}
            >
              <Clipboard className="w-4 h-4" />
              <span>Copy Path</span>
            </button>
            {/* Git LFS Lock */}
            {!file.isDirectory && (
              <button
                disabled={lockDisabled}
                title={lockDisabled ? 'Only available for Git LFS tracked files' : 'Lock this file with Git LFS'}
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded transition-colors ${
                  lockDisabled
                    ? 'text-theme-muted opacity-50 cursor-not-allowed'
                    : 'text-theme-primary hover:bg-fb-hover'
                }`}
                onClick={handleLockLfs}
              >
                <Lock className="w-4 h-4" />
                <span>Lock File (LFS)</span>
              </button>
            )}
            {!file.isDirectory && (
              <button
                disabled={unlockDisabled}
                title={unlockDisabled ? 'Only available for files locked by you' : 'Unlock this file'}
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded transition-colors ${
                  unlockDisabled
                    ? 'text-theme-muted opacity-50 cursor-not-allowed'
                    : 'text-theme-primary hover:bg-fb-hover'
                }`}
                onClick={() => handleUnlock(false)}
              >
                <Lock className="w-4 h-4" />
                <span>Unlock File (LFS)</span>
              </button>
            )}
            {!file.isDirectory && (
              <button
                disabled={forceUnlockDisabled}
                title={forceUnlockDisabled ? 'Only available for files locked by someone else' : 'Force unlock this file'}
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded transition-colors ${
                  forceUnlockDisabled
                    ? 'text-theme-muted opacity-50 cursor-not-allowed'
                    : 'text-red-400 hover:bg-red-500/10'
                }`}
                onClick={() => handleUnlock(true)}
              >
                <Lock className="w-4 h-4" />
                <span>Force Unlock (LFS)</span>
              </button>
            )}
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-theme-primary hover:bg-fb-hover rounded transition-colors"
              onClick={() => toast.info('Download coming soon')}
            >
              <Download className="w-4 h-4" />
              <span>Download</span>
            </button>
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded transition-colors"
              onClick={handleMoveToTrash}
            >
              <Trash2 className="w-4 h-4" />
              <span>Move to Trash</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

interface SimpleFileBrowserProps {
  repoPath: string | null;
}

/**
 * Virtualized file table component for list view
 */
interface VirtualizedFileTableProps {
  files: FileEntry[];
  gitStatusMap: Record<string, string>;
  lfsFilesSet: Set<string>;
  lockOwnerByName: Record<string, string>;
  isOwnLockByName: Record<string, boolean>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDoubleClick: (file: FileEntry) => void;
  onPreview: (file: FileEntry) => void;
  onContextAction: (action: FileContextAction, file: FileEntry) => void;
}

function VirtualizedFileTable({ 
  files, 
  gitStatusMap, 
  lfsFilesSet,
  lockOwnerByName,
  isOwnLockByName,
  selectedPath, 
  onSelect, 
  onDoubleClick,
  onPreview,
  onContextAction,
}: VirtualizedFileTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { width } = useWindowSize();

  const columnVisibility = useMemo<ListColumnVisibility>(() => ({
    showSize: width >= LIST_COLUMN_BREAKPOINTS.hideSize,
    showModified: width >= LIST_COLUMN_BREAKPOINTS.hideModified,
  }), [width]);
  
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36, // 9 * 4 = 36px (h-9)
    overscan: 10, // Render 10 extra items above/below viewport
  });

  return (
    <div 
      ref={parentRef} 
      className="flex-1 overflow-auto"
      role="table"
      aria-label="Files"
    >
      <FileTableHeader columnVisibility={columnVisibility} />
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
        role="rowgroup"
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              key={file.path}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <FileTableRow
                file={file}
                gitStatus={gitStatusMap[file.name]}
                isLfs={lfsFilesSet.has(file.name)}
                lockOwner={lockOwnerByName[file.name]}
                isOwnLock={isOwnLockByName[file.name]}
                columnVisibility={columnVisibility}
                isSelected={selectedPath === file.path}
                onSelect={() => onSelect(file.path)}
                onDoubleClick={() => onDoubleClick(file)}
                onPreview={() => onPreview(file)}
                onContextAction={onContextAction}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Main SimpleFileBrowser component
 */
function SimpleFileBrowser({ repoPath }: SimpleFileBrowserProps) {
  const { width } = useWindowSize();
  const showDetailsPanel = width >= DETAILS_PANEL_BREAKPOINT;

  const [currentPath, setCurrentPath] = useState<string | null>(repoPath);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [lfsFiles, setLfsFiles] = useState<Set<string>>(new Set());

  const [gitUser, setGitUser] = useState<string>('');
  const [lockOwnerByName, setLockOwnerByName] = useState<Record<string, string>>({});
  const [lockRefreshKey, setLockRefreshKey] = useState(0);

  const [lockedOpenModal, setLockedOpenModal] = useState<{ open: boolean; file: FileEntry | null; owner: string }>({
    open: false,
    file: null,
    owner: '',
  });

  const [forceUnlockModal, setForceUnlockModal] = useState<{ open: boolean; file: FileEntry | null; owner: string }>({
    open: false,
    file: null,
    owner: '',
  });
  
  const { repoStatus, syncRepo, isSyncing, refreshProjectDefaultBranch, generatePreview } = useRepo();
  const { openExplorerTab } = useLayout();

  const isOwnLockByName = useMemo(() => {
    const out: Record<string, boolean> = {};
    if (!gitUser) return out;
    for (const [name, owner] of Object.entries(lockOwnerByName)) {
      out[name] = owner === gitUser;
    }
    return out;
  }, [gitUser, lockOwnerByName]);

  // Reset current path when repo changes
  useEffect(() => {
    setCurrentPath(repoPath);
    setSelectedPath(null);
  }, [repoPath]);

  // Load git user for lock ownership comparisons
  useEffect(() => {
    if (!repoPath) {
      setGitUser('');
      return;
    }

    let aborted = false;
    (async () => {
      try {
        const user = await GetGitUser(repoPath);
        if (!aborted) setGitUser(user);
      } catch {
        if (!aborted) setGitUser('');
      }
    })();

    return () => { aborted = true; };
  }, [repoPath]);

  // Clear selection when navigating to a new directory
  useEffect(() => {
    setSelectedPath(null);
  }, [currentPath]);

  // Subscribe to file change events with debouncing.
  // Industry standard: coalesce rapid FS events into a single directory refresh.
  // On Windows, fsnotify/ReadDirectoryChangesW can fire multiple events per
  // file operation — without debouncing, each event triggers a full reload.
  useEffect(() => {
    if (!currentPath) return;
    
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const normalizedCurrentPath = normalizePathSeparators(currentPath);
    
    const handleFileChanged = (ev: { data?: { path?: string } }) => {
      const changedPathRaw = ev.data?.path;
      if (!changedPathRaw) return;

      const changedPath = normalizePathSeparators(changedPathRaw);
      if (changedPath === normalizedCurrentPath || changedPath.startsWith(`${normalizedCurrentPath}/`)) {
        // Reset debounce timer on each event — only the last one fires
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          setRefreshTrigger(prev => prev + 1);
        }, 500);
      }
    };
    
    const unsubscribe = onEvent('files-changed', handleFileChanged);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [currentPath]);

  // Build git status map
  const gitStatusMap = useMemo(
    () => buildGitStatusMap(repoStatus, currentPath, repoPath),
    [repoStatus, currentPath, repoPath]
  );

  // Load LFS tracked files list.
  // Also re-run when repo status changes so new auto-tracked files update
  // their LFS badges immediately (without requiring explorer reload).
  useEffect(() => {
    if (!repoPath) {
      setLfsFiles(new Set());
      return;
    }

    let aborted = false;
    (async () => {
      try {
        const fileList = await LFSLsFiles(repoPath);
        if (aborted) return;
        // LFSLsFiles returns paths relative to repo root
        // Extract just the file names for files in the current directory
        const lfsSet = new Set<string>();
        const relCurrentPath = getRelativePathFromRoot(currentPath, repoPath);
        for (const filePath of fileList) {
          const dir = filePath.includes('/')
            ? filePath.substring(0, filePath.lastIndexOf('/'))
            : '';
          if (dir === relCurrentPath) {
            const name = filePath.split('/').pop();
            if (name) lfsSet.add(name);
          }
        }
        setLfsFiles(lfsSet);
      } catch {
        // LFS not available or error — silently ignore
        if (!aborted) setLfsFiles(new Set());
      }
    })();
    return () => { aborted = true; };
  }, [repoPath, currentPath, repoStatus]);

  // Load LFS locks for the current directory (repo-wide locks filtered to current folder)
  useEffect(() => {
    if (!repoPath) {
      setLockOwnerByName({});
      return;
    }

    let aborted = false;
    (async () => {
      try {
        const locks = await LFSLocks(repoPath);
        if (aborted) return;

        const relCurrentPath = getRelativePathFromRoot(currentPath, repoPath);

        const map: Record<string, string> = {};
        for (const lock of locks) {
          const p = lock.path || '';
          if (!p) continue;
          const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
          if (dir !== relCurrentPath) continue;
          const name = p.split('/').pop();
          if (!name) continue;
          map[name] = lock.owner || '';
        }

        setLockOwnerByName(map);
      } catch {
        if (!aborted) setLockOwnerByName({});
      }
    })();

    return () => { aborted = true; };
  }, [repoPath, currentPath, lockRefreshKey]);

  const getRepoRelativePath = useCallback((absPath: string): string => {
    if (!repoPath) return normalizePathSeparators(absPath);
    const relative = getRelativePathFromRoot(absPath, repoPath);
    return relative || normalizePathSeparators(absPath);
  }, [repoPath]);

  // Track the last successfully loaded path so we can distinguish
  // "navigating to a new directory" from "in-place refresh of the same directory".
  const lastLoadedPathRef = useRef<string | null>(null);

  // Load directory contents.
  // Key anti-flicker strategy: only show the loading spinner when navigating
  // to a NEW directory. For in-place refreshes (file watcher events), keep
  // showing the previous file list while the new data loads.
  useEffect(() => {
    let aborted = false; // Guard against stale async responses on rapid navigation

    const loadDirectory = async () => {
      if (!currentPath) {
        setFiles([]);
        lastLoadedPathRef.current = null;
        return;
      }

      const isNewDirectory = currentPath !== lastLoadedPathRef.current;

      // Only show loading spinner for initial/navigation loads — NOT for
      // file-watcher refreshes. This prevents the null→loaded→null flicker.
      if (isNewDirectory) {
        setFiles(null);
      }
      setError(null);

      try {
        const result = await ListDirectoryWithOptions(currentPath, showHidden);
        if (aborted) return; // Stale response from a previous navigation
        if (result.error) {
          setError(result.error);
          setFiles([]);
        } else {
          // Sort: directories first, then files (alphabetically)
          const entries = (result.entries || []).sort((a: FileEntry, b: FileEntry) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
          });
          setFiles(entries);
          lastLoadedPathRef.current = currentPath;
        }
      } catch (err) {
        if (aborted) return;
        console.error('Failed to load directory:', err);
        setError('Failed to load directory');
        setFiles([]);
      }
    };

    loadDirectory();
    return () => { aborted = true; };
  }, [currentPath, showHidden, refreshTrigger]);

  // Handle navigation
  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  // Handle file selection (single click)
  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  // Handle in-app preview (for files with registered viewers)
  const handlePreview = useCallback((file: FileEntry) => {
    if (file.isDirectory) return;
    
    // Find a viewer for this file
    const viewer = getViewerForFile(file.name);
    
    // Only open in tab if we have a real viewer (not the unsupported fallback)
    if (viewer && viewer.id !== 'unsupported') {
      // Open in a tab with explicit viewerId
      const tab: ExplorerTab = {
        id: file.path,
        title: file.name,
        type: 'file',
        filePath: file.path,
        isPinned: false,
        viewerId: viewer.id,
      };
      openExplorerTab(tab);
    } else {
      toast.info('Preview not available for this file type');
    }
  }, [openExplorerTab]);

  // Handle open in default app (from sidebar)
  const handleOpenInApp = useCallback(async (file: FileEntry) => {
    if (file.isDirectory) return;
    try {
      const result = await OpenFile(file.path);
      if (!result.success) {
        toast.error(`Failed to open file: ${result.error}`);
      }
    } catch {
      toast.error('Failed to open file');
    }
  }, []);

  const attemptOpenWithLockWarning = useCallback(async (file: FileEntry) => {
    if (file.isDirectory) return;
    if (!repoPath) {
      toast.error('No repository open');
      return;
    }

    const isLfs = lfsFiles.has(file.name);
    const lockOwner = lockOwnerByName[file.name];

    // Only warn if file is LFS + locked by someone else.
    if (isLfs && lockOwner && lockOwner !== gitUser) {
      setLockedOpenModal({ open: true, file, owner: lockOwner });
      return;
    }

    await handleOpenInApp(file);
  }, [gitUser, handleOpenInApp, lfsFiles, lockOwnerByName, repoPath]);

  // Handle file/folder double-click - opens in default application
  const handleItemDoubleClick = useCallback(async (file: FileEntry) => {
    if (file.isDirectory) {
      setCurrentPath(file.path);
    } else {
      await attemptOpenWithLockWarning(file);
    }
  }, [attemptOpenWithLockWarning]);

  // Handle refresh
  const handleRefresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
    void refreshProjectDefaultBranch(true);
  }, [refreshProjectDefaultBranch]);

  const handleSync = useCallback(async () => {
    await syncRepo();
  }, [syncRepo]);

  // Handle toggle hidden files
  const handleToggleHidden = useCallback(() => {
    setShowHidden(prev => !prev);
  }, []);

  // Handle closing the sidebar (deselect file)
  const handleCloseSidebar = useCallback(() => {
    setSelectedPath(null);
  }, []);

  // Move file/folder to system trash
  const handleMoveToTrash = useCallback(async (file: FileEntry) => {
    try {
      const result = await MoveToTrash(file.path);
      if (!result.success) {
        toast.error(result.error || `Failed to move '${file.name}' to trash`);
        return;
      }

      toast.success(`Moved '${file.name}' to trash`);
      if (selectedPath === file.path) {
        setSelectedPath(null);
      }
      setRefreshTrigger(prev => prev + 1);
      setLockRefreshKey(k => k + 1);
    } catch (err) {
      console.error('MoveToTrash error:', err);
      toast.error(`Failed to move '${file.name}' to trash`);
    }
  }, [selectedPath]);

  // Find the selected file object
  const selectedFile = useMemo(() => {
    if (!selectedPath || !files) return null;
    return files.find(f => f.path === selectedPath) || null;
  }, [selectedPath, files]);

  // Handle keyboard events for preview and open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keyboard shortcuts when user is typing in an input, textarea, or contenteditable element
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      // Space bar triggers preview for selected file
      if (e.code === 'Space' && selectedFile && !selectedFile.isDirectory) {
        e.preventDefault();
        handlePreview(selectedFile);
      }

      // Enter key opens the selected file or enters the selected folder
      if (e.key === 'Enter' && selectedFile) {
        e.preventDefault();
        handleItemDoubleClick(selectedFile);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedFile, handlePreview, handleItemDoubleClick]);

  // Handle context menu actions
  const handleContextAction = useCallback(async (action: FileContextAction, file: FileEntry) => {
    switch (action) {
      case 'open':
        handleItemDoubleClick(file);
        break;
      case 'preview':
        handlePreview(file);
        break;
      case 'generate-preview':
        await generatePreview(file.path);
        setRefreshTrigger(previous => previous + 1);
        break;
      case 'lfs-lock':
        if (!repoPath) {
          toast.error('No repository open');
          break;
        }
        if (file.isDirectory) {
          toast.error('Cannot lock folders');
          break;
        }

        try {
          const relPath = getRepoRelativePath(file.path) || file.name;

          const result = await LFSLock(repoPath, relPath);
          if (result.success) {
            toast.success(result.message || `Locked '${file.name}'`);
            setLockRefreshKey(k => k + 1);
          } else {
            toast.error(result.error || result.message || 'Failed to lock file');
          }
        } catch (err) {
          console.error('LFSLock error:', err);
          toast.error('Failed to lock file');
        }
        break;
      case 'lfs-unlock':
        if (!repoPath) {
          toast.error('No repository open');
          break;
        }
        if (file.isDirectory) {
          toast.error('Cannot unlock folders');
          break;
        }

        try {
          const relPath = getRepoRelativePath(file.path);
          const result = await LFSUnlock(repoPath, relPath, false);
          if (result.success) {
            toast.success(result.message || `Unlocked '${file.name}'`);
            setLockRefreshKey(k => k + 1);
          } else {
            toast.error(result.error || result.message || 'Failed to unlock file');
          }
        } catch (err) {
          console.error('LFSUnlock error:', err);
          toast.error('Failed to unlock file');
        }
        break;
      case 'lfs-unlock-force': {
        if (!repoPath) {
          toast.error('No repository open');
          break;
        }
        const owner = lockOwnerByName[file.name] || '';
        setForceUnlockModal({ open: true, file, owner });
        break;
      }
      case 'reveal-in-finder':
        await revealInFileManager(file.path);
        break;
      case 'copy-path':
        await copyTextToClipboard(file.path, 'Path copied to clipboard');
        break;
      case 'copy-name':
        await copyTextToClipboard(file.name, 'Name copied to clipboard');
        break;
      case 'move-to-trash':
        await handleMoveToTrash(file);
        break;
      case 'share':
        toast.info('Share coming soon');
        break;
      case 'get-info':
        // Select the file to show details in sidebar
        setSelectedPath(file.path);
        break;
    }
  }, [getRepoRelativePath, handleItemDoubleClick, handleMoveToTrash, handlePreview, lockOwnerByName, repoPath, generatePreview]);

  const selectedLockOwner = selectedFile ? lockOwnerByName[selectedFile.name] : undefined;
  const selectedIsOwnLock = selectedFile ? isOwnLockByName[selectedFile.name] : undefined;

  const handleConfirmForceUnlock = useCallback(async () => {
    if (!repoPath || !forceUnlockModal.file) return;
    const file = forceUnlockModal.file;
    try {
      const relPath = getRepoRelativePath(file.path);
      const result = await LFSUnlock(repoPath, relPath, true);
      if (result.success) {
        toast.success(result.message || `Force unlocked '${file.name}'`);
        setLockRefreshKey(k => k + 1);
      } else {
        toast.error(result.error || result.message || 'Failed to force unlock file');
      }
    } catch (err) {
      console.error('LFSUnlock(force) error:', err);
      toast.error('Failed to force unlock file');
    } finally {
      setForceUnlockModal({ open: false, file: null, owner: '' });
    }
  }, [forceUnlockModal.file, getRepoRelativePath, repoPath]);

  const handleLockedOpenReadOnly = useCallback(async () => {
    const file = lockedOpenModal.file;
    if (!file) return;

    // We intentionally do NOT open an in-app viewer here.
    // "Read-only" is guidance to the user; we still open the default app.
    setLockedOpenModal({ open: false, file: null, owner: '' });
    toast.info('Opening in default app (treat as read-only)');
    await handleOpenInApp(file);
  }, [handleOpenInApp, lockedOpenModal.file]);

  return (
    <>
    <div className="flex flex-col h-full bg-fb-base">
      <div className="shrink-0 bg-viewer-header pb-3">
        <Breadcrumbs
          currentPath={currentPath}
          rootPath={repoPath}
          onNavigate={handleNavigate}
        />
        <div className="px-3">
          <Toolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            showHidden={showHidden}
            onShowHiddenChange={handleToggleHidden}
            onRefresh={handleRefresh}
            onSync={handleSync}
            isSyncing={isSyncing}
            currentPath={currentPath}
            repoPath={repoPath}
          />
        </div>
      </div>
      
      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}
      
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Main file listing area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {files === null ? (
            <LoadingStateInternal />
          ) : files.length === 0 ? (
            <EmptyDirectory />
          ) : viewMode === 'grid' ? (
            <div className="flex-1 overflow-auto bg-fb-base">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2 p-3">
                {files.map((file) => (
                  <FileItemGrid
                    key={file.path}
                    file={file}
                    gitStatus={gitStatusMap[file.name]}
                    isLfs={lfsFiles.has(file.name)}
                    lockOwner={lockOwnerByName[file.name]}
                    isOwnLock={isOwnLockByName[file.name]}
                    isSelected={selectedPath === file.path}
                    onSelect={() => handleSelect(file.path)}
                    onDoubleClick={() => handleItemDoubleClick(file)}
                    onPreview={() => handlePreview(file)}
                    onContextAction={handleContextAction}
                  />
                ))}
              </div>
            </div>
          ) : (
            <VirtualizedFileTable
              files={files}
              gitStatusMap={gitStatusMap}
              lfsFilesSet={lfsFiles}
              lockOwnerByName={lockOwnerByName}
              isOwnLockByName={isOwnLockByName}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              onDoubleClick={handleItemDoubleClick}
              onPreview={handlePreview}
              onContextAction={handleContextAction}
            />
          )}
        </div>

        {/* Right sidebar for file details (hidden on smaller screens) */}
        {showDetailsPanel && selectedFile && (
          <FileDetailsSidebar
            file={selectedFile}
            gitStatus={selectedFile ? gitStatusMap[selectedFile.name] : undefined}
            isLfs={selectedFile ? lfsFiles.has(selectedFile.name) : false}
            lockOwner={selectedLockOwner}
            isOwnLock={selectedIsOwnLock}
            onClose={handleCloseSidebar}
            onPreview={handlePreview}
            onOpenInApp={attemptOpenWithLockWarning}
            onMoveToTrash={handleMoveToTrash}
            onLockLfs={(file) => handleContextAction('lfs-lock', file)}
            onUnlockLfs={(file, force) => handleContextAction(force ? 'lfs-unlock-force' : 'lfs-unlock', file)}
          />
        )}
      </div>
    </div>

    {/* Locked-by-other warning modal */}
    <AlertDialog
      open={lockedOpenModal.open}
      onOpenChange={(open) => {
        if (!open) setLockedOpenModal({ open: false, file: null, owner: '' });
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>File is locked</AlertDialogTitle>
          <AlertDialogDescription>
            This file is locked by {lockedOpenModal.owner || 'another user'}. To avoid conflicts, open a read-only preview.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="default" onClick={handleLockedOpenReadOnly}>
            Open read-only
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Force unlock confirmation */}
    <AlertDialog
      open={forceUnlockModal.open}
      onOpenChange={(open) => {
        if (!open) setForceUnlockModal({ open: false, file: null, owner: '' });
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Force unlock this file?</AlertDialogTitle>
          <AlertDialogDescription>
            {forceUnlockModal.owner
              ? `This file is locked by ${forceUnlockModal.owner}. Forcing an unlock may interrupt their work.`
              : 'This file is locked by someone else. Forcing an unlock may interrupt their work.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirmForceUnlock}>
            Force unlock
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

export default memo(SimpleFileBrowser);
