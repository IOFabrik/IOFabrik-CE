/**
 * PostHog Analytics Module for IOFabrik
 *
 * Provides centralized analytics tracking functions with consent-level filtering.
 * Event categories and consent behavior are documented below.
 * 
 * Event Categories:
 * - 'error': Error and crash events (tracked at all levels including minimal)
 * - 'usage': Core usage patterns like commits, syncs, branch operations (standard+)
 * - 'detailed': Granular UX events like navigation, file opens (full only)
 */

import posthog from 'posthog-js';

// Analytics consent levels
export type AnalyticsConsent = 'minimal' | 'standard' | 'full';

// Event categories determine which consent levels can track them
type EventCategory = 'error' | 'usage' | 'detailed';

// Get app version from environment
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev';

// Cache the current consent level for fast access
let currentConsentLevel: AnalyticsConsent = 'standard';

/**
 * Check if an event category is allowed at the current consent level
 */
function isEventAllowed(category: EventCategory): boolean {
  switch (currentConsentLevel) {
    case 'minimal':
      // Only error events are tracked at minimal level
      return category === 'error';
    case 'standard':
      // Error and usage events are tracked at standard level
      return category === 'error' || category === 'usage';
    case 'full':
      // All events are tracked at full level
      return true;
    default:
      return false;
  }
}

/**
 * Initialize analytics consent from localStorage
 */
export function initAnalytics(): void {
  const storedConsent = localStorage.getItem('analytics_consent') as AnalyticsConsent | null;
  if (storedConsent) {
    setAnalyticsConsent(storedConsent);
  } else {
    // Default to standard consent
    setAnalyticsConsent('standard');
  }
}

/**
 * Set analytics consent level
 * - minimal: errors only (stays opted in but filters events)
 * - standard: usage patterns (opt in, no recording)
 * - full: includes session replay (opt in with recording)
 */
export function setAnalyticsConsent(level: AnalyticsConsent): void {
  currentConsentLevel = level;
  const enableAutomaticCapture = level === 'full';
  
  // All levels stay opted in so we can track errors at minimum
  // The filtering happens in trackEvent based on category
  posthog.opt_in_capturing();

  // Keep PostHog SDK automatic behaviors aligned with consent level.
  // - minimal/standard: no automatic capture, pageview, or session replay
  // - full: allow automatic behaviors (with reduced background event noise)
  posthog.set_config({
    autocapture: enableAutomaticCapture,
    capture_pageview: enableAutomaticCapture,
    capture_pageleave: false,
    disable_session_recording: !enableAutomaticCapture,
    enable_heatmaps: false,
    rageclick: false,
    advanced_disable_feature_flags_on_first_load: true,
    rate_limiting: {
      events_per_second: 2,
      events_burst_limit: 20,
    },
  });
  
  switch (level) {
    case 'minimal':
    case 'standard':
      posthog.stopSessionRecording?.();
      break;
    case 'full':
      posthog.startSessionRecording?.();
      break;
  }

  localStorage.setItem('analytics_consent', level);
}

/**
 * Get current analytics consent level
 */
export function getAnalyticsConsent(): AnalyticsConsent {
  return (localStorage.getItem('analytics_consent') as AnalyticsConsent) || 'standard';
}

/**
 * Track an event with consent-level filtering
 * @param eventName - The name of the event
 * @param properties - Optional event properties
 * @param category - Event category: 'error' (minimal+), 'usage' (standard+), 'detailed' (full only)
 */
function trackEvent(
  eventName: string, 
  properties?: Record<string, unknown>,
  category: EventCategory = 'usage'
): void {
  // Check if this event category is allowed at current consent level
  if (!isEventAllowed(category)) {
    return;
  }

  posthog.capture(eventName, {
    ...properties,
    timestamp: new Date().toISOString(),
    app_version: APP_VERSION,
    consent_level: currentConsentLevel,
    event_category: category,
  });
}

// ============================================================================
// Event-specific tracking functions
// ============================================================================

// --- App Lifecycle Events ---

export function trackAppLaunched(properties: {
  platform: string;
  isFirstLaunch: boolean;
}): void {
  trackEvent('app_launched', {
    platform: properties.platform,
    is_first_launch: properties.isFirstLaunch,
  }, 'usage');
}

export function trackAppClosed(properties: {
  sessionDurationSeconds: number;
  reposOpened: number;
}): void {
  trackEvent('app_closed', {
    session_duration_seconds: properties.sessionDurationSeconds,
    repos_opened: properties.reposOpened,
  }, 'usage');
}

// --- Repository Events ---

export function trackRepoOpened(properties: {
  isGitRepo: boolean;
  hasRemote: boolean | null;
  branchName: string;
  filesCount?: number;
}): void {
  trackEvent('repo_opened', {
    is_git_repo: properties.isGitRepo,
    has_remote: properties.hasRemote,
    has_remote_detected: properties.hasRemote !== null,
    branch_name: properties.branchName,
    files_count: properties.filesCount,
  }, 'usage');
}

export function trackRepoClosed(properties: { sessionDurationSeconds: number }): void {
  trackEvent('repo_closed', {
    session_duration_seconds: properties.sessionDurationSeconds,
  }, 'usage');
}

export function trackRepoInitialized(properties: {
  lfsEnabled: boolean;
  initialCommitMade: boolean;
}): void {
  trackEvent('repo_initialized', {
    lfs_enabled: properties.lfsEnabled,
    initial_commit_made: properties.initialCommitMade,
  }, 'usage');
}

// --- Commit Events ---

export function trackCommitCreated(properties: {
  success: boolean;
  filesChanged: number;
  branchName: string;
  messageLength: number;
  isProtectedBranch: boolean;
  durationMs?: number;
  errorType?: string;
}): void {
  trackEvent('commit_created', {
    success: properties.success,
    files_changed: properties.filesChanged,
    branch_name: properties.branchName,
    message_length: properties.messageLength,
    is_protected_branch: properties.isProtectedBranch,
    duration_ms: properties.durationMs,
    error_type: properties.errorType,
  }, 'usage');
}

export function trackCommitBranchAndSave(properties: {
  newBranchName: string;
  filesChanged: number;
  wasOnProtectedBranch: boolean;
}): void {
  trackEvent('commit_branch_and_save', {
    new_branch_name: properties.newBranchName,
    files_changed: properties.filesChanged,
    was_on_protected_branch: properties.wasOnProtectedBranch,
  }, 'usage');
}

export function trackCommitUndone(properties: { commitsResetCount: number }): void {
  trackEvent('commit_undone', {
    commits_reset_count: properties.commitsResetCount,
  }, 'usage');
}

export function trackChangesDiscarded(properties: {
  filesDiscarded: number;
  wasPartial: boolean;
}): void {
  trackEvent('changes_discarded', {
    files_discarded: properties.filesDiscarded,
    was_partial: properties.wasPartial,
  }, 'usage');
}

// --- Sync Events ---

export function trackSyncStarted(properties: {
  branchName: string;
  localAhead: number;
  localBehind: number;
}): void {
  trackEvent('sync_started', {
    branch_name: properties.branchName,
    local_ahead: properties.localAhead,
    local_behind: properties.localBehind,
  }, 'usage');
}

export function trackSyncCompleted(properties: {
  success: boolean;
  durationMs: number;
  commitsPulled?: number;
  commitsPushed?: number;
}): void {
  trackEvent('sync_completed', {
    success: properties.success,
    duration_ms: properties.durationMs,
    commits_pulled: properties.commitsPulled,
    commits_pushed: properties.commitsPushed,
  }, 'usage');
}

export function trackSyncFailed(properties: {
  errorType: string;
  hadConflicts: boolean;
}): void {
  trackEvent('sync_failed', {
    error_type: properties.errorType,
    had_conflicts: properties.hadConflicts,
  }, 'error');
}

// --- Branch Events ---

export function trackBranchSwitched(properties: {
  fromBranch: string;
  toBranch: string;
  usedStash: boolean;
}): void {
  trackEvent('branch_switched', {
    from_branch: properties.fromBranch,
    to_branch: properties.toBranch,
    used_stash: properties.usedStash,
  }, 'usage');
}

export function trackBranchCreated(properties: {
  branchName: string;
  fromBranch: string;
  movedUncommittedChanges: boolean;
}): void {
  trackEvent('branch_created', {
    branch_name: properties.branchName,
    from_branch: properties.fromBranch,
    moved_uncommitted_changes: properties.movedUncommittedChanges,
  }, 'usage');
}

// --- Merge/Conflict Events ---

export function trackConflictDetected(properties: {
  conflictedFilesCount: number;
  conflictSource: 'merge' | 'pull';
}): void {
  trackEvent('conflict_detected', {
    conflicted_files_count: properties.conflictedFilesCount,
    conflict_source: properties.conflictSource,
  }, 'usage');
}

export function trackConflictResolved(properties: {
  resolutionStrategy: 'ours' | 'theirs' | 'both' | 'manual';
}): void {
  trackEvent('conflict_resolved', {
    resolution_strategy: properties.resolutionStrategy,
  }, 'usage');
}

export function trackMergeCompleted(properties: {
  totalConflicts: number;
  resolutionStrategiesUsed: string[];
}): void {
  trackEvent('merge_completed', {
    total_conflicts: properties.totalConflicts,
    resolution_strategies_used: properties.resolutionStrategiesUsed,
  }, 'usage');
}

export function trackMergeAborted(properties: { conflictsRemaining: number }): void {
  trackEvent('merge_aborted', {
    conflicts_remaining: properties.conflictsRemaining,
  }, 'usage');
}

// --- Navigation Events ---

export function trackViewChanged(properties: {
  fromView: string;
  toView: string;
}): void {
  trackEvent('view_changed', {
    from_view: properties.fromView,
    to_view: properties.toView,
  }, 'detailed');
}

export function trackSettingsOpened(properties: { category?: string }): void {
  trackEvent('settings_opened', {
    category: properties.category,
  }, 'detailed');
}

// --- Error & Recovery Events ---

export function trackErrorShown(properties: {
  errorCode?: string;
  errorContext: string;
  actionAttempted: string;
}): void {
  trackEvent('error_shown', {
    error_code: properties.errorCode,
    error_context: properties.errorContext,
    action_attempted: properties.actionAttempted,
  }, 'error');
}

// --- Project Setup Events (Phase 13.2) ---

/**
 * Track when project setup begins.
 * Fires when user clicks "Enable Version Control" or initiates project creation.
 */
export function trackProjectSetupStarted(properties: {
  projectState: string;
  source: 'status_bar_nudge' | 'setup_banner' | 'new_project_page' | 'welcome_screen';
  hasFiles: boolean;
}): void {
  trackEvent('project_setup_started', {
    project_state: properties.projectState,
    source: properties.source,
    has_files: properties.hasFiles,
  }, 'usage');
}

/**
 * Track when project setup completes successfully (git init + initial commit).
 */
export function trackProjectSetupCompleted(properties: {
  projectState: string;
  lfsEnabled: boolean;
  initialCommitMade: boolean;
  durationMs: number;
}): void {
  trackEvent('project_setup_completed', {
    project_state: properties.projectState,
    lfs_enabled: properties.lfsEnabled,
    initial_commit_made: properties.initialCommitMade,
    duration_ms: properties.durationMs,
  }, 'usage');
}

/**
 * Track when user attempts to publish a local repo to GitHub.
 */
export function trackProjectPublishAttempted(properties: {
  repoName: string;
  isPrivate: boolean;
  hasOrganization: boolean;
  source: 'setup_banner' | 'new_project_page' | 'welcome_screen';
}): void {
  trackEvent('project_publish_attempted', {
    repo_name: properties.repoName,
    is_private: properties.isPrivate,
    has_organization: properties.hasOrganization,
    source: properties.source,
  }, 'usage');
}

/**
 * Track when GitHub publish fails.
 */
export function trackProjectPublishFailed(properties: {
  errorType: string;
  repoName: string;
}): void {
  trackEvent('project_publish_failed', {
    error_type: properties.errorType,
    repo_name: properties.repoName,
  }, 'error');
}

/**
 * Track when GitHub publish succeeds.
 */
export function trackProjectPublishCompleted(properties: {
  repoName: string;
  isPrivate: boolean;
  durationMs: number;
}): void {
  trackEvent('project_publish_completed', {
    repo_name: properties.repoName,
    is_private: properties.isPrivate,
    duration_ms: properties.durationMs,
  }, 'usage');
}
