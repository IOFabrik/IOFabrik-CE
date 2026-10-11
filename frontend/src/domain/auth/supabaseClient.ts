/**
 * Supabase Auth Client for IOFabrik Desktop
 *
 * Thin wrapper around @supabase/supabase-js that:
 * 1. Initialises the client with project URL + publishable key from env vars when available.
 * 2. Disables built-in localStorage persistence (we use the Go keychain service instead).
 * 3. Exposes ergonomic helpers for sign-in, sign-out, session hydration, and refresh.
 *
 * Setup (matches the official Supabase React quickstart):
 *   https://supabase.com/docs/guides/auth/quickstarts/react
 *
 * Usage:
 *   import { signIn, signOut, getSession, refreshSession } from './supabaseClient';
 */

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

// ─── Configuration ──────────────────────────────────────────────────────────
// These values come from frontend/.env.local (see .env.example for the template).
// The publishable key (sb_publishable_xxx) replaces the legacy anon key.
// See: https://github.com/orgs/supabase/discussions/29260
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
const isConfigured = Boolean(supabaseUrl && supabaseKey);

let supabaseClient: SupabaseClient | null = null;

function getUnavailableError(): string {
  return 'Account sign-in is unavailable in this build. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY to enable it.';
}

function getSupabaseClient(): SupabaseClient | null {
  if (!isConfigured) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        // Disable built-in persistence — we manage tokens through the Go keychain service
        persistSession: false,
        // Disable auto-refresh — we control refresh explicitly so we can persist
        // the updated tokens back to the keychain
        autoRefreshToken: false,
        // No need to detect session from URL in a desktop app
        detectSessionInUrl: false,
      },
    });
  }

  return supabaseClient;
}

export function isSupabaseConfigured(): boolean {
  return isConfigured;
}

// ─── Client Initialisation ──────────────────────────────────────────────────
// We disable the default browser-storage persistence because tokens are stored
// securely via the Go backend (OS keychain). The frontend will explicitly
// hydrate the session on startup from the backend store.
export const supabase = getSupabaseClient();

// ─── Auth Result Types ──────────────────────────────────────────────────────

export interface AuthResult {
  success: boolean;
  session: Session | null;
  error: string | null;
}

// ─── Auth Helpers ───────────────────────────────────────────────────────────

/**
 * Sign in with email + password.
 * Returns the session on success so the caller can persist it via the backend.
 */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, session: null, error: getUnavailableError() };
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    return { success: false, session: null, error: error.message };
  }

  return { success: true, session: data.session, error: null };
}

/**
 * Sign out the current user.
 * The caller should also clear the backend keychain store after this call.
 */
export async function signOut(): Promise<{ success: boolean; error: string | null }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: true, error: null };
  }

  const { error } = await client.auth.signOut();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, error: null };
}

/**
 * Get the current in-memory session from the Supabase client.
 * Returns null if no session has been hydrated.
 */
export async function getSession(): Promise<Session | null> {
  const client = getSupabaseClient();
  if (!client) {
    return null;
  }

  const { data } = await client.auth.getSession();
  return data.session;
}

/**
 * Hydrate the Supabase client with a session loaded from the backend keychain.
 * Call this on app startup with the JSON string returned by `AuthService.LoadSession()`.
 *
 * Returns the refreshed session (Supabase will attempt token refresh if the
 * access token is expired but the refresh token is still valid).
 */
export async function hydrateSession(sessionJSON: string): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, session: null, error: getUnavailableError() };
  }

  if (!sessionJSON) {
    return { success: false, session: null, error: 'No stored session' };
  }

  let stored: Session;
  try {
    stored = JSON.parse(sessionJSON) as Session;
  } catch {
    return { success: false, session: null, error: 'Invalid session data' };
  }

  // setSession validates the tokens and refreshes if the access token is expired
  const { data, error } = await client.auth.setSession({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
  });

  if (error) {
    return { success: false, session: null, error: error.message };
  }

  return { success: true, session: data.session, error: null };
}

/**
 * Manually refresh the current session.
 * Useful before critical operations to ensure the token is still valid.
 * Returns the new session so the caller can persist it.
 */
export async function refreshSession(): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, session: null, error: getUnavailableError() };
  }

  const { data, error } = await client.auth.refreshSession();

  if (error) {
    return { success: false, session: null, error: error.message };
  }

  return { success: true, session: data.session, error: null };
}

/**
 * Serialise a session to JSON for backend storage.
 * Only stores the fields needed for rehydration (tokens + expiry).
 */
export function serialiseSession(session: Session): string {
  // Only persist the minimum fields needed for rehydration.
  // The full user object is re-fetched by supabase.auth.setSession().
  // Keeping the payload small avoids Windows Credential Manager size limits
  // (~2560 bytes) and avoids persisting PII unnecessarily.
  return JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type,
  });
}
