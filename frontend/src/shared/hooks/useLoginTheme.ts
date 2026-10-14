/**
 * useLoginTheme - Lightweight theme hook for pre-auth screens.
 *
 * LayoutContext (which manages theme for the main app) isn't mounted
 * until the user is authenticated. This hook mirrors the same logic
 * so the login screen can toggle light/dark and respect system prefs.
 *
 * Theme preference is persisted in localStorage under the same key
 * that LayoutContext reads, so the transition is seamless once the
 * user authenticates.
 */
import { useState, useEffect, useCallback } from 'react';
import { readMigratedStorage } from '../utils/migratedStorage';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'iofabrik_theme';

export function useLoginTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readMigratedStorage(STORAGE_KEY, 'cz_theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  // Cycle: system → light → dark → system
  const cycleTheme = useCallback(() => {
    setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
  }, [theme, setTheme]);

  // Resolve effective mode (for icon display)
  const resolvedDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Apply .dark / .light class to <html> – same logic as LayoutContext
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const isDark =
        theme === 'dark' || (theme === 'system' && mediaQuery.matches);
      document.documentElement.classList.toggle('dark', isDark);
      document.documentElement.classList.toggle('light', !isDark);
    };

    apply();
    mediaQuery.addEventListener('change', apply);
    return () => mediaQuery.removeEventListener('change', apply);
  }, [theme]);

  return { theme, setTheme, cycleTheme, isDark: resolvedDark };
}
