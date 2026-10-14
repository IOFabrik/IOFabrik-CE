import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GeneralSettings from './GeneralSettings';

type AppSettings = {
  theme: string;
  lastRepoPath: string;
  recentFolders: string[];
  developerModeEnabled: boolean;
};

const settingsServiceMock = vi.hoisted(() => ({
  GetAppSettings: vi.fn(),
  GetDataLocations: vi.fn(),
  SaveAppSettings: vi.fn(),
}));

const updateServiceMock = vi.hoisted(() => ({
  CheckForUpdates: vi.fn(),
  GetCurrentVersion: vi.fn(),
}));

const runtimeWindowMock = vi.hoisted(() => ({
  isWindowsDesktop: vi.fn(),
}));

const debugServiceMock = vi.hoisted(() => ({
  IsEnabled: vi.fn(),
  SetEnabled: vi.fn(),
}));

const layoutMock = vi.hoisted(() => ({
  theme: 'dark',
  setTheme: vi.fn(),
  developerModeEnabled: false,
  setDeveloperModeEnabled: vi.fn(),
  setActiveView: vi.fn(),
  openAccountDialog: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  isAuthenticated: false,
  isAuthAvailable: true,
  userEmail: '',
  logout: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('../../../context', () => ({
  useLayout: () => layoutMock,
  useAuth: () => authMock,
}));

vi.mock('../../../shared/runtime/window', () => runtimeWindowMock);

vi.mock('../../../domain/analytics/analytics', () => ({
  getAnalyticsConsent: () => 'minimal',
  setAnalyticsConsent: vi.fn(),
}));

vi.mock('../../../../bindings/iofabrik/services/settingsservice', () => settingsServiceMock);
vi.mock('../../../../bindings/iofabrik/services/appupdateservice', () => updateServiceMock);
vi.mock('../../../../bindings/iofabrik/services/debugservice', () => debugServiceMock);

vi.mock('sonner', () => ({
  toast: toastMock,
}));

vi.mock('../../../shared/ui', () => ({
  Button: ({ children, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => <button type="button" {...props}>{children}</button>,
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <>{children}</> : null,
  AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
  AlertDialogCancel: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Select: ({ value, onValueChange, options, placeholder, className }: {
    value: string;
    onValueChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    placeholder?: string;
    className?: string;
  }) => (
    <select
      aria-label={placeholder ?? 'select'}
      className={className}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
  Switch: ({ checked, disabled, onCheckedChange, ...props }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) {
          onCheckedChange?.(!checked);
        }
      }}
      {...props}
    />
  ),
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children, className }: { children: React.ReactNode; className?: string }) => <td className={className}>{children}</td>,
  TableHead: ({ children, className }: { children: React.ReactNode; className?: string }) => <th className={className}>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
}));

describe('GeneralSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateServiceMock.GetCurrentVersion.mockResolvedValue('v0.13.0-beta');
    updateServiceMock.CheckForUpdates.mockResolvedValue(undefined);
    runtimeWindowMock.isWindowsDesktop.mockReturnValue(false);
    vi.stubEnv('MODE', 'test');
    settingsServiceMock.GetDataLocations.mockResolvedValue({
      roamingConfigDir: '/tmp/config',
      repositorySettingsDir: '/tmp/repositories',
      settingsFile: '/tmp/settings.json',
      logsDir: '/tmp/logs',
      cacheDir: '/tmp/cache',
      toolsBinDir: '/tmp/tools',
      webView2Dir: '/tmp/webview2',
    });
    settingsServiceMock.SaveAppSettings.mockResolvedValue(undefined);
    debugServiceMock.IsEnabled.mockResolvedValue(false);
    debugServiceMock.SetEnabled.mockResolvedValue(undefined);
    layoutMock.developerModeEnabled = false;
  });

  it('shows the backend current version instead of the frontend dev fallback', async () => {
    settingsServiceMock.GetAppSettings.mockResolvedValue({
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: false,
    });

    render(<GeneralSettings />);

    expect(await screen.findByText('v0.13.0-beta')).toBeInTheDocument();
    expect(updateServiceMock.GetCurrentVersion).toHaveBeenCalledTimes(1);
  });

  it('shows the update action only in production Windows builds', async () => {
    settingsServiceMock.GetAppSettings.mockResolvedValue({
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: false,
    });
    runtimeWindowMock.isWindowsDesktop.mockReturnValue(true);
    vi.stubEnv('MODE', 'production');

    const { unmount } = render(<GeneralSettings />);
    expect(await screen.findByRole('button', { name: 'Check for updates' })).toBeInTheDocument();
    await screen.findByText('v0.13.0-beta');

    unmount();
    vi.stubEnv('MODE', 'development');
    render(<GeneralSettings />);
    await screen.findByText('v0.13.0-beta');
    expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument();
  });

  it('opens the updater and translates failures into recovery guidance', async () => {
    settingsServiceMock.GetAppSettings.mockResolvedValue({
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: false,
    });
    runtimeWindowMock.isWindowsDesktop.mockReturnValue(true);
    vi.stubEnv('MODE', 'production');
    updateServiceMock.CheckForUpdates.mockRejectedValue(new Error('github: request failed'));

    render(<GeneralSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));

    await waitFor(() => {
      expect(updateServiceMock.CheckForUpdates).toHaveBeenCalledTimes(1);
      expect(toastMock.error).toHaveBeenCalledWith(
        "Couldn't check for updates. Check your internet connection and try again.",
      );
    });
  });

  it('loads and shows data paths only when Developer Mode is enabled', async () => {
    settingsServiceMock.GetAppSettings.mockResolvedValue({
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: false,
    });

    const { unmount } = render(<GeneralSettings />);

    await screen.findByText('v0.13.0-beta');
    expect(screen.queryByText('Active storage paths used by IOFabrik on this machine.')).not.toBeInTheDocument();
    expect(settingsServiceMock.GetDataLocations).not.toHaveBeenCalled();

    layoutMock.developerModeEnabled = true;
    unmount();
    render(<GeneralSettings />);

    await screen.findByText('v0.13.0-beta');
    await waitFor(() => {
      expect(settingsServiceMock.GetDataLocations).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('Active storage paths used by IOFabrik on this machine.')).toBeInTheDocument();
  });

  it('persists Developer Mode and updates the effective runtime setting', async () => {
    const initialSettings: AppSettings = {
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: false,
    };
    const refreshedSettings: AppSettings = {
      ...initialSettings,
      recentFolders: ['/repos/bravo', '/repos/alpha'],
    };
    settingsServiceMock.GetAppSettings
      .mockResolvedValueOnce(initialSettings)
      .mockResolvedValueOnce(refreshedSettings);

    render(<GeneralSettings />);

    await screen.findByText('v0.13.0-beta');

    const toggle = screen.getByRole('switch', { name: 'Developer Mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(settingsServiceMock.SaveAppSettings).toHaveBeenCalledWith({
        ...refreshedSettings,
        developerModeEnabled: true,
      });
    });
    expect(layoutMock.setDeveloperModeEnabled).toHaveBeenCalledWith(true);
  });

  it('keeps Developer Mode enabled when saving the disabled state fails', async () => {
    const settings: AppSettings = {
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: true,
    };
    layoutMock.developerModeEnabled = true;
    settingsServiceMock.GetAppSettings
      .mockResolvedValueOnce(settings)
      .mockRejectedValueOnce(new Error('disk unavailable'));

    render(<GeneralSettings />);

    await screen.findByText('v0.13.0-beta');
    fireEvent.click(screen.getByRole('switch', { name: 'Developer Mode' }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Could not save Developer Mode setting.');
    });
    expect(layoutMock.setDeveloperModeEnabled).not.toHaveBeenCalled();
  });

  it('stops active debug logging before disabling Developer Mode', async () => {
    const settings: AppSettings = {
      theme: 'dark',
      lastRepoPath: '/repos/alpha',
      recentFolders: ['/repos/alpha'],
      developerModeEnabled: true,
    };
    layoutMock.developerModeEnabled = true;
    debugServiceMock.IsEnabled.mockResolvedValue(true);
    settingsServiceMock.GetAppSettings
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce(settings);

    render(<GeneralSettings />);

    await screen.findByText('v0.13.0-beta');
    fireEvent.click(screen.getByRole('switch', { name: 'Developer Mode' }));
    expect(await screen.findByRole('button', { name: 'Stop logging and disable' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop logging and disable' }));

    await waitFor(() => {
      expect(debugServiceMock.SetEnabled).toHaveBeenCalledWith(false);
      expect(settingsServiceMock.SaveAppSettings).toHaveBeenCalledWith({
        ...settings,
        developerModeEnabled: false,
      });
    });
    expect(layoutMock.setDeveloperModeEnabled).toHaveBeenCalledWith(false);
  });
});
