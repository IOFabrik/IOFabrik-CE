/** Read an old preference once, retaining it if browser storage is unavailable. */
export function readMigratedStorage(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    try {
      localStorage.setItem(key, legacy);
      localStorage.removeItem(legacyKey);
    } catch {
      // The caller can still use the legacy value without losing it.
    }
  }
  return legacy;
}
