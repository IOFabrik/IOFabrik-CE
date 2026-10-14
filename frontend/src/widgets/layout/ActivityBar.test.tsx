import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityBar from './ActivityBar';

const openExternalUrlMock = vi.hoisted(() => vi.fn());

const layoutMock = vi.hoisted(() => ({
  activeView: 'explorer',
  setActiveView: vi.fn(),
  sidebarCollapsed: false,
  setSidebarCollapsed: vi.fn(),
  developerModeEnabled: false,
}));

const repoMock = vi.hoisted(() => ({
  repoInfo: { isRepo: true },
  repoStatus: { hasChanges: false },
}));

vi.mock('../../context', () => ({
  useLayout: () => layoutMock,
  useRepo: () => repoMock,
}));

vi.mock('../../shared/runtime/browser', () => ({
  openExternalUrl: openExternalUrlMock,
}));

describe('ActivityBar Developer Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutMock.developerModeEnabled = false;
  });

  it('shows Debug Logs only when Developer Mode is enabled', () => {
    const { unmount } = render(<ActivityBar />);

    expect(screen.queryByRole('button', { name: 'Debug Logs' })).not.toBeInTheDocument();

    layoutMock.developerModeEnabled = true;
    unmount();
    render(<ActivityBar />);

    expect(screen.getByRole('button', { name: 'Debug Logs' })).toBeInTheDocument();
  });

  it('opens the resources modal from the book icon and exposes all resource options', async () => {
    render(<ActivityBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Resources' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Documentation/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Community Forum/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Guided tour.*Coming Soon/ })).toBeDisabled();
  });

  it('closes the resources modal from its Close button', async () => {
    render(<ActivityBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Resources' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['Documentation', 'https://iofabrik.com/docs/'],
    ['Community Forum', 'https://github.com/orgs/IOFabrik/discussions'],
  ])('opens %s externally', async (optionName, expectedUrl) => {
    render(<ActivityBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Resources' }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(optionName) }));

    expect(openExternalUrlMock).toHaveBeenCalledWith(expectedUrl);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
