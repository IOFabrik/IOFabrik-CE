import type { DataLocations, OpenFileResult } from '../../../bindings/iofabrik/services/models';

type SettingsServiceModule = typeof import('../../../bindings/iofabrik/services/settingsservice');
type FileSystemServiceModule = typeof import('../../../bindings/iofabrik/services/filesystemservice');

export interface StartupGuardElements {
  recoveryShell: HTMLElement | null;
  footerText: HTMLElement | null;
  referenceText: HTMLElement | null;
  statusPanel: HTMLElement | null;
  statusText: HTMLElement | null;
  technicalDetails: HTMLDetailsElement | null;
  technicalDetailsBody: HTMLElement | null;
  restartButton: HTMLButtonElement | null;
  diagnosticsButton: HTMLButtonElement | null;
  copyReferenceButton: HTMLButtonElement | null;
}

export interface StartupGuardDependencies {
  document?: Document;
  window?: Window;
  isDev?: boolean;
  previewFailure?: boolean;
  startupTimeoutMs?: number;
  now?: () => Date;
  random?: () => number;
  importSettingsService?: () => Promise<SettingsServiceModule>;
  importFileSystemService?: () => Promise<FileSystemServiceModule>;
  logger?: Pick<Console, 'error'>;
}

export interface StartupGuardHandle {
  failureReference: string;
  cleanup: () => void;
  getIssues: () => string[];
  showStartupFailure: (prefix: string, detail: string) => void;
  openDiagnostics: () => Promise<void>;
  copyReference: () => Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 5000;

export function createStartupFailureReference(
  now: Date = new Date(),
  randomValue: number = Math.random(),
): string {
  return `IOFABRIK-STARTUP-${now.toISOString().replace(/[:.]/g, '-')}-${randomValue
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}`;
}

export function formatStartupIssue(prefix: string, detail: string, now: Date = new Date()): string {
  return `${now.toISOString()} ${prefix}\n${detail}`;
}

export function buildStartupReferencePayload(reference: string, issues: string[]): string {
  return [
    `Reference: ${reference}`,
    'Issue: IOFabrik startup recovery',
    '',
    issues.length > 0 ? issues.join('\n\n') : 'No technical details captured.',
  ].join('\n');
}

export function resolveDiagnosticsPath(
  locations: Pick<DataLocations, 'logsDir' | 'localDataDir' | 'roamingConfigDir'>,
): string {
  return locations.logsDir || locations.localDataDir || locations.roamingConfigDir || '';
}

export function getStartupGuardElements(document: Document): StartupGuardElements {
  return {
    recoveryShell: document.getElementById('startup-recovery-shell'),
    footerText: document.getElementById('startup-footer-text'),
    referenceText: document.getElementById('startup-reference-text'),
    statusPanel: document.getElementById('startup-status-panel'),
    statusText: document.getElementById('startup-status-text'),
    technicalDetails: document.getElementById('startup-technical-details') as HTMLDetailsElement | null,
    technicalDetailsBody: document.getElementById('startup-technical-details-body'),
    restartButton: document.getElementById('startup-restart-button') as HTMLButtonElement | null,
    diagnosticsButton: document.getElementById('startup-diagnostics-button') as HTMLButtonElement | null,
    copyReferenceButton: document.getElementById('startup-copy-reference-button') as HTMLButtonElement | null,
  };
}

function isAppReady(document: Document): boolean {
  return document.documentElement.dataset.czAppReady === 'true';
}

function setShellVisible(elements: StartupGuardElements, isVisible: boolean): void {
  elements.recoveryShell?.setAttribute('data-visible', isVisible ? 'true' : 'false');
}

function setStatus(elements: StartupGuardElements, message: string, state: 'idle' | 'error' = 'idle'): void {
  if (!elements.statusPanel || !elements.statusText) {
    return;
  }

  if (!message) {
    elements.statusPanel.hidden = true;
    elements.statusPanel.dataset.state = 'idle';
    elements.statusText.textContent = '';
    return;
  }

  elements.statusPanel.hidden = false;
  elements.statusPanel.dataset.state = state;
  elements.statusText.textContent = message;
}

function renderIssues(elements: StartupGuardElements, issues: string[]): void {
  if (elements.technicalDetailsBody) {
    elements.technicalDetailsBody.textContent = issues.join('\n\n');
  }
}

function getActionErrorMessage(action: 'diagnostics' | 'reference-copy'): string {
  if (action === 'diagnostics') {
    return 'IOFabrik could not open diagnostics automatically.';
  }

  return 'IOFabrik could not copy the reference.';
}

async function tryOpenDiagnosticsPath(
  fileSystemService: FileSystemServiceModule,
  diagnosticsPath: string,
): Promise<OpenFileResult> {
  let result = await fileSystemService.RevealInFinder(diagnosticsPath);
  if (!result.success) {
    result = await fileSystemService.OpenFile(diagnosticsPath);
  }

  return result;
}

export function installStartupGuard(dependencies: StartupGuardDependencies = {}): StartupGuardHandle {
  const documentRef = dependencies.document ?? document;
  const windowRef = dependencies.window ?? window;
  const isDev = dependencies.isDev ?? import.meta.env.DEV;
  const previewFailure = dependencies.previewFailure ?? import.meta.env.VITE_IOFABRIK_STARTUP_ERROR_PREVIEW === '1';
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const logger = dependencies.logger ?? console;
  const importSettingsService =
    dependencies.importSettingsService ??
    (() => import('../../../bindings/iofabrik/services/settingsservice'));
  const importFileSystemService =
    dependencies.importFileSystemService ??
    (() => import('../../../bindings/iofabrik/services/filesystemservice'));

  const elements = getStartupGuardElements(documentRef);
  const issues: string[] = [];
  const failureReference = createStartupFailureReference(now(), random());

  if (elements.referenceText) {
    elements.referenceText.textContent = failureReference;
  }

  const hideRecoveryShell = () => {
    setShellVisible(elements, false);
  };

  const showStartupFailure = (prefix: string, detail: string) => {
    const issueText = formatStartupIssue(prefix, detail, now());
    issues.push(issueText);
    renderIssues(elements, issues);

    if (isDev && elements.technicalDetails) {
      elements.technicalDetails.open = true;
    }

    if (elements.footerText) {
      elements.footerText.textContent = 'If this keeps happening, share this reference';
    }

    setStatus(elements, '');
    setShellVisible(elements, true);
    logger.error(prefix, detail);
  };

  const openDiagnostics = async () => {
    setStatus(elements, 'Opening diagnostics…');

    try {
      const [{ GetDataLocations }, fileSystemService] = await Promise.all([
        importSettingsService(),
        importFileSystemService(),
      ]);

      const diagnosticsPath = resolveDiagnosticsPath(await GetDataLocations());
      if (!diagnosticsPath) {
        throw new Error('No diagnostics location is available yet.');
      }

      const result = await tryOpenDiagnosticsPath(fileSystemService, diagnosticsPath);
      if (!result.success) {
        throw new Error(result.error || 'IOFabrik could not open diagnostics automatically.');
      }

      setStatus(elements, 'Diagnostics opened.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push(formatStartupIssue('[diagnostics-action]', detail, now()));
      renderIssues(elements, issues);
      setStatus(elements, getActionErrorMessage('diagnostics'), 'error');
    }
  };

  const copyReference = async () => {
    const payload = buildStartupReferencePayload(failureReference, issues);

    try {
      const fileSystemService = await importFileSystemService();
      const result = await fileSystemService.CopyToClipboard(payload);
      if (!result.success) {
        throw new Error(result.error || getActionErrorMessage('reference-copy'));
      }

      setStatus(elements, 'Reference copied.');
      return;
    } catch {
      try {
        await windowRef.navigator.clipboard.writeText(payload);
        setStatus(elements, 'Reference copied.');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        issues.push(formatStartupIssue('[copy-reference-action]', detail, now()));
        renderIssues(elements, issues);
        setStatus(elements, getActionErrorMessage('reference-copy'), 'error');
      }
    }
  };

  const handleReady = () => {
    if (previewFailure) {
      return;
    }

    hideRecoveryShell();
  };

  const handleWindowError = (
    event: Event | string,
    source?: string,
    line?: number,
    column?: number,
    error?: Error,
  ) => {
    if (typeof event === 'string') {
      showStartupFailure(
        '[onerror]',
        `${event}\nSource: ${source}:${line}:${column}${error?.stack ? `\n${error.stack}` : ''}`,
      );
      return;
    }

    const errorEvent = event as ErrorEvent;
    showStartupFailure(
      '[onerror]',
      `${errorEvent.message}\nSource: ${errorEvent.filename}:${errorEvent.lineno}:${errorEvent.colno}${errorEvent.error?.stack ? `\n${errorEvent.error.stack}` : ''}`,
    );
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    showStartupFailure(
      '[unhandledrejection]',
      reason ? reason.stack || reason.message || String(reason) : String(event),
    );
  };

  const timeoutId = windowRef.setTimeout(() => {
    const root = documentRef.getElementById('root');
    if (isAppReady(documentRef)) {
      return;
    }

    if (root && root.children.length === 0) {
      showStartupFailure(
        '[mount-timeout]',
        'IOFabrik did not finish opening before the startup timeout. The app shell never became ready.',
      );
    }
  }, startupTimeoutMs);

  elements.restartButton?.addEventListener('click', () => {
    windowRef.location.reload();
  });
  elements.diagnosticsButton?.addEventListener('click', () => {
    void openDiagnostics();
  });
  elements.copyReferenceButton?.addEventListener('click', () => {
    void copyReference();
  });

  windowRef.addEventListener('iofabrik:app-shell-ready', handleReady, { once: true });
  windowRef.addEventListener('error', handleWindowError as EventListener);
  windowRef.addEventListener('unhandledrejection', handleUnhandledRejection as EventListener);

  if (previewFailure) {
    showStartupFailure(
      '[preview]',
      'Simulated startup recovery screen. Disable VITE_IOFABRIK_STARTUP_ERROR_PREVIEW to return to the normal app.',
    );
  }

  return {
    failureReference,
    cleanup: () => {
      windowRef.clearTimeout(timeoutId);
      windowRef.removeEventListener('iofabrik:app-shell-ready', handleReady as EventListener);
      windowRef.removeEventListener('error', handleWindowError as EventListener);
      windowRef.removeEventListener('unhandledrejection', handleUnhandledRejection as EventListener);
    },
    getIssues: () => [...issues],
    showStartupFailure,
    openDiagnostics,
    copyReference,
  };
}