import { beforeEach, describe, expect, it } from 'vitest';
import { readMigratedStorage } from './migratedStorage';

describe('renamed browser preferences', () => {
  beforeEach(() => localStorage.clear());

  it('recovers a legacy preference and removes its old key after saving', () => {
    localStorage.setItem('cz_theme', 'light');
    expect(readMigratedStorage('iofabrik_theme', 'cz_theme')).toBe('light');
    expect(localStorage.getItem('iofabrik_theme')).toBe('light');
    expect(localStorage.getItem('cz_theme')).toBeNull();
  });

  it('keeps an explicit current preference over a legacy value', () => {
    localStorage.setItem('iofabrik_theme', 'dark');
    localStorage.setItem('cz_theme', 'light');
    expect(readMigratedStorage('iofabrik_theme', 'cz_theme')).toBe('dark');
  });
});
