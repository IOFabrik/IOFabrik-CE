/**
 * Shared constants for the IOFabrik frontend.
 * Centralizes configuration to ensure consistency across components.
 */

// ============================================================================
// Types
// ============================================================================

export interface SettingsCategory {
  id: string;
  name: string;
  description: string;
}

export interface IconSizes {
  xs: number;
  sm: number;
  md: number;
  lg: number;
}

// ============================================================================
// ICON SIZES
// Standard icon sizes in pixels for consistent UI scaling.
// Use these instead of hardcoded values.
// ============================================================================
export const ICON_SIZES: IconSizes = {
  xs: 14,  // Extra small - status indicators, inline icons
  sm: 16,  // Small - default for most icons
  md: 20,  // Medium - activity bar, prominent actions
  lg: 28,  // Large - profile avatars, main visual elements
} as const;

// ============================================================================
// VIEW TYPES
// Identifiers for sidebar views. Used by LayoutContext and navigation.
// ============================================================================
export const VIEWS = {
  EXPLORER: 'explorer',
  REVIEWS: 'reviews',
  REPO_SETTINGS: 'repo-settings',
  SETTINGS: 'settings',
  DEBUG: 'debug',
} as const;

export type ViewType = typeof VIEWS[keyof typeof VIEWS];

export const TIMELINE_HEIGHT = { DEFAULT: 160, MIN: 80, MAX: 320 } as const;

// ============================================================================
// FILE STATUS
// Git file status types mapped from GitService.
// Each status has an associated color class for visual distinction.
// ============================================================================
export const FILE_STATUS = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  UNTRACKED: 'untracked',
} as const;

export type FileStatusType = typeof FILE_STATUS[keyof typeof FILE_STATUS];

// Tailwind color classes for each file status
export const FILE_STATUS_COLORS: Record<FileStatusType, string> = {
  [FILE_STATUS.ADDED]: 'text-green-400',
  [FILE_STATUS.MODIFIED]: 'text-yellow-400',
  [FILE_STATUS.DELETED]: 'text-red-400',
  [FILE_STATUS.RENAMED]: 'text-blue-400',
  [FILE_STATUS.UNTRACKED]: 'text-gray-400',
};

// ============================================================================
// SETTINGS CATEGORIES
// Configuration for the settings view sidebar.
// ============================================================================
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'general', name: 'General', description: 'App preferences' },
  { id: 'git-config', name: 'Git Configuration', description: 'Name and email for commits' },
  { id: 'integrations', name: 'Integrations', description: 'Connect optional remote services' },
];

// ============================================================================
// WELCOME CATEGORIES
// Configuration for the welcome screen sidebar when no repo is open.
// ============================================================================
export const WELCOME_CATEGORIES: SettingsCategory[] = [
  { id: 'recent-projects', name: 'Recent Projects', description: 'Resume where you left off' },
  { id: 'new-project',     name: 'New Project',     description: 'Initialize a new repository' },
  { id: 'clone-project',   name: 'Clone Project',   description: 'Clone from GitHub' },
  { id: 'open-folder',     name: 'Open Folder',     description: 'Open an existing project folder' },
];

export type WelcomeCategoryId = typeof WELCOME_CATEGORIES[number]['id'];

// ============================================================================
// PROJECT SETUP STATES (Phase 12)
// Explicit project states derived from DetectRepo, Status, and GetRemotes.
// Used by ProjectSetupBanner and ExplorerStatusPanel for state-aware messaging.
// ============================================================================

export const PROJECT_STATES = {
  EMPTY_UNTRACKED: 'empty-untracked',
  HAS_FILES_UNTRACKED: 'has-files-untracked',
  TRACKED_NO_REMOTE: 'tracked-no-remote',
  TRACKED_WITH_REMOTE: 'tracked-with-remote',
  JUST_CREATED: 'just-created',
  NESTED_REPO: 'nested-repo',
} as const;

export type ProjectState = typeof PROJECT_STATES[keyof typeof PROJECT_STATES];

export interface ProjectStateConfig {
  id: ProjectState;
  title: string;
  subtitle: string;
  actionLabel?: string;
}

export const PROJECT_STATE_CONFIGS: Record<ProjectState, ProjectStateConfig> = {
  [PROJECT_STATES.EMPTY_UNTRACKED]: {
    id: PROJECT_STATES.EMPTY_UNTRACKED,
    title: 'Empty folder',
    subtitle: 'This folder is empty and not tracked. Start a new project?',
    actionLabel: 'Enable Version Control',
  },
  [PROJECT_STATES.HAS_FILES_UNTRACKED]: {
    id: PROJECT_STATES.HAS_FILES_UNTRACKED,
    title: 'Files found',
    subtitle: 'Files found but not tracked by Git. Enable version control?',
    actionLabel: 'Enable Version Control',
  },
  [PROJECT_STATES.TRACKED_NO_REMOTE]: {
    id: PROJECT_STATES.TRACKED_NO_REMOTE,
    title: 'Tracking changes locally. Consider creating a cloud backup',
    subtitle: 'Publish to GitHub for cloud backup and collaboration.',
    actionLabel: 'Publish to GitHub',
  },
  [PROJECT_STATES.TRACKED_WITH_REMOTE]: {
    id: PROJECT_STATES.TRACKED_WITH_REMOTE,
    title: 'Project synced',
    subtitle: 'Your project is connected to GitHub.',
  },
  [PROJECT_STATES.JUST_CREATED]: {
    id: PROJECT_STATES.JUST_CREATED,
    title: 'Project created',
    subtitle: 'Version control is ready. Start making changes!',
  },
  [PROJECT_STATES.NESTED_REPO]: {
    id: PROJECT_STATES.NESTED_REPO,
    title: 'Nested repository',
    subtitle: 'This folder is inside another git repository. Some features may behave unexpectedly.',
  },
};

// ============================================================================
// REPOSITORY SETTINGS CATEGORIES
// Configuration for the repository-level settings view sidebar.
// Organized from user's perspective.
// ============================================================================
export const REPO_SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'about', name: 'About', description: 'Repository information and details' },
  { id: 'branch-management', name: 'Branch Management', description: 'Rename and delete local branches safely' },
  { id: 'remote-sync', name: 'Remote Sync', description: 'How and when to sync with remote' },
  { id: 'large-files', name: 'Large Files (LFS)', description: 'Storage and download settings for large files' },
  { id: 'performance', name: 'Performance', description: 'Optimization and maintenance tasks' },
  { id: 'troubleshooting', name: 'Troubleshooting', description: 'Diagnose and fix repository issues' },
];

// ============================================================================
// EXPLORER TABS
// Tab types for the explorer main area with file browser as pinned tab.
// ============================================================================
export interface ExplorerTab {
  id: string;
  title: string;
  type: 'file-browser' | 'file' | 'diff' | 'commit';
  filePath?: string;
  isPinned?: boolean;
  /** Explicit viewer ID for file tabs. If not provided, auto-detected from filename. */
  viewerId?: string;
  /** For diff tabs: the diff context (working tree or commit) */
  diffContext?: {
    type: 'working' | 'commit';
    /** For working: path relative to repo root */
    relativePath?: string;
    /** For working: absolute path on disk */
    absolutePath?: string;
    /** For working: file status */
    status?: string;
    /** For commit: commit hash */
    commitHash?: string;
    /** For commit: parent commit hash */
    parentHash?: string;
    /** For commit: old path if renamed */
    oldPath?: string;
  };
  /** For commit tabs: selected commit to show in-place. */
  commitContext?: {
    commitHash: string;
  };
}

export const FILE_BROWSER_TAB: ExplorerTab = {
  id: 'file-browser',
  title: 'File Browser',
  type: 'file-browser',
  isPinned: true,
};

// ============================================================================
// PROTECTED BRANCHES
// Default protected branch names. These branches trigger nudges/warnings.
// Can be overridden by repository settings.
// ============================================================================
// Main branches where merge requests aren't suggested
export const MAIN_BRANCHES: string[] = ['main', 'master'];

// ============================================================================
// FILE EXTENSION COLORS
// Color classes for file icons based on extension.
// ============================================================================
export const EXTENSION_COLORS: Record<string, string> = {
  js: 'text-yellow-400',
  jsx: 'text-blue-400',
  ts: 'text-blue-500',
  tsx: 'text-blue-400',
  json: 'text-yellow-500',
  md: 'text-gray-300',
  go: 'text-cyan-400',
  py: 'text-green-400',
  html: 'text-orange-400',
  css: 'text-blue-300',
  scss: 'text-pink-400',
  yml: 'text-red-400',
  yaml: 'text-red-400',
  xml: 'text-orange-300',
  txt: 'text-gray-400',
};
