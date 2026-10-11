/**
 * LayoutContext - Global UI state management for the application layout.
 * 
 * Manages:
 * - Active sidebar view (Explorer, Repository Settings, Settings, Debug)
 * - Sidebar collapse state and width
 * - Bottom panel collapse state, height, and active tab
 * - Theme preference (light/dark/system)
 * - Shared account dialog visibility
 * - Responsive auto-collapse based on window size
 */
import { 
  createContext, 
  useContext, 
  useState, 
  useCallback, 
  useMemo, 
  useEffect,
  useRef,
  type ReactNode 
} from 'react';
import { 
  VIEWS, 
  FILE_BROWSER_TAB,
  TIMELINE_HEIGHT,
  type ViewType, 
  type ExplorerTab 
} from '../shared/constants';
import { trackViewChanged, trackSettingsOpened } from '../domain/analytics/analytics';
import { useWindowSize } from '../shared/hooks/useWindowSize';
import { readMigratedStorage } from '../shared/utils/migratedStorage';
import { GetAppSettings, SaveAppSettings } from '../../bindings/iofabrik/services/settingsservice';
import { toast } from 'sonner';

// ============================================================================
// Types
// ============================================================================

export type Theme = 'light' | 'dark' | 'system';

interface LayoutContextValue {
  // Sidebar
  activeView: ViewType;
  setActiveView: (view: ViewType) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  timelineHeight: number;
  setTimelineHeight: (height: number, persist?: boolean) => void;
  
  // Settings
  selectedSettingsCategory: string;
  setSelectedSettingsCategory: (category: string) => void;
  developerModeEnabled: boolean;
  setDeveloperModeEnabled: (enabled: boolean) => void;

  // Account dialog
  accountDialogOpen: boolean;
  setAccountDialogOpen: (open: boolean) => void;
  openAccountDialog: () => void;
  
  // Repository Settings
  selectedRepoSettingsCategory: string;
  setSelectedRepoSettingsCategory: (category: string) => void;
  
  // Welcome
  selectedWelcomeCategory: string;
  setSelectedWelcomeCategory: (category: string) => void;
  newProjectPrefillPath: string;
  setNewProjectPrefillPath: (path: string) => void;
  
  // Explorer Tabs
  explorerTabs: ExplorerTab[];
  activeExplorerTab: string;
  openExplorerTab: (tab: ExplorerTab) => void;
  closeExplorerTab: (tabId: string) => void;
  setActiveExplorerTab: (tabId: string) => void;
  explorerMergeModalOpen: boolean;
  setExplorerMergeModalOpen: (open: boolean) => void;
  openExplorerMergeModal: () => void;
  
  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

interface LayoutProviderProps {
  children: ReactNode;
}

// ============================================================================
// Context
// ============================================================================

const LayoutContext = createContext<LayoutContextValue | null>(null);

// Default layout values
// Keep startup width at the current maximum allowed by Sidebar constraints.
const DEFAULT_SIDEBAR_WIDTH = 400;

// Global UI events emitted by RepoContext to keep explorer previews in sync
const CLOSE_ALL_PREVIEW_TABS_EVENT = 'iofabrik:explorer-close-all-previews';
const CLOSE_FILE_PREVIEW_TABS_EVENT = 'iofabrik:explorer-close-file-previews';

export function LayoutProvider({ children }: LayoutProviderProps): JSX.Element {
  // Responsive window size tracking
  const { shouldCollapseSidebar } = useWindowSize();
  
  // Track if user manually toggled panels (to not override their preference)
  // Initialize to true so that strictly on startup, it treats the default open state as intentional,
  // preventing immediate auto-collapse on smaller screens.
  const userToggledSidebar = useRef(true);
  
  // Sidebar state
  const [activeView, _setActiveView] = useState<ViewType>(VIEWS.EXPLORER);
  const previousView = useRef<ViewType>(VIEWS.EXPLORER);
  const [sidebarCollapsed, _setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [developerModeEnabled, setDeveloperModeEnabledState] = useState(false);
  const [timelineHeight, setTimelineHeightState] = useState<number>(TIMELINE_HEIGHT.DEFAULT);
  const timelineResized = useRef(false);
  const timelineSaves = useRef<Promise<void>>(Promise.resolve());

  const setTimelineHeight = useCallback((height: number, persist = true) => {
    if (!Number.isFinite(height)) return;
    const next = Math.round(Math.max(TIMELINE_HEIGHT.MIN, Math.min(height, TIMELINE_HEIGHT.MAX)));
    timelineResized.current = true;
    setTimelineHeightState(next);
    if (!persist) return;
    // Save only after a drag ends or a keyboard resize. Serialize writes so
    // rapid adjustments cannot persist an older height after the newest one.
    timelineSaves.current = timelineSaves.current.then(async () => {
      const settings = await GetAppSettings();
      await SaveAppSettings({ ...settings, timelineHeight: next });
    }).catch(() => {
      toast.error('Could not save Timeline height. Resize it again to retry.');
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void GetAppSettings()
      .then((settings) => {
        if (!cancelled) {
          setDeveloperModeEnabledState(settings.developerModeEnabled);
          const savedHeight = settings.timelineHeight;
          if (!timelineResized.current && Number.isFinite(savedHeight)
              && savedHeight >= TIMELINE_HEIGHT.MIN && savedHeight <= TIMELINE_HEIGHT.MAX) {
            setTimelineHeightState(savedHeight);
          }
        }
      })
      .catch(() => {
        // Keep developer-only tools hidden when settings cannot be loaded.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setDeveloperModeEnabled = useCallback((enabled: boolean) => {
    setDeveloperModeEnabledState(enabled);
  }, []);
  
  // Wrap setSidebarCollapsed to track user intent
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    userToggledSidebar.current = true;
    _setSidebarCollapsed(collapsed);
  }, []);
  
  // Auto-collapse sidebar based on window size vs sidebar width (if user hasn't manually toggled)
  useEffect(() => {
    const shouldCollapse = shouldCollapseSidebar(sidebarWidth);
    if (!userToggledSidebar.current && shouldCollapse) {
      _setSidebarCollapsed(true);
    }
  }, [shouldCollapseSidebar, sidebarWidth]);
  
  // Reset user toggle flag when window becomes wide enough for current sidebar
  useEffect(() => {
    const shouldCollapse = shouldCollapseSidebar(sidebarWidth);
    if (!shouldCollapse) {
      userToggledSidebar.current = false;
    }
  }, [shouldCollapseSidebar, sidebarWidth]);
  
  // Wrap setActiveView to track view changes
  const setActiveView = useCallback((view: ViewType) => {
    if (view === VIEWS.DEBUG && !developerModeEnabled) {
      return;
    }

    if (view !== previousView.current) {
      trackViewChanged({
        fromView: previousView.current,
        toView: view,
      });
      
      // Track settings opened specifically
      if (view === VIEWS.SETTINGS) {
        trackSettingsOpened({ category: 'general' });
      }
      
      previousView.current = view;
    }
    _setActiveView(view);
  }, [developerModeEnabled]);
  
  // Settings category state (shared between sidebar and main area)
  const [selectedSettingsCategory, setSelectedSettingsCategory] = useState('general');
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  const openAccountDialog = useCallback(() => {
    setAccountDialogOpen(true);
  }, []);
  
  // Repository settings category state (for repo-specific settings view)
  const [selectedRepoSettingsCategory, setSelectedRepoSettingsCategory] = useState('about');
  
  // Welcome category state (for welcome screen when no repo is open)
  const [selectedWelcomeCategory, setSelectedWelcomeCategory] = useState('recent-projects');
  const [newProjectPrefillPath, setNewProjectPrefillPath] = useState('');
  
  // Explorer tabs state - file browser is always the first (pinned) tab
  const [explorerTabs, setExplorerTabs] = useState<ExplorerTab[]>([FILE_BROWSER_TAB]);
  const [activeExplorerTab, setActiveExplorerTab] = useState<string>(FILE_BROWSER_TAB.id);
  const [explorerMergeModalOpen, setExplorerMergeModalOpen] = useState(false);

  const normalizePath = useCallback((path: string): string => path.replace(/\\/g, '/'), []);

  const tabMatchesRelativeFile = useCallback((tab: ExplorerTab, relativePath: string): boolean => {
    const normalizedRelative = normalizePath(relativePath).replace(/^\/+/, '');
    if (!normalizedRelative) return false;

    const tabRelativePath = tab.diffContext?.relativePath ? normalizePath(tab.diffContext.relativePath) : '';
    if (tabRelativePath && tabRelativePath === normalizedRelative) {
      return true;
    }

    const tabFilePath = tab.filePath ? normalizePath(tab.filePath) : '';
    if (!tabFilePath) return false;

    return tabFilePath === normalizedRelative || tabFilePath.endsWith(`/${normalizedRelative}`);
  }, [normalizePath]);

  const closeAllPreviewTabs = useCallback(() => {
    setExplorerTabs(prev => prev.filter(tab => tab.isPinned));
    setActiveExplorerTab(FILE_BROWSER_TAB.id);
  }, []);

  const closeTabsForFile = useCallback((relativePath: string) => {
    if (!relativePath) return;

    setExplorerTabs(prev => {
      const toRemove = prev
        .filter(tab => !tab.isPinned && tabMatchesRelativeFile(tab, relativePath))
        .map(tab => tab.id);

      if (toRemove.length === 0) {
        return prev;
      }

      setActiveExplorerTab(currentActive => (
        toRemove.includes(currentActive) ? FILE_BROWSER_TAB.id : currentActive
      ));

      return prev.filter(tab => !toRemove.includes(tab.id));
    });
  }, [tabMatchesRelativeFile]);
  
  // Theme state – read persisted value so login screen preference carries over
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = readMigratedStorage('iofabrik_theme', 'cz_theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  // System theme detection and application
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const applyTheme = (): void => {
      const isDark = theme === 'dark' || (theme === 'system' && mediaQuery.matches);
      document.documentElement.classList.toggle('dark', isDark);
      document.documentElement.classList.toggle('light', !isDark);
    };

    applyTheme();
    
    // Listen for system theme changes
    const handleChange = (): void => {
      if (theme === 'system') {
        applyTheme();
      }
    };
    
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Toggle handlers - memoized to prevent unnecessary re-renders
  const toggleSidebar = useCallback(() => {
    _setSidebarCollapsed(prev => !prev);
    userToggledSidebar.current = true;
  }, []);

  // Explorer tab handlers
  const openExplorerTab = useCallback((tab: ExplorerTab) => {
    setExplorerTabs(prev => {
      // Check if tab already exists
      const existingTab = prev.find(t => t.id === tab.id);
      if (existingTab) {
        return prev;
      }
      // Add new tab
      return [...prev, tab];
    });
    setActiveExplorerTab(tab.id);
  }, []);

  const closeExplorerTab = useCallback((tabId: string) => {
    setExplorerTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      // Cannot close pinned tabs
      if (tab?.isPinned) return prev;
      
      const newTabs = prev.filter(t => t.id !== tabId);
      return newTabs;
    });
    
    // If closing active tab, switch to file browser
    setActiveExplorerTab(prev => {
      if (prev === tabId) {
        return FILE_BROWSER_TAB.id;
      }
      return prev;
    });
  }, []);

  const openExplorerMergeModal = useCallback(() => {
    setExplorerMergeModalOpen(true);
  }, []);

  // Keep explorer previews/diffs in sync with repository operations and external edits.
  useEffect(() => {
    const handleCloseAll = () => {
      closeAllPreviewTabs();
    };

    const handleCloseFile = (event: Event) => {
      const customEvent = event as CustomEvent<{ relativePath?: string }>;
      const relativePath = customEvent.detail?.relativePath;
      if (!relativePath) return;
      closeTabsForFile(relativePath);
    };

    window.addEventListener(CLOSE_ALL_PREVIEW_TABS_EVENT, handleCloseAll);
    window.addEventListener(CLOSE_FILE_PREVIEW_TABS_EVENT, handleCloseFile as EventListener);

    return () => {
      window.removeEventListener(CLOSE_ALL_PREVIEW_TABS_EVENT, handleCloseAll);
      window.removeEventListener(CLOSE_FILE_PREVIEW_TABS_EVENT, handleCloseFile as EventListener);
    };
  }, [closeAllPreviewTabs, closeTabsForFile]);

  // Memoized context value to prevent unnecessary re-renders
  const value = useMemo<LayoutContextValue>(() => ({
    // Sidebar
    activeView,
    setActiveView,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    toggleSidebar,
    timelineHeight,
    setTimelineHeight,
    
    // Settings
    selectedSettingsCategory,
    setSelectedSettingsCategory,
    developerModeEnabled,
    setDeveloperModeEnabled,

    // Account dialog
    accountDialogOpen,
    setAccountDialogOpen,
    openAccountDialog,
    
    // Repository Settings
    selectedRepoSettingsCategory,
    setSelectedRepoSettingsCategory,
    
    // Welcome
    selectedWelcomeCategory,
    setSelectedWelcomeCategory,
    newProjectPrefillPath,
    setNewProjectPrefillPath,
    
    // Explorer Tabs
    explorerTabs,
    activeExplorerTab,
    openExplorerTab,
    closeExplorerTab,
    setActiveExplorerTab,
    explorerMergeModalOpen,
    setExplorerMergeModalOpen,
    openExplorerMergeModal,
    
    // Theme
    theme,
    setTheme,
  }), [
    activeView, 
    sidebarCollapsed, 
    sidebarWidth, 
    timelineHeight,
    setTimelineHeight,
    selectedSettingsCategory,
    developerModeEnabled,
    accountDialogOpen,
    selectedRepoSettingsCategory,
    selectedWelcomeCategory,
    newProjectPrefillPath,
    explorerTabs,
    activeExplorerTab,
    openExplorerTab,
    closeExplorerTab,
    explorerMergeModalOpen,
    openExplorerMergeModal,
    theme, 
    openAccountDialog,
    setDeveloperModeEnabled,
    toggleSidebar,
  ]);

  return (
    <LayoutContext.Provider value={value}>
      {children}
    </LayoutContext.Provider>
  );
}

/**
 * useLayout - Hook to access layout context.
 * Must be used within a LayoutProvider.
 */
export function useLayout(): LayoutContextValue {
  const context = useContext(LayoutContext);
  if (!context) {
    if (import.meta.hot) {
      import.meta.hot.invalidate('LayoutContext identity changed during HMR');
      return {} as LayoutContextValue;
    }
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
}
