/**
 * RepoSettingsPage - Main area content for Repository Settings view.
 * Shows repository-specific settings forms organized by user perspective.
 */
import { memo, useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type ChangeEvent, type KeyboardEvent, type JSX } from 'react';
import { 
  Settings, 
  RefreshCw, 
  Play, 
  AlertTriangle, 
  Wrench, 
  HardDrive, 
  Clock, 
  Cloud, 
  Trash2,
  Zap,
  GitBranch,
  RotateCcw,
  Search,
  FileText,
  CheckCircle2,
  Plus,
  Check,
  Edit3,
  ArrowUpDown,
  Info,
  FolderGit2,
  Globe,
  MapPin,
} from 'lucide-react';
import { toast } from 'sonner';
import { REPO_SETTINGS_CATEGORIES, ICON_SIZES } from '../../../shared/constants';
import { useLayout, useRepo } from '../../../context';
import { 
  Button, 
  Card, 
  CardHeader, 
  CardTitle, 
  CardDescription, 
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Input,
  Label,
  Switch,
  Badge,
} from '../../../shared/ui';
import ProjectDefaultBranchCard from '../components/ProjectDefaultBranchCard';
import RewindConfirmModal from '../../../widgets/layout/RewindConfirmModal';
import {
  GetSettings,
  UpdateBackgroundTask,
  UpdateFetchSettings,
  UpdateLFSSettings,
  UpdateMaintenanceSettings,
  RunTaskNow,
  GetTaskStatuses,
  DiagnoseRepository,
  RemoveStaleLocks,
  AbortMerge,
  AbortCherryPick,
  RepairRepository,
  ResetToDefaults,
  RecoverFromDetachedHead,
} from '../../../../bindings/iofabrik/services/repositorysettingsservice';
import {
  AbortRevert,
  AbortBisect,
  AbortAM,
  AbortCurrentOperation,
  GetRemoteURL,
} from '../../../../bindings/iofabrik/services/gitservice';
import {
  IsLFSInstalled,
  IsLFSEnabled,
  InitializeLFS,
  GetPresetPatterns,
  GetTrackedPatterns,
  TrackPattern,
  UntrackPattern,
} from '../../../../bindings/iofabrik/services/lfsservice';
import { BackgroundTaskType, PresetPattern, TrackedPattern } from '../../../../bindings/iofabrik/services/models';
import { getFolderNameFromPath } from '../../../shared/utils/path';

// ============================================================================
// Types
// ============================================================================

interface TaskConfig {
  enabled: boolean;
  intervalMinutes: number;
}

interface TaskStatus {
  isRunning?: boolean;
  lastRun?: string;
  lastResult?: {
    success: boolean;
    error?: string;
  };
}

interface TaskStatuses {
  [key: string]: TaskStatus | null;
}

interface FetchSettings {
  fetchAllRemotes: boolean;
  pruneStaleBranches: boolean;
  fetchTags: boolean;
}

interface LFSSettings {
  autoFetch: boolean;
  fetchRecentDays: number;
  autoPrune: boolean;
  pruneKeepDays: number;
}

interface MaintenanceSettings {
  commitGraph: boolean;
  packRefs: boolean;
  looseObjects: boolean;
}

interface RepoSettings {
  fetchTask?: TaskConfig;
  lfsFetchTask?: TaskConfig;
  maintenanceTask?: TaskConfig;
  fetchSettings?: FetchSettings;
  lfsSettings?: LFSSettings;
  maintenanceSettings?: MaintenanceSettings;
  [key: string]: unknown;
}

interface DiagnosticsResult {
  issues?: string[];
  suggestions?: string[];
  hasStaleLocks?: boolean;
  hasMergeConflict?: boolean;
  hasRebaseInProgress?: boolean;
  hasCherryPickInProgress?: boolean;
  hasRevertInProgress?: boolean;
  hasBisectInProgress?: boolean;
  hasAMInProgress?: boolean;
  isDetachedHead?: boolean;
}

interface SettingRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

interface IntervalInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
}

interface BackgroundTaskCardProps {
  taskType: BackgroundTaskType;
  taskKey: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ style?: CSSProperties; className?: string }>;
  defaultInterval: number;
  settings: RepoSettings;
  taskStatuses: TaskStatuses;
  runningTask: BackgroundTaskType | null;
  onToggle: (taskType: BackgroundTaskType, enabled: boolean) => void;
  onIntervalChange: (taskType: BackgroundTaskType, interval: number) => void;
  onRunNow: (taskType: BackgroundTaskType) => void;
  /** When true, auto-scheduling toggle+interval are disabled with 'Coming Soon' badge. Run Now still works. */
  futureScope?: boolean;
}

interface PanelProps {
  settings: RepoSettings;
  onUpdate: () => void;
  repoPath: string;
}

interface LocalBranchRow {
  name: string;
  isCurrent: boolean;
  upstream?: string;
  lastUpdatedUnix?: number;
}

interface RenameBranchModalProps {
  open: boolean;
  branchName: string;
  isLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (newName: string) => Promise<void>;
}

interface BranchManagementPanelProps {
  repoPath: string;
}

interface DetachedHeadRecoveryProps {
  repoPath: string;
  onRecovered: () => void;
  isFixing: boolean;
  setIsFixing: (fixing: boolean) => void;
}

interface TroubleshootingPanelProps {
  repoPath: string;
}

const iconStyle: CSSProperties = { width: ICON_SIZES.md, height: ICON_SIZES.md };
const iconStyleSm: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

// ============================================================================
// Setting Row Component - Reusable row with switch toggle
// ============================================================================
const SettingRow = memo(function SettingRow({ 
  label, 
  description, 
  checked, 
  onChange, 
  disabled = false 
}: SettingRowProps): JSX.Element {
  return (
    <div className="flex items-center justify-between py-3 border-b border-theme-default last:border-b-0">
      <div className="flex-1 pr-4">
        <p className="text-theme-primary text-sm font-medium">{label}</p>
        {description && <p className="text-theme-muted text-xs mt-0.5">{description}</p>}
      </div>
      <Switch 
        checked={checked} 
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
});

// ============================================================================
// Interval Input Component - For timer settings
// ============================================================================
const IntervalInput = memo(function IntervalInput({ 
  label, 
  value, 
  onChange, 
  min = 1,
  max = 120,
  unit = 'minutes',
  disabled = false,
}: IntervalInputProps): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2">
      <Label className="text-theme-primary text-sm min-w-32">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => 
            onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))
          }
          min={min}
          max={max}
          disabled={disabled}
          className="w-20 h-8 text-sm"
        />
        <span className="text-theme-muted text-sm">{unit}</span>
      </div>
    </div>
  );
});

// ============================================================================
// Future Scope Wrapper - Greys out non-functional settings
// ============================================================================
const FutureScopeWrapper = memo(function FutureScopeWrapper({ 
  children, 
  label = 'Coming Soon' 
}: { children: React.ReactNode; label?: string }): JSX.Element {
  return (
    <div className="relative">
      <div className="opacity-40 pointer-events-none select-none">
        {children}
      </div>
      <div className="absolute top-3 right-3 z-10">
        <Badge variant="outline" className="text-xs bg-theme-surface border-amber-500/50 text-amber-400 pointer-events-auto">
          {label}
        </Badge>
      </div>
    </div>
  );
});

// ============================================================================
// Background Task Card - Reusable component for scheduled tasks
// ============================================================================
const BackgroundTaskCard = memo(function BackgroundTaskCard({
  taskType,
  taskKey,
  label,
  description,
  icon: Icon,
  defaultInterval,
  settings,
  taskStatuses,
  runningTask,
  onToggle,
  onIntervalChange,
  onRunNow,
  futureScope = false,
}: BackgroundTaskCardProps): JSX.Element {
  const config = settings[taskKey] as TaskConfig | undefined || { enabled: false, intervalMinutes: defaultInterval };
  const status = taskStatuses[taskType];

  return (
    <Card className="bg-theme-surface">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon style={iconStyleSm} className="text-theme-muted" />
            <CardTitle className="text-sm">{label}</CardTitle>
            {futureScope && (
              <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-400">Coming Soon</Badge>
            )}
            {status?.isRunning && (
              <Badge variant="outline" className="text-xs">Running</Badge>
            )}
          </div>
          <Switch 
            checked={config.enabled}
            onCheckedChange={(enabled: boolean) => onToggle(taskType, enabled)}
            disabled={futureScope}
          />
        </div>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className={futureScope ? 'opacity-40 pointer-events-none' : ''}>
            <IntervalInput
              label="Run every"
              value={config.intervalMinutes}
              onChange={(val: number) => onIntervalChange(taskType, val)}
              disabled={!config.enabled || futureScope}
              min={1}
              max={120}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRunNow(taskType)}
            disabled={runningTask === taskType}
            loading={runningTask === taskType}
          >
            <Play style={iconStyleSm} />
            Run Now
          </Button>
        </div>
        {status?.lastRun && (
          <p className="text-theme-muted text-xs mt-2">
            Last run: {new Date(status.lastRun).toLocaleString()}
            {status.lastResult && !status.lastResult.success && (
              <span className="text-red-400 ml-2">• Failed</span>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
});

// ============================================================================
// Remote Sync Settings Panel
// Combines: Auto-fetch background task + Fetch options
// ============================================================================
const RemoteSyncPanel = memo(function RemoteSyncPanel({ settings, onUpdate, repoPath }: PanelProps): JSX.Element {
  const [taskStatuses, setTaskStatuses] = useState<TaskStatuses>({});
  const [runningTask, setRunningTask] = useState<BackgroundTaskType | null>(null);

  const fetchSettings: FetchSettings = settings.fetchSettings || { 
    fetchAllRemotes: true, 
    pruneStaleBranches: true, 
    fetchTags: true 
  };

  const fetchStatuses = useCallback(async (): Promise<void> => {
    try {
      const statuses = await GetTaskStatuses();
      setTaskStatuses((statuses || {}) as TaskStatuses);
    } catch (err) {
      console.error('Failed to fetch task statuses:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 10000);
    return () => clearInterval(interval);
  }, [fetchStatuses]);

  const handleTaskToggle = async (taskType: BackgroundTaskType, enabled: boolean): Promise<void> => {
    try {
      const taskKey = 'fetchTask';
      const currentConfig = settings[taskKey] as TaskConfig | undefined || { enabled: false, intervalMinutes: 5 };
      await UpdateBackgroundTask(repoPath, taskType, {
        ...currentConfig,
        enabled,
      });
      onUpdate();
      toast.success(`Auto-sync ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update: ${errorMessage}`);
    }
  };

  const handleIntervalChange = async (taskType: BackgroundTaskType, intervalMinutes: number): Promise<void> => {
    try {
      const taskKey = 'fetchTask';
      const currentConfig = settings[taskKey] as TaskConfig | undefined || { enabled: true, intervalMinutes };
      await UpdateBackgroundTask(repoPath, taskType, {
        ...currentConfig,
        intervalMinutes,
      });
      onUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update interval: ${errorMessage}`);
    }
  };

  const handleRunNow = async (taskType: BackgroundTaskType): Promise<void> => {
    setRunningTask(taskType);
    try {
      const result = await RunTaskNow(repoPath, taskType);
      if (result.success) {
        toast.success('Sync completed');
      } else {
        toast.error(result.error || 'Sync failed');
      }
      fetchStatuses();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Sync failed: ${errorMessage}`);
    } finally {
      setRunningTask(null);
    }
  };

  const handleFetchSettingsChange = async (key: keyof FetchSettings, value: boolean): Promise<void> => {
    try {
      await UpdateFetchSettings(repoPath, {
        ...fetchSettings,
        [key]: value,
      });
      onUpdate();
      toast.success('Sync settings updated');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update: ${errorMessage}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Auto-sync task */}
      <BackgroundTaskCard
        taskType={BackgroundTaskType.TaskFetchAll}
        taskKey="fetchTask"
        label="Auto-sync with Remote"
        description="Automatically check for updates from the remote repository"
        icon={Cloud}
        defaultInterval={5}
        settings={settings}
        taskStatuses={taskStatuses}
        runningTask={runningTask}
        onToggle={handleTaskToggle}
        onIntervalChange={handleIntervalChange}
        onRunNow={handleRunNow}
      />

      {/* Fetch options */}
      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings style={iconStyle} className="text-theme-muted" />
            <CardTitle>Sync Options</CardTitle>
          </div>
          <CardDescription>Configure what gets synced from remote</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            label="Sync all remotes"
            description="Fetch from all configured remotes, not just origin"
            checked={fetchSettings.fetchAllRemotes}
            onChange={(val: boolean) => handleFetchSettingsChange('fetchAllRemotes', val)}
          />
          <SettingRow
            label="Clean up deleted branches"
            description="Remove local references to branches deleted on remote"
            checked={fetchSettings.pruneStaleBranches}
            onChange={(val: boolean) => handleFetchSettingsChange('pruneStaleBranches', val)}
          />
          <SettingRow
            label="Sync tags"
            description="Download all tags from remote"
            checked={fetchSettings.fetchTags}
            onChange={(val: boolean) => handleFetchSettingsChange('fetchTags', val)}
          />
        </CardContent>
      </Card>
    </div>
  );
});

// ============================================================================
// Large Files (LFS) Panel
// Combines: LFS initialization + settings + tracked patterns + background fetch
// ============================================================================

interface LFSStatusState {
  isInstalled: boolean;
  isEnabled: boolean;
  version?: string;
  hasError: boolean;
  error?: string;
  loading: boolean;
}

interface LFSPanelState {
  presetPatterns: PresetPattern[];
  trackedPatterns: TrackedPattern[];
  selectedPresets: Set<string>;
  customPattern: string;
  isInitializing: boolean;
  isAddingPattern: boolean;
}

const LargeFilesPanel = memo(function LargeFilesPanel({ settings, onUpdate, repoPath }: PanelProps): JSX.Element {
  const [taskStatuses, setTaskStatuses] = useState<TaskStatuses>({});
  const [runningTask, setRunningTask] = useState<BackgroundTaskType | null>(null);
  
  // LFS status state
  const [lfsStatus, setLfsStatus] = useState<LFSStatusState>({
    isInstalled: false,
    isEnabled: false,
    loading: true,
    hasError: false,
  });
  
  // LFS panel state for patterns
  const [panelState, setPanelState] = useState<LFSPanelState>({
    presetPatterns: [],
    trackedPatterns: [],
    selectedPresets: new Set<string>(),
    customPattern: '',
    isInitializing: false,
    isAddingPattern: false,
  });

  const lfsSettings: LFSSettings = settings.lfsSettings || { 
    autoFetch: true, 
    fetchRecentDays: 7, 
    autoPrune: false, 
    pruneKeepDays: 30 
  };

  // Check LFS installation and enabled status
  const checkLFSStatus = useCallback(async (): Promise<void> => {
    try {
      setLfsStatus(prev => ({ ...prev, loading: true }));
      
      const [isInstalled, lfsInfo, presets, tracked] = await Promise.all([
        IsLFSInstalled(),
        IsLFSEnabled(repoPath),
        GetPresetPatterns(),
        GetTrackedPatterns(repoPath).catch(() => []),
      ]);
      
      setLfsStatus({
        isInstalled,
        isEnabled: lfsInfo.enabled,
        version: lfsInfo.version,
        hasError: lfsInfo.hasError,
        error: lfsInfo.error,
        loading: false,
      });
      
      setPanelState(prev => ({
        ...prev,
        presetPatterns: presets || [],
        trackedPatterns: tracked || [],
      }));
    } catch (err) {
      console.error('Failed to check LFS status:', err);
      setLfsStatus({
        isInstalled: false,
        isEnabled: false,
        loading: false,
        hasError: true,
        error: err instanceof Error ? err.message : 'Failed to check LFS status',
      });
    }
  }, [repoPath]);

  useEffect(() => {
    checkLFSStatus();
  }, [checkLFSStatus]);

  const fetchStatuses = useCallback(async (): Promise<void> => {
    try {
      const statuses = await GetTaskStatuses();
      setTaskStatuses((statuses || {}) as TaskStatuses);
    } catch (err) {
      console.error('Failed to fetch task statuses:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 10000);
    return () => clearInterval(interval);
  }, [fetchStatuses]);

  // Initialize LFS for the repository
  const handleInitializeLFS = async (): Promise<void> => {
    setPanelState(prev => ({ ...prev, isInitializing: true }));
    try {
      const result = await InitializeLFS(repoPath);
      if (!result.success) {
        toast.error(result.error || 'Failed to initialize LFS');
        return;
      }
      // If there are selected presets, track them
      const selectedPatterns = Array.from(panelState.selectedPresets);
      for (const pattern of selectedPatterns) {
        await TrackPattern(repoPath, pattern);
      }
      
      toast.success(`Git LFS enabled${selectedPatterns.length > 0 ? ` with ${selectedPatterns.length} tracked patterns` : ''}`);
      await checkLFSStatus();
      onUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to initialize LFS: ${errorMessage}`);
    } finally {
      setPanelState(prev => ({ ...prev, isInitializing: false }));
    }
  };

  // Toggle a preset pattern selection
  const handleTogglePreset = (pattern: string): void => {
    setPanelState(prev => {
      const newSelected = new Set(prev.selectedPresets);
      if (newSelected.has(pattern)) {
        newSelected.delete(pattern);
      } else {
        newSelected.add(pattern);
      }
      return { ...prev, selectedPresets: newSelected };
    });
  };

  // Add a new pattern (when LFS is already enabled)
  const handleAddPattern = async (pattern: string): Promise<void> => {
    if (!pattern.trim()) return;
    
    setPanelState(prev => ({ ...prev, isAddingPattern: true }));
    try {
      const result = await TrackPattern(repoPath, pattern.trim());
      if (!result.success) {
        toast.error(result.error || 'Failed to track pattern');
        return;
      }
      toast.success(`Now tracking "${pattern}"`);
      setPanelState(prev => ({ ...prev, customPattern: '' }));
      await checkLFSStatus();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to track pattern: ${errorMessage}`);
    } finally {
      setPanelState(prev => ({ ...prev, isAddingPattern: false }));
    }
  };

  // Remove a tracked pattern
  const handleRemovePattern = async (pattern: string): Promise<void> => {
    try {
      const result = await UntrackPattern(repoPath, pattern);
      if (!result.success) {
        toast.error(result.error || 'Failed to untrack pattern');
        return;
      }
      toast.success(`Stopped tracking "${pattern}"`);
      await checkLFSStatus();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to untrack pattern: ${errorMessage}`);
    }
  };

  const handleTaskToggle = async (taskType: BackgroundTaskType, enabled: boolean): Promise<void> => {
    try {
      const currentConfig = settings.lfsFetchTask || { enabled: false, intervalMinutes: 10 };
      await UpdateBackgroundTask(repoPath, taskType, {
        ...currentConfig,
        enabled,
      });
      onUpdate();
      toast.success(`LFS auto-download ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update: ${errorMessage}`);
    }
  };

  const handleIntervalChange = async (taskType: BackgroundTaskType, intervalMinutes: number): Promise<void> => {
    try {
      const currentConfig = settings.lfsFetchTask || { enabled: true, intervalMinutes };
      await UpdateBackgroundTask(repoPath, taskType, {
        ...currentConfig,
        intervalMinutes,
      });
      onUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update interval: ${errorMessage}`);
    }
  };

  const handleRunNow = async (taskType: BackgroundTaskType): Promise<void> => {
    setRunningTask(taskType);
    try {
      const result = await RunTaskNow(repoPath, taskType);
      if (result.success) {
        toast.success('LFS download completed');
      } else {
        toast.error(result.error || 'LFS download failed');
      }
      fetchStatuses();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`LFS download failed: ${errorMessage}`);
    } finally {
      setRunningTask(null);
    }
  };

  const handleLFSSettingsChange = async (key: keyof LFSSettings, value: boolean | number): Promise<void> => {
    try {
      await UpdateLFSSettings(repoPath, {
        ...lfsSettings,
        [key]: value,
      });
      onUpdate();
      toast.success('LFS settings updated');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update: ${errorMessage}`);
    }
  };

  // Group presets by category
  const presetsByCategory = panelState.presetPatterns.reduce<Record<string, PresetPattern[]>>((acc, preset) => {
    const category = preset.category || 'other';
    if (!acc[category]) acc[category] = [];
    acc[category].push(preset);
    return acc;
  }, {});

  const categoryLabels: Record<string, string> = {
    industrial: 'Industrial Automation',
    archives: 'Archives',
    cad: 'CAD/CAM',
    media: 'Media Files',
    documents: 'Documents',
    other: 'Other',
  };

  // Loading state
  if (lfsStatus.loading) {
    return (
      <div className="space-y-4">
        <Card className="bg-theme-surface">
          <CardContent className="py-8">
            <div className="flex items-center justify-center gap-2 text-theme-muted">
              <RefreshCw style={iconStyle} className="animate-spin" />
              <span>Checking LFS status...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // LFS not installed
  if (!lfsStatus.isInstalled) {
    return (
      <div className="space-y-4">
        <Card className="bg-theme-surface border-yellow-500/30">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle style={iconStyle} className="text-yellow-500" />
              <CardTitle className="text-yellow-500">Git LFS Not Installed</CardTitle>
            </div>
            <CardDescription>
              Git Large File Storage (LFS) is not installed on your system. LFS is required to efficiently 
              manage large binary files like industrial automation projects, CAD files, and images.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-theme-secondary rounded-lg p-4 space-y-2">
              <p className="text-theme-primary text-sm font-medium">To install Git LFS:</p>
              <div className="space-y-1">
                <p className="text-theme-muted text-sm">• <strong>macOS:</strong> <code className="bg-theme-base px-1.5 py-0.5 rounded text-xs">brew install git-lfs</code></p>
                <p className="text-theme-muted text-sm">• <strong>Windows:</strong> Download from <code className="bg-theme-base px-1.5 py-0.5 rounded text-xs">git-lfs.com</code></p>
                <p className="text-theme-muted text-sm">• <strong>Linux:</strong> <code className="bg-theme-base px-1.5 py-0.5 rounded text-xs">apt install git-lfs</code> or <code className="bg-theme-base px-1.5 py-0.5 rounded text-xs">yum install git-lfs</code></p>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={checkLFSStatus}
                className="mt-3"
              >
                <RefreshCw style={iconStyleSm} />
                Check Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // LFS installed but not enabled for this repo
  if (!lfsStatus.isEnabled) {
    return (
      <div className="space-y-4">
        {/* Enable LFS Card */}
        <Card className="bg-theme-surface">
          <CardHeader>
            <div className="flex items-center gap-2">
              <HardDrive style={iconStyle} className="text-theme-muted" />
              <div>
                <CardTitle>Enable Large File Support</CardTitle>
                {lfsStatus.version && (
                  <Badge variant="outline" className="mt-1 text-xs">
                    {lfsStatus.version}
                  </Badge>
                )}
              </div>
            </div>
            <CardDescription>
              Git LFS helps you manage large files like industrial automation projects (*.acd, *.L5X), 
              CAD files, and other binary formats. Enable LFS to keep your repository fast and efficient.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Preset pattern selection */}
            <div className="space-y-3">
              <p className="text-theme-primary text-sm font-medium">
                Select file types to track with LFS (optional):
              </p>
              
              {Object.entries(presetsByCategory).map(([category, patterns]) => (
                <div key={category} className="space-y-2">
                  <p className="text-theme-muted text-xs uppercase tracking-wide">
                    {categoryLabels[category] || category}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {patterns.map((preset) => {
                      const isSelected = panelState.selectedPresets.has(preset.pattern);
                      return (
                        <button
                          key={preset.pattern}
                          onClick={() => handleTogglePreset(preset.pattern)}
                          className={`
                            flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs
                            transition-colors border
                            ${isSelected 
                              ? 'bg-blue-500/20 border-blue-500/50 text-blue-400' 
                              : 'bg-theme-secondary border-theme-default text-theme-muted hover:border-theme-hover hover:text-theme-primary'
                            }
                          `}
                          title={preset.description}
                        >
                          {isSelected && <Check style={{ width: 12, height: 12 }} />}
                          {preset.pattern}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              
              {panelState.selectedPresets.size > 0 && (
                <p className="text-theme-muted text-xs">
                  {panelState.selectedPresets.size} pattern{panelState.selectedPresets.size !== 1 ? 's' : ''} selected
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={handleInitializeLFS}
                disabled={panelState.isInitializing}
                loading={panelState.isInitializing}
              >
                <Zap style={iconStyleSm} />
                Enable LFS
              </Button>
              <p className="text-theme-muted text-xs">
                You can add more file patterns later
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // LFS is enabled - show full settings
  return (
    <div className="space-y-4">
      {/* LFS Status */}
      <Card className="bg-theme-surface">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 style={iconStyle} className="text-green-500" />
              <CardTitle>Large File Support Enabled</CardTitle>
            </div>
            {lfsStatus.version && (
              <Badge variant="outline" className="text-xs">
                {lfsStatus.version}
              </Badge>
            )}
          </div>
          <CardDescription>
            Git LFS is active for this repository. Large binary files will be stored efficiently.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Tracked Patterns */}
      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileText style={iconStyle} className="text-theme-muted" />
            <CardTitle>Tracked File Patterns</CardTitle>
          </div>
          <CardDescription>
            These file patterns are being managed by Git LFS. Add patterns for large files 
            that shouldn't be stored directly in the repository.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Current tracked patterns */}
          {panelState.trackedPatterns.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {panelState.trackedPatterns.map((tracked) => (
                <Badge 
                  key={tracked.pattern} 
                  variant="outline"
                  className="flex items-center gap-1 px-2 py-1"
                >
                  <HardDrive style={{ width: 12, height: 12 }} />
                  {tracked.pattern}
                  <button
                    onClick={() => handleRemovePattern(tracked.pattern)}
                    className="ml-1 hover:text-red-400 transition-colors"
                    title="Stop tracking this pattern"
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-theme-muted text-sm">
              No file patterns are being tracked yet. Add patterns below.
            </p>
          )}

          {/* Add new pattern */}
          <div className="space-y-3 pt-2 border-t border-theme-default">
            <p className="text-theme-primary text-sm font-medium pt-2">Add Pattern</p>
            
            {/* Quick add from presets */}
            <div className="space-y-2">
              <p className="text-theme-muted text-xs">Quick add from presets:</p>
              <div className="flex flex-wrap gap-1.5">
                {panelState.presetPatterns
                  .filter(p => !panelState.trackedPatterns.some(t => t.pattern === p.pattern))
                  .slice(0, 12)
                  .map((preset) => (
                    <button
                      key={preset.pattern}
                      onClick={() => handleAddPattern(preset.pattern)}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs
                        bg-theme-secondary border border-theme-default text-theme-muted 
                        hover:border-theme-hover hover:text-theme-primary transition-colors"
                      title={preset.description}
                      disabled={panelState.isAddingPattern}
                    >
                      <Plus style={{ width: 10, height: 10 }} />
                      {preset.pattern}
                    </button>
                  ))}
              </div>
            </div>

            {/* Custom pattern input */}
            <div className="flex items-center gap-2">
              <Input
                placeholder="*.custom or path/to/files/*"
                value={panelState.customPattern}
                onChange={(e: ChangeEvent<HTMLInputElement>) => 
                  setPanelState(prev => ({ ...prev, customPattern: e.target.value }))
                }
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    handleAddPattern(panelState.customPattern);
                  }
                }}
                className="flex-1 h-8 text-sm"
                disabled={panelState.isAddingPattern}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleAddPattern(panelState.customPattern)}
                disabled={!panelState.customPattern.trim() || panelState.isAddingPattern}
                loading={panelState.isAddingPattern}
              >
                <Plus style={iconStyleSm} />
                Add
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* LFS auto-download task */}
      <BackgroundTaskCard
        taskType={BackgroundTaskType.TaskLFSFetch}
        taskKey="lfsFetchTask"
        label="Auto-download Large Files"
        description="Automatically download large files for recent work in the background"
        icon={HardDrive}
        defaultInterval={10}
        settings={settings}
        taskStatuses={taskStatuses}
        runningTask={runningTask}
        onToggle={handleTaskToggle}
        onIntervalChange={handleIntervalChange}
        onRunNow={handleRunNow}
        futureScope
      />

      {/* LFS download options */}
      <FutureScopeWrapper>
        <Card className="bg-theme-surface">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock style={iconStyle} className="text-theme-muted" />
              <CardTitle>Download Settings</CardTitle>
            </div>
            <CardDescription>Configure which large files to download</CardDescription>
          </CardHeader>
          <CardContent>
            <IntervalInput
              label="Download files from last"
              value={lfsSettings.fetchRecentDays}
              onChange={(val: number) => handleLFSSettingsChange('fetchRecentDays', val)}
              unit="days"
              min={1}
              max={90}
              disabled
            />
            <p className="text-theme-muted text-xs mt-1">
              Only download large files that were modified within this time period
            </p>
          </CardContent>
        </Card>
      </FutureScopeWrapper>

      {/* Storage management */}
      <FutureScopeWrapper>
        <Card className="bg-theme-surface">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Trash2 style={iconStyle} className="text-theme-muted" />
              <CardTitle>Storage Management</CardTitle>
            </div>
            <CardDescription>Automatically clean up old large files to save disk space</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingRow
              label="Auto-clean old files"
              description="Automatically remove large files you haven't used recently"
              checked={lfsSettings.autoPrune}
              onChange={(val: boolean) => handleLFSSettingsChange('autoPrune', val)}
              disabled
            />
            <IntervalInput
              label="Keep files for at least"
              value={lfsSettings.pruneKeepDays}
              onChange={(val: number) => handleLFSSettingsChange('pruneKeepDays', val)}
              unit="days"
              min={7}
              max={365}
              disabled
            />
          </CardContent>
        </Card>
      </FutureScopeWrapper>
    </div>
  );
});

// ============================================================================
// About Panel
// Shows repository information: name, branch, remote URL, local path, etc.
// ============================================================================
interface AboutPanelProps {
  repoPath: string;
  repoInfo: { isRepo: boolean; branch: string } | null;
}

const AboutPanel = memo(function AboutPanel({ repoPath, repoInfo }: AboutPanelProps): JSX.Element {
  const { repoStatus, hasRemote } = useRepo();
  const [remoteUrl, setRemoteUrl] = useState<string>('');

  const repoName = repoPath ? getFolderNameFromPath(repoPath) || repoPath : '—';
  const currentBranch = repoInfo?.branch || repoStatus?.branch || '—';
  const changedFilesCount = repoStatus?.changedFiles?.length || 0;
  const ahead = repoStatus?.ahead || 0;
  const behind = repoStatus?.behind || 0;

  // Fetch remote URL
  useEffect(() => {
    const fetchRemote = async (): Promise<void> => {
      if (!repoPath) return;
      try {
        const url = await GetRemoteURL(repoPath);
        setRemoteUrl(url || '');
      } catch {
        setRemoteUrl('');
      }
    };
    fetchRemote();
  }, [repoPath]);

  const infoRows: { icon: typeof Info; label: string; value: string }[] = [
    { icon: FolderGit2, label: 'Repository', value: repoName },
    { icon: GitBranch, label: 'Current Branch', value: currentBranch },
    { icon: MapPin, label: 'Local Path', value: repoPath || '—' },
    { icon: Globe, label: 'Remote URL', value: remoteUrl || (hasRemote ? 'Loading...' : 'No remote configured') },
  ];

  return (
    <div className="space-y-4">
      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Info style={iconStyle} className="text-theme-muted" />
            <CardTitle>Repository Information</CardTitle>
          </div>
          <CardDescription>
            Details about this repository.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {infoRows.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-3 py-2 border-b border-theme-default last:border-0">
              <Icon style={iconStyle} className="text-theme-muted shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-theme-muted">{label}</p>
                <p className="text-sm text-theme-primary break-all">{value}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Info style={iconStyle} className="text-theme-muted" />
            <CardTitle>Status</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl font-light text-theme-primary">{changedFilesCount}</p>
              <p className="text-xs text-theme-muted">Changed Files</p>
            </div>
            <div>
              <p className="text-2xl font-light text-theme-primary">{ahead}</p>
              <p className="text-xs text-theme-muted">Ahead</p>
            </div>
            <div>
              <p className="text-2xl font-light text-theme-primary">{behind}</p>
              <p className="text-xs text-theme-muted">Behind</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
});

// ============================================================================
// Performance Panel
// Combines: Maintenance task + Maintenance settings
// ============================================================================
const PerformancePanel = memo(function PerformancePanel({ settings, onUpdate, repoPath }: PanelProps): JSX.Element {
  const [taskStatuses, setTaskStatuses] = useState<TaskStatuses>({});
  const [runningTask, setRunningTask] = useState<BackgroundTaskType | null>(null);

  const maintenanceSettings: MaintenanceSettings = settings.maintenanceSettings || { 
    commitGraph: true, 
    packRefs: false, 
    looseObjects: false 
  };

  const fetchStatuses = useCallback(async (): Promise<void> => {
    try {
      const statuses = await GetTaskStatuses();
      setTaskStatuses((statuses || {}) as TaskStatuses);
    } catch (err) {
      console.error('Failed to fetch task statuses:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 10000);
    return () => clearInterval(interval);
  }, [fetchStatuses]);

  const handleTaskToggle = async (taskType: BackgroundTaskType, enabled: boolean): Promise<void> => {
    try {
      const currentConfig = settings.maintenanceTask || { enabled: false, intervalMinutes: 30 };
      await UpdateBackgroundTask(repoPath, taskType, {
        ...currentConfig,
        enabled,
      });
      onUpdate();
      toast.success(`Auto-optimization ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update: ${errorMessage}`);
    }
  };

  const handleIntervalChange = async (taskType: BackgroundTaskType, intervalMinutes: number): Promise<void> => {
    try {
      const currentConfig = settings.maintenanceTask || { enabled: true, intervalMinutes };
      await UpdateBackgroundTask(repoPath, taskType, {
        ...currentConfig,
        intervalMinutes,
      });
      onUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update interval: ${errorMessage}`);
    }
  };

  const handleRunNow = async (taskType: BackgroundTaskType): Promise<void> => {
    setRunningTask(taskType);
    try {
      const result = await RunTaskNow(repoPath, taskType);
      if (result.success) {
        toast.success('Optimization completed');
      } else {
        toast.error(result.error || 'Optimization failed');
      }
      fetchStatuses();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Optimization failed: ${errorMessage}`);
    } finally {
      setRunningTask(null);
    }
  };

  const handleMaintenanceSettingsChange = async (key: keyof MaintenanceSettings, value: boolean): Promise<void> => {
    try {
      await UpdateMaintenanceSettings(repoPath, {
        ...maintenanceSettings,
        [key]: value,
      });
      onUpdate();
      toast.success('Optimization settings updated');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to update: ${errorMessage}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Auto-optimization task */}
      <BackgroundTaskCard
        taskType={BackgroundTaskType.TaskMaintenance}
        taskKey="maintenanceTask"
        label="Auto-optimize Repository"
        description="Periodically clean up and optimize the repository for better performance"
        icon={Zap}
        defaultInterval={30}
        settings={settings}
        taskStatuses={taskStatuses}
        runningTask={runningTask}
        onToggle={handleTaskToggle}
        onIntervalChange={handleIntervalChange}
        onRunNow={handleRunNow}
        futureScope
      />

      {/* Optimization tasks selection */}
      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wrench style={iconStyle} className="text-theme-muted" />
            <CardTitle>Optimization Tasks</CardTitle>
          </div>
          <CardDescription>Choose which optimizations to run. More tasks = better performance but longer runtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            label="Update commit graph"
            description="Speed up history browsing and branch operations (recommended)"
            checked={maintenanceSettings.commitGraph}
            onChange={(val: boolean) => handleMaintenanceSettingsChange('commitGraph', val)}
          />
          <SettingRow
            label="Compress branch references"
            description="Pack refs for slightly faster operations (adds a few seconds)"
            checked={maintenanceSettings.packRefs}
            onChange={(val: boolean) => handleMaintenanceSettingsChange('packRefs', val)}
          />
          <SettingRow
            label="Repack loose objects"
            description="Deep cleanup for maximum space savings (can take longer)"
            checked={maintenanceSettings.looseObjects}
            onChange={(val: boolean) => handleMaintenanceSettingsChange('looseObjects', val)}
          />
        </CardContent>
      </Card>
    </div>
  );
});

// ============================================================================
// Detached HEAD Recovery Component
// ============================================================================
const DetachedHeadRecovery = memo(function DetachedHeadRecovery({ 
  repoPath, 
  onRecovered, 
  isFixing, 
  setIsFixing 
}: DetachedHeadRecoveryProps): JSX.Element {
  const [branchName, setBranchName] = useState<string>('');
  const [error, setError] = useState<string>('');

  const handleCreateBranch = async (): Promise<void> => {
    if (!branchName.trim()) {
      setError('Please enter a branch name');
      return;
    }
    
    // Basic branch name validation
    if (!/^[a-zA-Z0-9_/-]+$/.test(branchName)) {
      setError('Branch name can only contain letters, numbers, underscores, hyphens, and slashes');
      return;
    }

    setIsFixing(true);
    setError('');
    try {
      const result = await RecoverFromDetachedHead(repoPath, branchName, '');
      if (result.success) {
        toast.success(`Created and switched to branch: ${branchName}`);
        setBranchName('');
        onRecovered();
      } else {
        setError(result.error || 'Failed to create branch');
        toast.error(result.error || 'Failed to create branch');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      toast.error(`Failed: ${errorMessage}`);
    } finally {
      setIsFixing(false);
    }
  };

  return (
    <Card className="bg-theme-surface border-blue-500/30">
      <CardHeader>
        <div className="flex items-center gap-2">
          <GitBranch style={iconStyle} className="text-blue-400" />
          <CardTitle className="text-blue-400">Not on Any Branch (Detached HEAD)</CardTitle>
        </div>
        <CardDescription>
          Your work isn't on a branch yet. Create a branch to save your changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="Enter new branch name (e.g., my-saved-work)"
            value={branchName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setBranchName(e.target.value);
              setError('');
            }}
            className="flex-1"
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleCreateBranch()}
          />
          <Button
            onClick={handleCreateBranch}
            disabled={isFixing || !branchName.trim()}
            loading={isFixing}
          >
            <GitBranch style={iconStyleSm} className="mr-1" />
            Create Branch
          </Button>
        </div>
        {error && (
          <p className="text-red-400 text-sm">{error}</p>
        )}
        <p className="text-theme-muted text-xs">
          This will create a new branch from your current position and switch to it, 
          preserving all your work.
        </p>
      </CardContent>
    </Card>
  );
});

// ============================================================================
// Troubleshooting Panel
// ============================================================================
const TroubleshootingPanel = memo(function TroubleshootingPanel({ repoPath }: TroubleshootingPanelProps): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isFixing, setIsFixing] = useState<boolean>(false);

  const runDiagnostics = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const result = await DiagnoseRepository(repoPath);
      setDiagnostics(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Diagnostics failed: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    if (repoPath) {
      runDiagnostics();
    }
  }, [repoPath, runDiagnostics]);

  const handleFix = async (
    action: (path: string) => Promise<{ success: boolean; error?: string }>, 
    label: string
  ): Promise<void> => {
    setIsFixing(true);
    try {
      const result = await action(repoPath);
      if (result.success) {
        toast.success(`${label} completed`);
        runDiagnostics();
      } else {
        toast.error(result.error || `${label} failed`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`${label} failed: ${errorMessage}`);
    } finally {
      setIsFixing(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle style={iconStyle} className="text-theme-muted" />
              <CardTitle>Repository Health Check</CardTitle>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={runDiagnostics}
              loading={isLoading}
            >
              <RefreshCw style={iconStyleSm} />
              Check Again
            </Button>
          </div>
          <CardDescription>Scan for common issues that might cause problems</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-theme-muted text-sm">Checking repository...</p>
          ) : diagnostics ? (
            <div className="space-y-3">
              {diagnostics.issues && diagnostics.issues.length > 0 ? (
                <div className="space-y-2">
                  {diagnostics.issues.map((issue, i) => (
                    <div key={i} className="flex items-start gap-2 p-2 bg-red-500/10 rounded border border-red-500/30">
                      <AlertTriangle style={iconStyleSm} className="text-red-400 mt-0.5 shrink-0" />
                      <p className="text-red-400 text-sm">{issue}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 p-2 bg-green-500/10 rounded border border-green-500/30">
                  <CheckCircle2 style={iconStyleSm} className="text-green-400" />
                  <p className="text-green-400 text-sm">Everything looks good! No issues detected.</p>
                </div>
              )}
              
              {diagnostics.suggestions && diagnostics.suggestions.length > 0 && (
                <div className="pt-2 border-t border-theme-default">
                  <p className="text-theme-muted text-xs mb-2">Suggestions:</p>
                  <ul className="space-y-1">
                    {diagnostics.suggestions.map((suggestion, i) => (
                      <li key={i} className="text-theme-secondary text-sm">• {suggestion}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-theme-muted text-sm">Click "Check Again" to scan for issues</p>
          )}
        </CardContent>
      </Card>

      {/* Quick Fix Actions */}
      <Card className="bg-theme-surface">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wrench style={iconStyle} className="text-theme-muted" />
            <CardTitle>Fix Common Problems</CardTitle>
          </div>
          <CardDescription>One-click fixes for common issues</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {diagnostics?.hasStaleLocks && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(RemoveStaleLocks, 'Remove stale locks')}
              disabled={isFixing}
            >
              <Trash2 style={iconStyleSm} className="mr-2" />
              Remove Stale Lock Files
              <span className="ml-auto text-theme-muted text-xs">Fixes "another git process" errors</span>
            </Button>
          )}
          {diagnostics?.hasMergeConflict && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(AbortMerge, 'Abort merge')}
              disabled={isFixing}
            >
              <AlertTriangle style={iconStyleSm} className="mr-2" />
              Cancel Stuck Merge
              <span className="ml-auto text-theme-muted text-xs">Reverts to before the merge started</span>
            </Button>
          )}
          {diagnostics?.hasRebaseInProgress && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(AbortCurrentOperation, 'Abort rebase')}
              disabled={isFixing}
            >
              <AlertTriangle style={iconStyleSm} className="mr-2" />
              Cancel Stuck Rebase
              <span className="ml-auto text-theme-muted text-xs">Reverts to before the rebase started</span>
            </Button>
          )}
          {diagnostics?.hasCherryPickInProgress && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(AbortCherryPick, 'Abort cherry-pick')}
              disabled={isFixing}
            >
              <AlertTriangle style={iconStyleSm} className="mr-2" />
              Cancel Stuck Cherry-Pick
              <span className="ml-auto text-theme-muted text-xs">Reverts to before the cherry-pick</span>
            </Button>
          )}
          {diagnostics?.hasRevertInProgress && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(AbortRevert, 'Abort revert')}
              disabled={isFixing}
            >
              <RotateCcw style={iconStyleSm} className="mr-2" />
              Cancel Stuck Revert
              <span className="ml-auto text-theme-muted text-xs">Reverts to before the revert started</span>
            </Button>
          )}
          {diagnostics?.hasBisectInProgress && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(AbortBisect, 'End bisect')}
              disabled={isFixing}
            >
              <Search style={iconStyleSm} className="mr-2" />
              End Bug Search (Bisect)
              <span className="ml-auto text-theme-muted text-xs">Exits bisect session</span>
            </Button>
          )}
          {diagnostics?.hasAMInProgress && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleFix(AbortAM, 'Abort patch application')}
              disabled={isFixing}
            >
              <FileText style={iconStyleSm} className="mr-2" />
              Cancel Patch Application
              <span className="ml-auto text-theme-muted text-xs">Aborts git am operation</span>
            </Button>
          )}
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => handleFix(RepairRepository, 'Repository repair')}
            disabled={isFixing}
          >
            <Wrench style={iconStyleSm} className="mr-2" />
            Deep Clean & Repair
            <span className="ml-auto text-theme-muted text-xs">Full maintenance check</span>
          </Button>
        </CardContent>
      </Card>

      {/* Detached HEAD Recovery */}
      {diagnostics?.isDetachedHead && (
        <DetachedHeadRecovery 
          repoPath={repoPath} 
          onRecovered={runDiagnostics}
          isFixing={isFixing}
          setIsFixing={setIsFixing}
        />
      )}
    </div>
  );
});

const RenameBranchModal = memo(function RenameBranchModal({
  open,
  branchName,
  isLoading,
  onOpenChange,
  onConfirm,
}: RenameBranchModalProps): JSX.Element | null {
  const [newName, setNewName] = useState('');
  const [acknowledgedRisk, setAcknowledgedRisk] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setNewName('');
      setAcknowledgedRisk(false);
    }
  }, [open, branchName]);

  const isValid = newName.trim().length > 0 && newName.trim() !== branchName && acknowledgedRisk;

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (!isValid || isLoading) return;
    await onConfirm(newName.trim());
  }, [isValid, isLoading, newName, onConfirm]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && isValid && !isLoading) {
      void handleConfirm();
    }
  }, [isValid, isLoading, handleConfirm]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} initialFocusRef={inputRef}>
      <DialogContent className="overflow-hidden" onKeyDown={handleKeyDown}>
        <DialogHeader className="border-b border-theme-default">
          <DialogTitle>Rename Branch</DialogTitle>
          <DialogDescription>Update the branch name locally and on remote.</DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 space-y-4">
          <div>
            <Label className="text-xs text-theme-secondary">Old branch name</Label>
            <Input value={branchName} disabled className="mt-1" />
          </div>

          <div>
            <Label className="text-xs text-theme-secondary">New branch name</Label>
            <Input
              ref={inputRef}
              value={newName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
              placeholder="feature/new-name"
              className="mt-1"
              disabled={isLoading}
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledgedRisk}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setAcknowledgedRisk(e.target.checked)}
              disabled={isLoading}
            />
            <span className="text-sm text-theme-secondary">
              I understand the risks related with renaming a branch.
            </span>
          </label>
        </div>

        <DialogFooter className="border-t border-theme-default px-6 py-4">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => void handleConfirm()} disabled={!isValid} loading={isLoading}>
            Rename Branch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

const BranchManagementPanel = memo(function BranchManagementPanel({ repoPath }: BranchManagementPanelProps): JSX.Element {
  const { branches, refreshBranches, renameBranch, deleteBranch } = useRepo();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<LocalBranchRow | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortBy, setSortBy] = useState<'name' | 'lastUpdatedUnix'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const TWO_WEEKS_SECONDS = 14 * 24 * 60 * 60;

  useEffect(() => {
    void refreshBranches();
  }, [repoPath, refreshBranches]);

  const localBranches: LocalBranchRow[] = (branches?.local || []).map((branch) => ({
    name: branch.name,
    isCurrent: branch.isCurrent,
    upstream: branch.upstream,
    lastUpdatedUnix: branch.lastUpdatedUnix,
  }));

  const handleSort = useCallback((column: 'name' | 'lastUpdatedUnix'): void => {
    if (sortBy === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(column);
    setSortDirection(column === 'name' ? 'asc' : 'desc');
  }, [sortBy]);

  const sortedBranches = useMemo(() => {
    const cloned = [...localBranches];
    cloned.sort((a, b) => {
      let result = 0;
      if (sortBy === 'name') {
        result = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else {
        const aTs = a.lastUpdatedUnix || 0;
        const bTs = b.lastUpdatedUnix || 0;
        result = aTs - bTs;
      }

      return sortDirection === 'asc' ? result : -result;
    });
    return cloned;
  }, [localBranches, sortBy, sortDirection]);

  const formatFriendlyDateTime = useCallback((unixTs?: number): string => {
    if (!unixTs || unixTs <= 0) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(unixTs * 1000));
    } catch {
      return '—';
    }
  }, []);

  const isInactiveBranch = useCallback((branch: LocalBranchRow): boolean => {
    const isProtected = branch.name === 'main' || branch.name === 'master';
    if (isProtected) return false;
    const ts = branch.lastUpdatedUnix || 0;
    if (ts <= 0) return false;
    const now = Math.floor(Date.now() / 1000);
    return now-ts > TWO_WEEKS_SECONDS;
  }, [TWO_WEEKS_SECONDS]);

  const openRename = useCallback((branch: LocalBranchRow): void => {
    setSelectedBranch(branch);
    setRenameOpen(true);
  }, []);

  const openDelete = useCallback((branch: LocalBranchRow): void => {
    setSelectedBranch(branch);
    setDeleteOpen(true);
  }, []);

  const handleRenameConfirm = useCallback(async (newName: string): Promise<void> => {
    if (!selectedBranch) return;

    setIsRenaming(true);
    try {
      const success = await renameBranch(selectedBranch.name, newName);
      if (success) {
        setRenameOpen(false);
        setSelectedBranch(null);
      }
    } finally {
      setIsRenaming(false);
    }
  }, [renameBranch, selectedBranch]);

  const handleDeleteConfirm = useCallback(async (): Promise<void> => {
    if (!selectedBranch) return;

    setIsDeleting(true);
    try {
      const success = await deleteBranch(selectedBranch.name);
      if (success) {
        setDeleteOpen(false);
        setSelectedBranch(null);
      }
    } finally {
      setIsDeleting(false);
    }
  }, [deleteBranch, selectedBranch]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-theme-primary flex items-center gap-2">
            <GitBranch style={iconStyleSm} />
            Branch Management
          </CardTitle>
          <CardDescription>
            Manage local branches and their remote-tracking metadata.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-primary transition-colors"
                    onClick={() => handleSort('name')}
                    title="Sort by branch name"
                  >
                    Branch Name
                    <ArrowUpDown style={iconStyleSm} />
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-theme-muted hover:text-theme-primary transition-colors"
                    onClick={() => handleSort('lastUpdatedUnix')}
                    title="Sort by last updated"
                  >
                    Last Updated
                    <ArrowUpDown style={iconStyleSm} />
                  </button>
                </TableHead>
                <TableHead className="w-28">Rename</TableHead>
                <TableHead className="w-28">Delete</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {localBranches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-theme-muted text-center py-8">
                    No local branches found.
                  </TableCell>
                </TableRow>
              ) : (
                sortedBranches.map((branch) => {
                  const isProtected = branch.name === 'main' || branch.name === 'master';
                  const cannotDelete = isProtected || branch.isCurrent;
                  const isInactive = isInactiveBranch(branch);

                  return (
                    <TableRow key={branch.name}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-theme-primary">{branch.name}</span>
                          {branch.isCurrent && <Badge variant="outline">Current</Badge>}
                          {isProtected && <Badge variant="outline">Protected</Badge>}
                          {isInactive && <Badge variant="outline">Inactive</Badge>}
                        </div>
                        <p className="text-xs text-theme-muted mt-1">
                          {branch.upstream ? `Tracks ${branch.upstream}` : 'No remote tracking branch'}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-theme-secondary">
                          {formatFriendlyDateTime(branch.lastUpdatedUnix)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openRename(branch)}
                          disabled={isProtected}
                          title={isProtected ? 'main/master cannot be renamed' : 'Rename branch'}
                        >
                          <Edit3 style={iconStyleSm} className="mr-1" />
                          Rename
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => openDelete(branch)}
                          disabled={cannotDelete}
                          title={
                            isProtected
                              ? 'main/master cannot be deleted'
                              : branch.isCurrent
                                ? 'Current branch cannot be deleted'
                                : 'Delete branch'
                          }
                        >
                          <Trash2 style={iconStyleSm} className="mr-1" />
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <p className="text-xs text-theme-muted mt-3">
            Protected branches (main/master) cannot be renamed or deleted. Current branch cannot be deleted.
          </p>
        </CardContent>
      </Card>

      <RenameBranchModal
        open={renameOpen}
        branchName={selectedBranch?.name || ''}
        isLoading={isRenaming}
        onOpenChange={(open) => {
          setRenameOpen(open);
          if (!open) {
            setSelectedBranch(null);
          }
        }}
        onConfirm={handleRenameConfirm}
      />

      <RewindConfirmModal
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) {
            setSelectedBranch(null);
          }
        }}
        onConfirm={handleDeleteConfirm}
        isLoading={isDeleting}
        title={selectedBranch ? `Delete Branch '${selectedBranch.name}'?` : 'Delete Branch?'}
        description="This will permanently delete the selected branch locally and on remote (if tracked)."
        warningText="⚠️ This cannot be undone. Make sure the branch is no longer needed."
        confirmButtonText="Delete Branch"
        confirmationWord="Delete"
      />
    </>
  );
});

// ============================================================================
// Main RepoSettingsPage Component
// ============================================================================
function RepoSettingsPage(): JSX.Element {
  const { selectedRepoSettingsCategory } = useLayout();
  const { repoPath, repoInfo, refreshRepoSettings, operationInProgress } = useRepo();
  const [settings, setSettings] = useState<RepoSettings | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const categoryInfo = REPO_SETTINGS_CATEGORIES.find(
    (c) => c.id === selectedRepoSettingsCategory
  ) || REPO_SETTINGS_CATEGORIES[0];

  const loadSettings = useCallback(async (): Promise<void> => {
    if (!repoPath) return;
    
    setIsLoading(true);
    try {
      const result = await GetSettings(repoPath);
      setSettings(result as unknown as RepoSettings);
      await refreshRepoSettings(repoPath);
    } catch (err) {
      console.error('Failed to load repo settings:', err);
      toast.error('Failed to load repository settings');
    } finally {
      setIsLoading(false);
    }
  }, [repoPath, refreshRepoSettings]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleResetToDefaults = async (): Promise<void> => {
    if (!repoPath) return;
    
    try {
      const result = await ResetToDefaults(repoPath);
      if (result.success) {
        toast.success('Settings reset to defaults');
        loadSettings();
      } else {
        toast.error(result.error || 'Failed to reset settings');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to reset: ${errorMessage}`);
    }
  };

  const renderCategoryContent = (): JSX.Element => {
    if (!repoPath || !repoInfo?.isRepo) {
      return (
        <div className="text-center py-12">
          <Settings style={{ width: 48, height: 48 }} className="text-theme-muted mx-auto mb-4" />
          <p className="text-theme-muted">Open a repository to configure settings</p>
        </div>
      );
    }

    if (isLoading || !settings) {
      return (
        <div className="text-center py-12">
          <RefreshCw style={{ width: 24, height: 24 }} className="text-theme-muted mx-auto mb-4 animate-spin" />
          <p className="text-theme-muted">Loading settings...</p>
        </div>
      );
    }

    switch (selectedRepoSettingsCategory) {
      case 'branch-management':
        return <BranchManagementPanel repoPath={repoPath} />;
      case 'remote-sync':
        return <RemoteSyncPanel settings={settings} onUpdate={loadSettings} repoPath={repoPath} />;
      case 'large-files':
        return <LargeFilesPanel settings={settings} onUpdate={loadSettings} repoPath={repoPath} />;
      case 'about':
        return <AboutPanel repoPath={repoPath} repoInfo={repoInfo} />;
      case 'performance':
        return <PerformancePanel settings={settings} onUpdate={loadSettings} repoPath={repoPath} />;
      case 'troubleshooting':
        return <TroubleshootingPanel repoPath={repoPath} />;
      default:
        return <></>;
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      {operationInProgress && <p role="status" className="px-8 pt-4 text-sm text-theme-secondary">Project settings are unavailable while an operation is in progress.</p>}
      <fieldset disabled={operationInProgress} className="min-w-0">
        <div className={`${selectedRepoSettingsCategory === 'branch-management' ? 'max-w-5xl' : 'max-w-2xl'} mx-auto p-8`}>
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <Settings style={{ width: 24, height: 24 }} className="text-theme-muted" />
                <h2 className="text-xl text-theme-primary font-medium">{categoryInfo.name}</h2>
              </div>
              {repoPath && repoInfo?.isRepo && selectedRepoSettingsCategory !== 'troubleshooting' && (
                <Button variant="ghost" size="sm" onClick={handleResetToDefaults}>
                  Reset to Defaults
                </Button>
              )}
            </div>
            <p className="text-theme-muted">{categoryInfo.description}</p>
            {repoPath && (
              <p className="text-theme-muted text-xs mt-1">
                Repository: {getFolderNameFromPath(repoPath)}
              </p>
            )}
          </div>

          {repoPath && repoInfo?.isRepo && <ProjectDefaultBranchCard />}
          {/* Category content */}
          {renderCategoryContent()}
        </div>
      </fieldset>
    </div>
  );
}

export default memo(RepoSettingsPage);
