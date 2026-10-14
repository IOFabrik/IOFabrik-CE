import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GitHubStatusBanner from './GitHubStatusBanner';

const { repo, startGitHubLogin, onComplete } = vi.hoisted(() => ({
  repo: { ghInstalled: true, ghAuthStatus: null as { loggedIn: boolean } | null, isOffline: false },
  startGitHubLogin: vi.fn(),
  onComplete: vi.fn(),
}));

vi.mock('../../context', () => ({ useRepo: () => ({ ...repo, startGitHubLogin }) }));
vi.mock('../../features/auth/components/GitHubDeviceFlowModal', () => ({
  default: ({ open, userCode, onComplete: complete, onOpenChange }: {
    open: boolean; userCode: string; onComplete: () => void; onOpenChange: (open: boolean) => void;
  }) => open ? (
    <div role="dialog" aria-label="Connect to GitHub">
      <span>{userCode}</span>
      <button onClick={() => { onComplete(); complete(); }}>Complete login</button>
      <button onClick={() => onOpenChange(false)}>Cancel login</button>
    </div>
  ) : null,
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

describe('persistent GitHub status banner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repo.ghInstalled = true;
    repo.ghAuthStatus = { loggedIn: false };
    repo.isOffline = false;
    startGitHubLogin.mockResolvedValue({ success: true, userCode: 'ABCD-1234', verificationUrl: 'https://github.com/login/device' });
  });

  it('shows a single status message and an authentication action without a dismiss button', () => {
    render(<GitHubStatusBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('GitHub authentication required.');
    expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeEnabled();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it.each([null, { loggedIn: true }])('hides the banner for unknown or authenticated status: %s', (status) => {
    repo.ghAuthStatus = status;
    render(<GitHubStatusBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('prioritizes the offline message and restores the authentication action on reconnection', () => {
    repo.isOffline = true;
    const { rerender } = render(<GitHubStatusBanner />);
    expect(screen.getByRole('status')).toHaveTextContent("You're offline. Changes will be saved locally.");
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    repo.isOffline = false;
    // The mocked useRepo has no Context subscription to bypass memo.
    rerender(<GitHubStatusBanner data-revision="updated" />);
    expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeEnabled();
  });

  it('shows offline even when the user is already authenticated', () => {
    repo.isOffline = true;
    repo.ghAuthStatus = { loggedIn: true };
    render(<GitHubStatusBanner />);
    expect(screen.getByRole('status')).toHaveTextContent("You're offline.");
  });

  it('opens the existing device flow and keeps the banner after cancellation', async () => {
    render(<GitHubStatusBanner />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Authenticate with GitHub' })); });
    expect(startGitHubLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Connect to GitHub' })).toHaveTextContent('ABCD-1234');
    expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel login' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeEnabled();
  });

  it('keeps the modal mounted when the authenticated status hides the banner', async () => {
    const { rerender } = render(<GitHubStatusBanner />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Authenticate with GitHub' })); });
    repo.ghAuthStatus = { loggedIn: true };
    // The mocked useRepo has no Context subscription to bypass memo.
    rerender(<GitHubStatusBanner data-revision="updated" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Complete login' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a recovery message if authentication cannot start and permits retry', async () => {
    startGitHubLogin.mockResolvedValue({ success: false, error: 'GitHub sign-in could not start. Try connecting again.' });
    render(<GitHubStatusBanner />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Authenticate with GitHub' })); });
    expect(toastError).toHaveBeenCalledWith('GitHub sign-in could not start. Try connecting again.');
    expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeEnabled();
  });
});
