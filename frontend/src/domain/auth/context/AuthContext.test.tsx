import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

const mockLoadSession = vi.fn();
const mockSaveSession = vi.fn();
const mockClearSession = vi.fn();

const mockSignIn = vi.fn();
const mockSignOut = vi.fn();
const mockHydrateSession = vi.fn();
const mockRefreshSession = vi.fn();
const mockSerialiseSession = vi.fn();
const mockIsSupabaseConfigured = vi.fn();

vi.mock('../supabaseClient', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  hydrateSession: (...args: unknown[]) => mockHydrateSession(...args),
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
  serialiseSession: (...args: unknown[]) => mockSerialiseSession(...args),
  isSupabaseConfigured: (...args: unknown[]) => mockIsSupabaseConfigured(...args),
}));

vi.mock('../../../../bindings/iofabrik/services/authservice', () => ({
  LoadSession: (...args: unknown[]) => mockLoadSession(...args),
  SaveSession: (...args: unknown[]) => mockSaveSession(...args),
  ClearSession: (...args: unknown[]) => mockClearSession(...args),
}));

function TestState(): JSX.Element {
  const { isLoading, isAuthenticated, isGuest, isAuthAvailable, authError, userEmail } = useAuth();
  return (
    <div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="auth">{String(isAuthenticated)}</div>
      <div data-testid="guest">{String(isGuest)}</div>
      <div data-testid="available">{String(isAuthAvailable)}</div>
      <div data-testid="error">{authError ?? ''}</div>
      <div data-testid="email">{userEmail ?? ''}</div>
    </div>
  );
}

let capturedLogin: ((email: string, password: string) => Promise<{ success: boolean; error: string | null }>) | null = null;
let capturedLogout: (() => Promise<{ success: boolean; error: string | null }>) | null = null;
let capturedRefresh: (() => Promise<{ success: boolean; error: string | null }>) | null = null;

function CaptureActions(): JSX.Element {
  const { loginWithPassword, logout, refreshSession } = useAuth();
  capturedLogin = loginWithPassword;
  capturedLogout = logout;
  capturedRefresh = refreshSession;
  return <div />;
}

const mockSession = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_at: 123,
  expires_in: 3600,
  token_type: 'bearer',
  user: { email: 'user@iofabrik.com', user_metadata: {} },
} as unknown;

beforeEach(() => {
  mockLoadSession.mockReset();
  mockSaveSession.mockReset();
  mockClearSession.mockReset();
  mockSignIn.mockReset();
  mockSignOut.mockReset();
  mockHydrateSession.mockReset();
  mockRefreshSession.mockReset();
  mockSerialiseSession.mockReset();
  mockIsSupabaseConfigured.mockReset();
  mockIsSupabaseConfigured.mockReturnValue(true);
  capturedLogin = null;
  capturedLogout = null;
  capturedRefresh = null;
});

describe('AuthContext', () => {
  it('hydrates session from keychain and marks authenticated', async () => {
    mockLoadSession.mockResolvedValue('stored-session');
    mockHydrateSession.mockResolvedValue({ success: true, session: mockSession, error: null });
    mockSerialiseSession.mockReturnValue('serialized-session');

    render(
      <AuthProvider>
        <TestState />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('auth')).toHaveTextContent('true');
    expect(screen.getByTestId('guest')).toHaveTextContent('false');
    expect(screen.getByTestId('available')).toHaveTextContent('true');
    expect(screen.getByTestId('email')).toHaveTextContent('user@iofabrik.com');
    expect(mockSaveSession).toHaveBeenCalledWith('serialized-session');
  });

  it('clears session when hydration fails', async () => {
    mockLoadSession.mockResolvedValue('stored-session');
    mockHydrateSession.mockResolvedValue({ success: false, session: null, error: 'expired' });

    render(
      <AuthProvider>
        <TestState />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('auth')).toHaveTextContent('false');
    expect(screen.getByTestId('guest')).toHaveTextContent('true');
    expect(screen.getByTestId('error')).toHaveTextContent('expired');
    expect(mockClearSession).toHaveBeenCalled();
  });

  it('settles into guest mode when auth runtime is unavailable', async () => {
    mockIsSupabaseConfigured.mockReturnValue(false);

    render(
      <AuthProvider>
        <TestState />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('auth')).toHaveTextContent('false');
    expect(screen.getByTestId('guest')).toHaveTextContent('true');
    expect(screen.getByTestId('available')).toHaveTextContent('false');
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it('logs in and persists session', async () => {
    mockLoadSession.mockResolvedValue('');
    mockSignIn.mockResolvedValue({ success: true, session: mockSession, error: null });
    mockSerialiseSession.mockReturnValue('serialized-session');

    render(
      <AuthProvider>
        <CaptureActions />
        <TestState />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await act(async () => {
      await capturedLogin?.('user@iofabrik.com', 'password123');
    });

    expect(mockSignIn).toHaveBeenCalledWith('user@iofabrik.com', 'password123');
    expect(mockSaveSession).toHaveBeenCalledWith('serialized-session');
    expect(screen.getByTestId('auth')).toHaveTextContent('true');
  });

  it('logs out and clears session', async () => {
    mockLoadSession.mockResolvedValue('');
    mockSignOut.mockResolvedValue({ success: true, error: null });

    render(
      <AuthProvider>
        <CaptureActions />
        <TestState />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await act(async () => {
      await capturedLogout?.();
    });

    expect(mockSignOut).toHaveBeenCalled();
    expect(mockClearSession).toHaveBeenCalled();
    expect(screen.getByTestId('auth')).toHaveTextContent('false');
  });

  it('refreshes session and persists new tokens', async () => {
    mockLoadSession.mockResolvedValue('');
    mockRefreshSession.mockResolvedValue({ success: true, session: mockSession, error: null });
    mockSerialiseSession.mockReturnValue('serialized-session');

    render(
      <AuthProvider>
        <CaptureActions />
        <TestState />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await act(async () => {
      await capturedRefresh?.();
    });

    expect(mockRefreshSession).toHaveBeenCalled();
    expect(mockSaveSession).toHaveBeenCalledWith('serialized-session');
    expect(screen.getByTestId('auth')).toHaveTextContent('true');
  });
});
