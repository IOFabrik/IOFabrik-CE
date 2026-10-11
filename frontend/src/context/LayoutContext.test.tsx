import { act, render, waitFor } from '@testing-library/react';
import { useEffect, type JSX } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEWS } from '../shared/constants';
import { LayoutProvider, useLayout } from './LayoutContext';

const settingsServiceMock = vi.hoisted(() => ({
  GetAppSettings: vi.fn(),
  SaveAppSettings: vi.fn(),
}));

vi.mock('../../bindings/iofabrik/services/settingsservice', () => settingsServiceMock);

vi.mock('../domain/analytics/analytics', () => ({
  trackViewChanged: vi.fn(),
  trackSettingsOpened: vi.fn(),
}));

vi.mock('../shared/hooks/useWindowSize', () => ({
  useWindowSize: () => ({ shouldCollapseSidebar: () => false }),
}));

let layout: ReturnType<typeof useLayout> | null = null;

function LayoutProbe(): JSX.Element {
  const value = useLayout();

  useEffect(() => {
    layout = value;
  }, [value]);

  return <div data-testid="active-view">{value.activeView}</div>;
}

describe('LayoutContext Developer Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    layout = null;
  });

  it('hydrates Developer Mode from persisted app settings', async () => {
    settingsServiceMock.GetAppSettings.mockResolvedValue({ developerModeEnabled: true });

    render(
      <LayoutProvider>
        <LayoutProbe />
      </LayoutProvider>,
    );

    await waitFor(() => {
      expect(layout?.developerModeEnabled).toBe(true);
    });
  });

  it('blocks Debug Logs navigation until Developer Mode is enabled', async () => {
    settingsServiceMock.GetAppSettings.mockResolvedValue({ developerModeEnabled: false });

    render(
      <LayoutProvider>
        <LayoutProbe />
      </LayoutProvider>,
    );

    await waitFor(() => {
      expect(layout).not.toBeNull();
    });

    act(() => {
      layout?.setActiveView(VIEWS.DEBUG);
    });
    expect(layout?.activeView).toBe(VIEWS.EXPLORER);

    act(() => {
      layout?.setDeveloperModeEnabled(true);
    });
    act(() => {
      layout?.setActiveView(VIEWS.DEBUG);
    });
    expect(layout?.activeView).toBe(VIEWS.DEBUG);
  });

  it('persists the latest Timeline resize and restores it after restarting the layout', async () => {
    let settings = { theme: 'light', lastRepoPath: 'C:/plant', recentFolders: ['C:/plant'], developerModeEnabled: false, timelineHeight: 224 };
    settingsServiceMock.GetAppSettings.mockImplementation(async () => ({ ...settings }));
    settingsServiceMock.SaveAppSettings.mockImplementation(async (next) => { settings = next; });
    const mounted = render(<LayoutProvider><LayoutProbe /></LayoutProvider>);
    await waitFor(() => expect(layout?.timelineHeight).toBe(224));
    act(() => {
      layout?.setTimelineHeight(240, false);
    });
    expect(settingsServiceMock.SaveAppSettings).not.toHaveBeenCalled();
    act(() => {
      layout?.setTimelineHeight(240);
      layout?.setTimelineHeight(256);
    });
    await waitFor(() => expect(settings.timelineHeight).toBe(256));
    expect(settings).toMatchObject({ theme: 'light', lastRepoPath: 'C:/plant', recentFolders: ['C:/plant'], developerModeEnabled: false });
    mounted.unmount();
    render(<LayoutProvider><LayoutProbe /></LayoutProvider>);
    await waitFor(() => expect(layout?.timelineHeight).toBe(256));
  });
});
