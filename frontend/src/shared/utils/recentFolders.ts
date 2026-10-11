/**
 * recentFolders.ts - Manage recently opened folders in localStorage.
 * 
 * Keeps track of the last N folders opened by the user.
 * Stored as a simple array of path strings, most recent first.
 */

import { GetRecentFolders } from '../../../bindings/iofabrik/services/settingsservice';
import { readMigratedStorage } from './migratedStorage';

const STORAGE_KEY = 'iofabrik-recent-folders';
const MAX_RECENT = 5;

// Export for UI components to use consistent limit
export const MAX_RECENT_DISPLAY = MAX_RECENT;

/**
 * Get the list of recent folders.
 * @returns Array of folder paths, most recent first.
 */
export function getRecentFolders(): string[] {
  try {
    const stored = readMigratedStorage(STORAGE_KEY, 'control-zebra-recent-folders');
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Use the same recent-project list in the welcome page and top bar. */
export async function loadMergedRecentFolders(): Promise<string[]> {
  let backendFolders: string[] = [];
  try {
    backendFolders = (await GetRecentFolders()) || [];
  } catch {
    // Desktop bridge may be unavailable.
  }
  const folders = [...backendFolders, ...getRecentFolders()]
    .filter((folder) => typeof folder === 'string' && folder.length > 0);
  return [...new Set(folders)];
}

/**
 * Add a folder to the recent list.
 * Moves to top if already present, removes oldest if at max.
 * @param path - The folder path to add.
 */
export function addRecentFolder(path: string): void {
  if (!path) return;
  
  try {
    let recent = getRecentFolders();
    
    // Remove if already exists (will be re-added at top)
    recent = recent.filter(p => p !== path);
    
    // Add to front
    recent.unshift(path);
    
    // Limit to max
    if (recent.length > MAX_RECENT) {
      recent = recent.slice(0, MAX_RECENT);
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch (err) {
    console.error('Failed to save recent folder:', err);
  }
}

/**
 * Remove a folder from the recent list.
 * @param path - The folder path to remove.
 */
export function removeRecentFolder(path: string): void {
  if (!path) return;
  
  try {
    let recent = getRecentFolders();
    recent = recent.filter(p => p !== path);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch (err) {
    console.error('Failed to remove recent folder:', err);
  }
}

/**
 * Clear all recent folders.
 */
export function clearRecentFolders(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('control-zebra-recent-folders');
  } catch (err) {
    console.error('Failed to clear recent folders:', err);
  }
}

/**
 * Get a display name for a folder path.
 * Returns the last segment of the path.
 * @param path - The full folder path.
 * @returns The folder name.
 */
export function getFolderName(path: string): string {
  if (!path) return '';
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
