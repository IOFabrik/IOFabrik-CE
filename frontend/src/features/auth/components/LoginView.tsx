/**
 * LoginView - Modern full-screen login gate for IOFabrik.
 *
 * Uses a standalone theme hook (useLoginTheme) because LayoutContext
 * isn't available until after authentication. Theme preference is
 * persisted to localStorage so it carries over to the main app.
 */
import { memo, useState, useCallback, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Sun, Moon, Monitor, Mail, KeyRound, ArrowRight } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../shared/ui';
import { useAuth } from '../../../context';
import { useLoginTheme } from '../../../shared/hooks/useLoginTheme';
import Spinner from '../../../shared/ui/Spinner';
import iofabrikMark from '../../../shared/brand/iofabrik-mark.svg';

interface LoginViewProps {
  variant?: 'fullscreen' | 'embedded';
  title?: string;
  description?: string;
}

/* -------------------------------------------------------------------------- */
/*  Logo                                                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Theme toggle                                                              */
/* -------------------------------------------------------------------------- */

const THEME_ICONS = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} as const;

const THEME_LABELS = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
} as const;

function ThemeToggle() {
  const { theme, cycleTheme } = useLoginTheme();
  const Icon = THEME_ICONS[theme];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={cycleTheme}
            className="rounded-full p-2 text-theme-muted hover:text-theme-primary hover-bg-theme-interactive transition-colors"
            aria-label={THEME_LABELS[theme]}
          >
            <Icon size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{THEME_LABELS[theme]}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Login form                                                                */
/* -------------------------------------------------------------------------- */

function LoginCard({
  isLoading,
  isAuthAvailable,
  displayError,
  isSubmitting,
  email,
  password,
  showPassword,
  setEmail,
  setPassword,
  setShowPassword,
  handleSubmit,
  title,
  description,
  footer,
}: {
  isLoading: boolean;
  isAuthAvailable: boolean;
  displayError: string | null;
  isSubmitting: boolean;
  email: string;
  password: string;
  showPassword: boolean;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  setShowPassword: (value: boolean) => void;
  handleSubmit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  title: string;
  description: string;
  footer: ReactNode;
}): JSX.Element {
  return (
    <Card className="border-theme-default shadow-lg">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent>
        {displayError && isAuthAvailable && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-600 dark:text-red-400 animate-fade-in">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{displayError}</span>
          </div>
        )}

        {!isAuthAvailable ? (
          <div className="rounded-md border border-theme-default bg-theme-surface px-4 py-4 text-sm text-theme-secondary">
            <p className="font-medium text-theme-primary">Account sign-in is unavailable in this build.</p>
            <p className="mt-1 text-theme-muted">
              You can keep using IOFabrik for local Git work without signing in.
            </p>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col items-center gap-3 py-8 text-sm text-theme-muted">
            <Spinner size={20} />
            <span>Checking session…</span>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="auth-email">Email</Label>
              <div className="relative">
                <Mail
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-theme-muted"
                />
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auth-password">Password</Label>
              <div className="relative">
                <KeyRound
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-theme-muted"
                />
                <Input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="pl-9 pr-16"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-theme-muted hover:text-theme-primary transition-colors select-none"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full gap-2"
              size="lg"
              loading={isSubmitting}
            >
              Sign in
              {!isSubmitting && <ArrowRight size={14} />}
            </Button>
          </form>
        )}
      </CardContent>

      <CardFooter className="justify-center border-t border-theme-muted pt-4">
        {footer}
      </CardFooter>
    </Card>
  );
}

function LoginView({
  variant = 'fullscreen',
  title,
  description,
}: LoginViewProps): JSX.Element {
  // Activate theme on the login screen
  useLoginTheme();

  const { loginWithPassword, isLoading, authError, isAuthAvailable = true } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const displayError = localError || authError;
  const cardTitle = title ?? 'Sign in';
  const cardDescription = description ?? (
    variant === 'embedded'
      ? 'Use your IOFabrik account for optional cloud features. Local Git work stays available without signing in.'
      : 'Enter your credentials to continue.'
  );
  const footer = isAuthAvailable ? (
    <p className="text-xs text-theme-muted text-center">
      Don&apos;t have an account?{' '}
      <a
        href="https://iofabrik.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 hover:text-blue-400 transition-colors"
      >
        Request access
      </a>
    </p>
  ) : (
    <p className="text-xs text-theme-muted text-center">
      IOFabrik accounts are optional. Guest mode still supports local version control.
    </p>
  );

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setLocalError(null);

      if (!email || !password) {
        setLocalError('Please enter your email and password.');
        return;
      }

      setIsSubmitting(true);
      try {
        const result = await loginWithPassword(email, password);
        if (!result.success) {
          setLocalError(result.error || 'Sign in failed.');
        }
      } catch {
        setLocalError('An unexpected error occurred. Please try again.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [email, password, loginWithPassword],
  );

  if (variant === 'embedded') {
    return (
      <LoginCard
        isLoading={isLoading}
        isAuthAvailable={isAuthAvailable}
        displayError={displayError}
        isSubmitting={isSubmitting}
        email={email}
        password={password}
        showPassword={showPassword}
        setEmail={setEmail}
        setPassword={setPassword}
        setShowPassword={setShowPassword}
        handleSubmit={handleSubmit}
        title={cardTitle}
        description={cardDescription}
        footer={footer}
      />
    );
  }

  /* ---- Full-screen wrapper ---- */
  return (
    <div className="relative h-screen w-screen flex items-center justify-center bg-theme-base text-theme-primary overflow-hidden">
      {/* Decorative background blobs */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-blue-500/5 blur-3xl"
      />

      {/* Theme toggle – top-right corner */}
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      {/* Main content */}
      <div className="relative z-10 w-full max-w-sm px-4 animate-screen-enter">
        {/* Branding */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center select-none">
          <img src={iofabrikMark} alt="" className="h-12 w-12" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-theme-primary">
              IO<span className="text-blue-500">Fabrik</span>
            </h1>
            <p className="mt-1 text-xs text-theme-muted">
              Version control for industrial automation
            </p>
          </div>
        </div>

        <LoginCard
          isLoading={isLoading}
          isAuthAvailable={isAuthAvailable}
          displayError={displayError}
          isSubmitting={isSubmitting}
          email={email}
          password={password}
          showPassword={showPassword}
          setEmail={setEmail}
          setPassword={setPassword}
          setShowPassword={setShowPassword}
          handleSubmit={handleSubmit}
          title={cardTitle}
          description={cardDescription}
          footer={footer}
        />

        {/* Footer legal */}
        <p className="mt-6 text-center text-[11px] text-theme-muted select-none">
          © {new Date().getFullYear()} IOFabrik. All rights reserved.
        </p>
      </div>
    </div>
  );
}

export default memo(LoginView);
