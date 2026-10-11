import { describe, expect, it, vi } from 'vitest';

import {
  buildStartupReferencePayload,
  createStartupFailureReference,
  formatStartupIssue,
  installStartupGuard,
  resolveDiagnosticsPath,
} from './startupGuard';

function installTestMarkup(): void {
  document.body.innerHTML = `
    <div id="root"></div>
    <div id="startup-recovery-shell" data-visible="false"></div>
    <div id="startup-footer-text"></div>
    <div id="startup-reference-text"></div>
    <div id="startup-status-panel" hidden data-state="idle"></div>
    <div id="startup-status-text"></div>
    <details id="startup-technical-details"></details>
    <pre id="startup-technical-details-body"></pre>
    <button id="startup-restart-button" type="button"></button>
    <button id="startup-diagnostics-button" type="button"></button>
    <button id="startup-copy-reference-button" type="button"></button>
  `;
}

describe('startupGuard helpers', () => {
  it('creates a stable startup reference format', () => {
    const reference = createStartupFailureReference(new Date('2026-03-29T10:11:12.345Z'), 0.123456789);
    expect(reference).toBe('IOFABRIK-STARTUP-2026-03-29T10-11-12-345Z-4FZZZX');
  });

  it('formats issues and builds a support payload', () => {
    const issue = formatStartupIssue('[mount-timeout]', 'Shell never became ready.', new Date('2026-03-29T10:11:12.345Z'));
    expect(issue).toContain('2026-03-29T10:11:12.345Z [mount-timeout]');

    const payload = buildStartupReferencePayload('IOFABRIK-STARTUP-REF', [issue]);
    expect(payload).toContain('Reference: IOFABRIK-STARTUP-REF');
    expect(payload).toContain('Shell never became ready.');
  });

  it('prefers logs for diagnostics path resolution', () => {
    expect(resolveDiagnosticsPath({ logsDir: '/logs', localDataDir: '/local', roamingConfigDir: '/roaming' })).toBe('/logs');
    expect(resolveDiagnosticsPath({ logsDir: '', localDataDir: '/local', roamingConfigDir: '/roaming' })).toBe('/local');
    expect(resolveDiagnosticsPath({ logsDir: '', localDataDir: '', roamingConfigDir: '/roaming' })).toBe('/roaming');
  });
});

describe('installStartupGuard', () => {
  it('shows the recovery shell after timeout when the app is still not ready', () => {
    vi.useFakeTimers();
    installTestMarkup();

    const logger = { error: vi.fn() };
    const guard = installStartupGuard({
      document,
      window,
      startupTimeoutMs: 50,
      isDev: false,
      now: () => new Date('2026-03-29T10:11:12.345Z'),
      random: () => 0.123456789,
      logger,
    });

    vi.advanceTimersByTime(50);

    expect(document.getElementById('startup-recovery-shell')?.getAttribute('data-visible')).toBe('true');
    expect(document.getElementById('startup-technical-details-body')?.textContent).toContain('[mount-timeout]');
    expect(logger.error).toHaveBeenCalled();

    guard.cleanup();
    vi.useRealTimers();
  });

  it('hides the shell after the app-ready event', () => {
    installTestMarkup();

    const guard = installStartupGuard({
      document,
      window,
      startupTimeoutMs: 5000,
      isDev: false,
      now: () => new Date('2026-03-29T10:11:12.345Z'),
      random: () => 0.123456789,
      logger: { error: vi.fn() },
    });

    guard.showStartupFailure('[onerror]', 'Test startup failure');
    expect(document.getElementById('startup-recovery-shell')?.getAttribute('data-visible')).toBe('true');

    document.documentElement.dataset.czAppReady = 'true';
    window.dispatchEvent(new CustomEvent('iofabrik:app-shell-ready'));

    expect(document.getElementById('startup-recovery-shell')?.getAttribute('data-visible')).toBe('false');

    guard.cleanup();
    delete document.documentElement.dataset.czAppReady;
  });
});