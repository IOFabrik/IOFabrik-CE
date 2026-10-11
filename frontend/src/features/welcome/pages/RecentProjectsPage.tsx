/**
 * RecentProjectsPage - Welcome page showing recently opened projects.
 * 
 * Displays a table of recent folders with status icons indicating
 * whether each is a git repo with remote, local-only repo, or plain folder.
 * Merges frontend localStorage + backend settings for comprehensive history.
 */
import { memo, useState, useEffect, useCallback, useRef, type CSSProperties, type MouseEvent } from 'react';
import { Clock, GitBranch, HardDrive, Folder, X, Trash2, RotateCcw } from 'lucide-react';
import { ICON_STYLES } from '../../../shared/utils/gitHelpers';
import { loadMergedRecentFolders, removeRecentFolder, clearRecentFolders, getFolderName } from '../../../shared/utils/recentFolders';
import { ClearRecentFolders } from '../../../../bindings/iofabrik/services/settingsservice';
import { DetectRepo, GetRemoteURL } from '../../../../bindings/iofabrik/services/gitservice';

// ============================================================================
// Types
// ============================================================================

interface RecentProjectsPageProps {
  onOpenPath: (path: string) => Promise<boolean>;
}

type RepoStatus = 'remote' | 'local-only' | 'plain' | 'loading';

interface RecentProject {
  path: string;
  name: string;
  status: RepoStatus;
}

// ============================================================================
// Status Icon Component
// ============================================================================

const STATUS_CONFIG: Record<Exclude<RepoStatus, 'loading'>, { 
  Icon: typeof GitBranch; 
  className: string; 
  tooltip: string;
}> = {
  'remote':     { Icon: GitBranch,  className: 'text-green-400', tooltip: 'Git repo with remote' },
  'local-only': { Icon: HardDrive,  className: 'text-yellow-400', tooltip: 'Git repo (local only)' },
  'plain':      { Icon: Folder,     className: 'text-gray-400', tooltip: 'Not a git repository' },
};

function StatusIcon({ status }: { status: RepoStatus }): JSX.Element {
  if (status === 'loading') {
    return (
      <div className="w-4 h-4 rounded-full border-2 border-gray-500 border-t-transparent animate-spin" />
    );
  }

  const config = STATUS_CONFIG[status];
  const { Icon, className, tooltip } = config;

  return (
    <span title={tooltip}>
      <Icon style={ICON_STYLES.sm as CSSProperties} className={className} />
    </span>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect whether a folder is a git repo (with/without remote) or a plain folder.
 */
async function detectRepoStatus(path: string): Promise<RepoStatus> {
  try {
    const info = await DetectRepo(path);
    if (!info.isRepo) return 'plain';

    // Check if it has a remote configured
    try {
      const remoteUrl = await GetRemoteURL(path);
      return remoteUrl ? 'remote' : 'local-only';
    } catch {
      return 'local-only';
    }
  } catch {
    return 'plain';
  }
}

/**
 * Relative time formatting (e.g., "2 hours ago").
 * Placeholder — we don't have lastOpened timestamps yet,
 * so this is unused for now. Included for future integration.
 */
// function formatRelativeTime(date: Date): string { ... }

// ============================================================================
// Component
// ============================================================================

function RecentProjectsPage({ onOpenPath }: RecentProjectsPageProps): JSX.Element {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const statusCache = useRef<Map<string, RepoStatus>>(new Map());

  // Load recent folders and detect statuses
  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const paths = await loadMergedRecentFolders();
      
      // Set initial projects with loading status (unless cached)
      const initialProjects: RecentProject[] = paths.map(path => ({
        path,
        name: getFolderName(path),
        status: statusCache.current.get(path) || 'loading',
      }));
      setProjects(initialProjects);

      // Detect repo status for each path in parallel (skip if cached)
      const statusPromises = paths.map(async (path): Promise<{ path: string; status: RepoStatus }> => {
        if (statusCache.current.has(path)) {
          return { path, status: statusCache.current.get(path)! };
        }
        const status = await detectRepoStatus(path);
        statusCache.current.set(path, status);
        return { path, status };
      });

      const results = await Promise.all(statusPromises);

      // Update projects with resolved statuses
      setProjects(paths.map(path => {
        const result = results.find(r => r.path === path);
        return {
          path,
          name: getFolderName(path),
          status: result?.status || 'plain',
        };
      }));
    } catch (err) {
      console.error('Failed to load recent projects:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Handle removing a project from the recent list
  const handleRemove = useCallback((e: MouseEvent<HTMLButtonElement>, path: string) => {
    e.stopPropagation();
    removeRecentFolder(path);
    statusCache.current.delete(path);
    setProjects(prev => prev.filter(p => p.path !== path));
  }, []);

  // Handle clearing all recent folders
  const handleClearAll = useCallback(async () => {
    clearRecentFolders();
    try {
      await ClearRecentFolders();
    } catch {
      // Backend may not be available
    }
    statusCache.current.clear();
    setProjects([]);
  }, []);

  // Handle opening a project
  const handleOpen = useCallback((path: string) => {
    onOpenPath(path);
  }, [onOpenPath]);

  return (
    <div className="flex-1 flex items-start justify-center p-8 overflow-y-auto animate-screen-enter">
      <div className="max-w-3xl w-full">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Clock style={ICON_STYLES.md as CSSProperties} className="text-theme-muted" />
          <div>
            <h1 className="text-xl font-semibold text-theme-primary">Recent Projects</h1>
            <p className="text-theme-muted text-sm">Resume where you left off</p>
          </div>
        </div>

        {/* Loading state */}
        {isLoading && projects.length === 0 && (
          <div className="text-center py-16">
            <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin mx-auto mb-3" />
            <p className="text-theme-muted text-sm">Loading recent projects...</p>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && projects.length === 0 && (
          <div className="text-center py-16 border border-dashed border-theme-default rounded-lg">
            <Folder style={ICON_STYLES.xl as CSSProperties} className="text-theme-muted mx-auto mb-3" />
            <p className="text-theme-secondary text-sm mb-1">No recent projects</p>
            <p className="text-theme-muted text-xs">
              Start by creating a new project or opening a folder.
            </p>
          </div>
        )}

        {/* Last Opened project card */}
        {projects.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <RotateCcw style={ICON_STYLES.xs as CSSProperties} className="text-blue-400" />
              <span className="text-xs font-medium uppercase tracking-wide text-blue-400">Last Opened</span>
            </div>
            <button
              onClick={() => handleOpen(projects[0].path)}
              className="w-full flex items-center gap-4 p-4 bg-blue-500/10 border border-blue-500/25 rounded-lg hover:bg-blue-500/20 transition-colors cursor-pointer group text-left"
            >
              <div className="p-2.5 rounded-lg bg-blue-500/20 shrink-0">
                <StatusIcon status={projects[0].status} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-theme-primary text-sm font-semibold truncate">
                  {projects[0].name}
                </p>
                <p className="text-theme-muted text-xs truncate mt-0.5">
                  {projects[0].path}
                </p>
              </div>
              <span className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                Open →
              </span>
            </button>
          </div>
        )}

        {/* Projects table */}
        {projects.length > 0 && (
          <>
            <div className="border border-theme-default rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-theme-default bg-theme-elevated/50">
                    <th className="w-10 px-3 py-2 text-left" />
                    <th className="px-3 py-2 text-left text-theme-muted text-xs font-medium uppercase tracking-wide">Project</th>
                    <th className="px-3 py-2 text-left text-theme-muted text-xs font-medium uppercase tracking-wide hidden md:table-cell">Path</th>
                    <th className="w-10 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => (
                    <tr 
                      key={project.path}
                      onClick={() => handleOpen(project.path)}
                      className="border-b border-theme-default last:border-b-0 hover-bg-theme-interactive cursor-pointer transition-colors group"
                    >
                      {/* Status icon */}
                      <td className="px-3 py-2.5 text-center">
                        <StatusIcon status={project.status} />
                      </td>

                      {/* Project name */}
                      <td className="px-3 py-2.5">
                        <span className="text-theme-primary text-sm font-medium">
                          {project.name}
                        </span>
                        {/* Show path on mobile (hidden on md+) */}
                        <div className="text-theme-muted text-xs truncate md:hidden mt-0.5">
                          {project.path}
                        </div>
                      </td>

                      {/* Full path - hidden on small screens */}
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <span className="text-theme-muted text-xs truncate block max-w-md" title={project.path}>
                          {project.path}
                        </span>
                      </td>

                      {/* Remove button */}
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={(e) => handleRemove(e, project.path)}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-theme-subtle rounded transition-opacity"
                          title="Remove from recent"
                        >
                          <X style={ICON_STYLES.xs as CSSProperties} className="text-theme-muted" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer actions */}
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleClearAll}
                className="flex items-center gap-1.5 text-theme-muted text-xs hover:text-red-400 transition-colors"
              >
                <Trash2 style={ICON_STYLES.xs as CSSProperties} />
                Clear All
              </button>
            </div>
          </>
        )}

        {/* Status legend */}
        {projects.length > 0 && (
          <div className="mt-6 flex items-center gap-4 text-xs text-theme-muted">
            <span className="flex items-center gap-1.5">
              <GitBranch style={ICON_STYLES.xs as CSSProperties} className="text-green-400" />
              Remote repo
            </span>
            <span className="flex items-center gap-1.5">
              <HardDrive style={ICON_STYLES.xs as CSSProperties} className="text-yellow-400" />
              Local only
            </span>
            <span className="flex items-center gap-1.5">
              <Folder style={ICON_STYLES.xs as CSSProperties} className="text-gray-400" />
              Plain folder
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(RecentProjectsPage);
