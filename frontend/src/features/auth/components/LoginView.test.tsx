import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginView from './LoginView';

const mockUseAuth = vi.fn();

vi.mock('../../../context', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../../../shared/hooks/useLoginTheme', () => ({
  useLoginTheme: () => ({
    theme: 'system' as const,
    setTheme: vi.fn(),
    cycleTheme: vi.fn(),
    isDark: false,
  }),
}));

describe('LoginView', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
  });

  it('shows loading state while checking session', () => {
    mockUseAuth.mockReturnValue({
      loginWithPassword: vi.fn(),
      isLoading: true,
      isAuthAvailable: true,
      authError: null,
    });

    render(<LoginView />);

    expect(screen.getByText('Checking session…')).toBeInTheDocument();
  });

  it('shows auth error from context', () => {
    mockUseAuth.mockReturnValue({
      loginWithPassword: vi.fn(),
      isLoading: false,
      isAuthAvailable: true,
      authError: 'Invalid credentials',
    });

    render(<LoginView />);

    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
  });

  it('validates empty fields', async () => {
    mockUseAuth.mockReturnValue({
      loginWithPassword: vi.fn(),
      isLoading: false,
      isAuthAvailable: true,
      authError: null,
    });

    render(<LoginView />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Please enter your email and password.')).toBeInTheDocument();
    });
  });

  it('submits credentials to login handler', async () => {
    const loginWithPassword = vi.fn().mockResolvedValue({ success: true, error: null });

    mockUseAuth.mockReturnValue({
      loginWithPassword,
      isLoading: false,
      isAuthAvailable: true,
      authError: null,
    });

    render(<LoginView />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@iofabrik.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(loginWithPassword).toHaveBeenCalledWith('user@iofabrik.com', 'password123');
    });
  });

  it('shows login failure message', async () => {
    const loginWithPassword = vi.fn().mockResolvedValue({ success: false, error: 'Bad login' });

    mockUseAuth.mockReturnValue({
      loginWithPassword,
      isLoading: false,
      isAuthAvailable: true,
      authError: null,
    });

    render(<LoginView />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@iofabrik.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Bad login')).toBeInTheDocument();
    });
  });

  it('shows guest-safe messaging when account sign-in is unavailable', () => {
    mockUseAuth.mockReturnValue({
      loginWithPassword: vi.fn(),
      isLoading: false,
      isAuthAvailable: false,
      authError: null,
    });

    render(<LoginView variant="embedded" />);

    expect(screen.getByText('Account sign-in is unavailable in this build.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
});
