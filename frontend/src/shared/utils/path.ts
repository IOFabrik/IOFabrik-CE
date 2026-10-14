/**
 * Path utilities for IOFabrik frontend.
 *
 * Helpers for deriving repo names from folder paths,
 * normalising paths across platforms, etc.
 */

/**
 * Suggest a GitHub-compatible repository name from a folder path.
 *
 * Rules applied:
 *  - Extracts the last path segment (folder name).
 *  - Lowercases the result.
 *  - Replaces spaces and non-allowed characters with hyphens.
 *  - Collapses consecutive hyphens and trims leading/trailing hyphens.
 *  - Truncates to GitHub's 100-character limit.
 *
 * @example
 *   suggestRepoName('/Users/me/My Cool Project') // → 'my-cool-project'
 *   suggestRepoName('C:\\Users\\me\\PLC_Configs')  // → 'plc_configs'
 */
export function suggestRepoName(folderPath: string): string {
  // Handle both Unix and Windows paths
  const normalized = folderPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const folderName = segments[segments.length - 1] || '';

  // Sanitize: lowercase, replace spaces/special chars with hyphens
  return folderName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100); // GitHub max
}

/**
 * Extract the folder name (last segment) from an absolute path.
 * Works with both Unix and Windows-style separators.
 */
export function getFolderNameFromPath(folderPath: string): string {
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || folderPath;
}
