/**
 * GeneralSettings - App preferences including theme selection and analytics consent.
 */
import { memo, useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';
import { BarChart3, Code2, FolderTree, Info, LogOut, Palette, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useLayout, useAuth, type Theme } from '../../../context';
import { ICON_SIZES, VIEWS } from '../../../shared/constants';
import { isWindowsDesktop } from '../../../shared/runtime/window';
import { 
  getAnalyticsConsent, 
  setAnalyticsConsent, 
  type AnalyticsConsent 
} from '../../../domain/analytics/analytics';
import {
  Button,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui';
import {
  GetAppSettings,
  GetDataLocations,
  SaveAppSettings,
} from '../../../../bindings/iofabrik/services/settingsservice';
import {
  CheckForUpdates,
  GetCurrentVersion,
} from '../../../../bindings/iofabrik/services/appupdateservice';
import { IsEnabled, SetEnabled } from '../../../../bindings/iofabrik/services/debugservice';
import type { AppSettings, DataLocations } from '../../../../bindings/iofabrik/services/models';

const iconStyle: CSSProperties = { width: ICON_SIZES.sm, height: ICON_SIZES.sm };

function formatDisplayVersion(version: string | undefined): string {
  const value = (version ?? '').trim();
  if (!value) return 'unknown';
  return value.toLowerCase().startsWith('v') ? value : `v${value}`;
}

interface ThemeOption {
  id: Theme;
  label: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

interface AnalyticsOption {
  id: AnalyticsConsent;
  label: string;
  description: string;
}

const ANALYTICS_OPTIONS: AnalyticsOption[] = [
  { 
    id: 'minimal', 
    label: 'Minimal', 
    description: 'Only track errors to help fix bugs' 
  },
  { 
    id: 'standard', 
    label: 'Standard', 
    description: 'Track usage patterns to improve features' 
  },
  { 
    id: 'full', 
    label: 'Full', 
    description: 'Includes session replay for UX research' 
  },
];

const THEME_SELECT_OPTIONS = THEME_OPTIONS.map(({ id, label }) => ({
  value: id,
  label,
}));

const ANALYTICS_SELECT_OPTIONS = ANALYTICS_OPTIONS.map(({ id, label }) => ({
  value: id,
  label,
}));

function GeneralSettings(): JSX.Element {
  const {
    theme,
    setTheme,
    developerModeEnabled,
    setDeveloperModeEnabled,
    setActiveView,
  } = useLayout();
  const { isAuthenticated, userEmail, logout } = useAuth();
  const [analyticsConsent, setAnalyticsConsentState] = useState<AnalyticsConsent>(getAnalyticsConsent);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [dataLocations, setDataLocations] = useState<DataLocations | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [appSettingsLoaded, setAppSettingsLoaded] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [isSavingDeveloperMode, setIsSavingDeveloperMode] = useState(false);
  const [isCheckingDeveloperMode, setIsCheckingDeveloperMode] = useState(false);
  const [developerModeDisableConfirmOpen, setDeveloperModeDisableConfirmOpen] = useState(false);

  const handleThemeChange = useCallback((value: string) => {
    setTheme(value as Theme);
  }, [setTheme]);

  const handleAnalyticsChange = useCallback((value: string) => {
    const level = value as AnalyticsConsent;
    setAnalyticsConsent(level);
    setAnalyticsConsentState(level);
  }, []);

  useEffect(() => {
    GetCurrentVersion()
      .then((version) => {
        setCurrentVersion(version);
      })
      .catch(() => {
        // Non-fatal version display fallback
      });

    GetAppSettings()
      .then((settings) => {
        setAppSettings(settings);
        setAppSettingsLoaded(true);
      })
      .catch(() => {
        // Non-fatal settings fallback
      });
  }, []);

  useEffect(() => {
    if (!developerModeEnabled) {
      setDataLocations(null);
      return;
    }

    let cancelled = false;
    GetDataLocations()
      .then((locations) => {
        if (!cancelled) {
          setDataLocations(locations);
        }
      })
      .catch(() => {
        // Non-fatal diagnostics panel fallback
      });

    return () => {
      cancelled = true;
    };
  }, [developerModeEnabled]);

  const persistDeveloperMode = useCallback(async (enabled: boolean): Promise<void> => {
    if (!appSettings) {
      return;
    }

    setIsSavingDeveloperMode(true);
    try {
      const currentSettings = await GetAppSettings();
      const nextSettings: AppSettings = {
        ...currentSettings,
        developerModeEnabled: enabled,
      };

      await SaveAppSettings(nextSettings);
      setAppSettings(nextSettings);
      setDeveloperModeEnabled(enabled);

      if (!enabled) {
        setActiveView(VIEWS.SETTINGS);
      }
    } catch {
      toast.error('Could not save Developer Mode setting.');
    } finally {
      setIsSavingDeveloperMode(false);
    }
  }, [appSettings, setActiveView, setDeveloperModeEnabled]);

  const handleDeveloperModeChange = useCallback(async (enabled: boolean): Promise<void> => {
    if (enabled) {
      await persistDeveloperMode(true);
      return;
    }

    setIsCheckingDeveloperMode(true);
    try {
      if (await IsEnabled()) {
        setDeveloperModeDisableConfirmOpen(true);
        return;
      }

      await persistDeveloperMode(false);
    } catch {
      toast.error('Could not check whether debug logging is active.');
    } finally {
      setIsCheckingDeveloperMode(false);
    }
  }, [persistDeveloperMode]);

  const handleConfirmDisableDeveloperMode = useCallback(async (): Promise<void> => {
    try {
      await SetEnabled(false);
    } catch {
      toast.error('Could not stop debug logging. Developer Mode remains enabled.');
      return;
    }

    await persistDeveloperMode(false);
  }, [persistDeveloperMode]);

  const handleCheckForUpdates = useCallback(async (): Promise<void> => {
    setIsCheckingForUpdates(true);
    try {
      await CheckForUpdates();
    } catch {
      toast.error("Couldn't check for updates. Check your internet connection and try again.");
    } finally {
      setIsCheckingForUpdates(false);
    }
  }, []);

  const currentVersionLabel = formatDisplayVersion(currentVersion ?? undefined);
  const showUpdateButton = isWindowsDesktop() && import.meta.env.MODE === 'production';

  const DATA_LOCATION_ITEMS: Array<{ label: string; path: string | undefined }> = [
    { label: 'Config', path: dataLocations?.roamingConfigDir },
    { label: 'Repo settings', path: dataLocations?.repositorySettingsDir },
    { label: 'Settings file', path: dataLocations?.settingsFile },
    { label: 'Logs', path: dataLocations?.logsDir },
    { label: 'Cache', path: dataLocations?.cacheDir },
    { label: 'Tools', path: dataLocations?.toolsBinDir },
    { label: 'WebView2', path: dataLocations?.webView2Dir },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-theme-surface rounded-lg p-6 border border-theme-default">
        <div className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Palette style={iconStyle} className="text-theme-secondary" />
                <label className="block text-theme-primary text-sm font-medium">
                  Theme
                </label>
              </div>
              <p className="text-theme-muted text-sm">
                Choose the app look.
              </p>
            </div>
            <Select
              value={theme}
              onValueChange={handleThemeChange}
              options={THEME_SELECT_OPTIONS}
              placeholder="Select theme"
              className="lg:mt-0"
            />
          </div>

          <div className="border-t border-theme-default" />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 style={iconStyle} className="text-theme-secondary" />
                <label className="block text-theme-primary text-sm font-medium">
                  Analytics
                </label>
              </div>
              <p className="text-theme-muted text-sm">
                Choose what anonymous app data can be shared.
              </p>
              <p className="text-theme-muted text-xs mt-2">
                No personal information or file contents are ever collected.
              </p>
            </div>
            <div className="space-y-2">
              <Select
                value={analyticsConsent}
                onValueChange={handleAnalyticsChange}
                options={ANALYTICS_SELECT_OPTIONS}
                placeholder="Select analytics"
              />
              <p className="text-theme-muted text-xs">
                {ANALYTICS_OPTIONS.find(({ id }) => id === analyticsConsent)?.description}
              </p>
            </div>
          </div>
        </div>

        {/* Account */}
        <div className="border-t border-theme-default pt-6 mt-6">
          <div className="flex items-center gap-2 mb-3">
            <LogOut style={iconStyle} className="text-theme-secondary" />
            <label className="block text-theme-primary text-sm font-medium">
              Account
            </label>
          </div>
          <p className="text-theme-muted text-sm mb-4">
            {isAuthenticated
              ? `Signed in as ${userEmail || 'your account'}. Local Git work stays available if you sign out.`
              : 'IOFabrik Account sign-in is not available in this release.'}
          </p>

          <div className="flex flex-wrap gap-2">
            {isAuthenticated ? (
              <Button
                variant="secondary"
                size="sm"
                loading={isSigningOut}
                onClick={async () => {
                  setIsSigningOut(true);
                  try {
                    await logout();
                  } finally {
                    setIsSigningOut(false);
                  }
                }}
              >
                <LogOut style={iconStyle} />
                <span className="ml-1.5">Sign out</span>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Updates */}
      <div className="bg-theme-surface rounded-lg p-6 border border-theme-default">
        <div className="flex items-center gap-2 mb-3">
          <Info style={iconStyle} className="text-theme-secondary" />
          <label className="block text-theme-primary text-sm font-medium">
            Updates
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="text-sm">
            <p className="text-theme-secondary">
              <span className="text-theme-muted">Current app version:</span>{' '}
              <span className="text-theme-primary font-medium">{currentVersionLabel}</span>
            </p>
          </div>

          {showUpdateButton ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCheckForUpdates()}
              loading={isCheckingForUpdates}
            >
              <RefreshCw style={iconStyle} />
              <span>Check for updates</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Developer Mode */}
      <div className="bg-theme-surface rounded-lg p-6 border border-theme-default">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Code2 style={iconStyle} className="text-theme-secondary" />
              <label className="block text-theme-primary text-sm font-medium">Developer Mode</label>
            </div>
            <p className="text-theme-muted text-sm">
              Show internal diagnostics and developer tools in the app.
            </p>
          </div>
          <div className="pt-1">
            <Switch
              checked={developerModeEnabled}
              disabled={!appSettingsLoaded || isSavingDeveloperMode || isCheckingDeveloperMode}
              onCheckedChange={(enabled) => void handleDeveloperModeChange(enabled)}
              aria-label="Developer Mode"
            />
          </div>
        </div>
      </div>

      <AlertDialog
        open={developerModeDisableConfirmOpen}
        onOpenChange={setDeveloperModeDisableConfirmOpen}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop debug logging?</AlertDialogTitle>
            <AlertDialogDescription>
              Turning off Developer Mode will stop active debug logging and hide Debug Logs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Developer Mode on</AlertDialogCancel>
            <AlertDialogAction variant="default" onClick={handleConfirmDisableDeveloperMode}>
              Stop logging and disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Data Paths */}
      {developerModeEnabled ? (
        <div className="bg-theme-surface rounded-lg p-6 border border-theme-default">
          <div className="flex items-center gap-2 mb-3">
            <FolderTree style={iconStyle} className="text-theme-secondary" />
            <label className="block text-theme-primary text-sm font-medium">
              Data
            </label>
          </div>
          <p className="text-theme-muted text-sm mb-4">
            Active storage paths used by IOFabrik on this machine.
          </p>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">Location</TableHead>
                <TableHead>Path</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DATA_LOCATION_ITEMS.map(({ label, path }) => (
                <TableRow key={label}>
                  <TableCell className="text-theme-secondary">{label}</TableCell>
                  <TableCell className="text-sm break-all">
                    {path || <span className="text-theme-muted">Unavailable</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

export default memo(GeneralSettings);
